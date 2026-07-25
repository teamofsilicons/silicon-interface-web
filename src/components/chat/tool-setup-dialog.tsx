"use client";

import * as React from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Plug,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react/dist/ssr";

import { api, ApiError } from "@/lib/api";
import {
  initialToolSetupFieldValues,
  parseToolSetupAssignment,
  safeToolSetupConnectUrl,
  serializeToolSetupFields,
  TOOL_SETUP_STATE_EVENT,
  toolSetupCanCancel,
  toolSetupCanStart,
  toolSetupFields,
  toolSetupSchemaIssue,
  type ToolSetupAssignment,
  type ToolSetupField,
  type ToolSetupFieldValues,
} from "@/lib/tool-setup";
import type { ToolSetupRequestMessage } from "@/lib/tool-setup-request";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 90;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) {
      return "The connection details were rejected. Check the fields and try again.";
    }
    if (error.status === 401) return "Sign in again to complete this setup request.";
    if (error.status === 403 || error.status === 404) {
      return "This setup request is not assigned to your account.";
    }
    if (error.status === 409) {
      return "This setup request can no longer be completed in its current state.";
    }
    if (error.status >= 500) {
      return "The setup provider is unavailable right now. Please try again.";
    }
    return "Setup could not be completed. Please try again.";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error && error.message
    ? error.message
    : "Setup could not be loaded. Please try again.";
}

function prettyStatus(status: ToolSetupAssignment["status"]): string {
  return status.replace(/_/g, " ");
}

function formatExpiry(value: string | null): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function statusTone(status: ToolSetupAssignment["status"]): string {
  if (status === "completed") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "failed" || status === "expired") {
    return "border-destructive/35 bg-destructive/10 text-destructive";
  }
  if (status === "cancelled") return "border-border bg-muted text-muted-foreground";
  return "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300";
}

function connectionScopeNotice(
  assignment: ToolSetupAssignment,
  teamLabel: string,
): string {
  if (assignment.requested_scope === "team") {
    return (
      `Choose an account intended for shared use. Silicons in ${teamLabel} ` +
      "can use the connected account’s data and actions when this tool runs."
    );
  }
  if (assignment.requested_scope === "silicon") {
    return (
      "This connection is dedicated to the requesting Silicon. That Silicon " +
      "can use the connected account’s data and actions."
    );
  }
  return (
    "This connection belongs to your Carbon account. A Silicon can use it " +
    "only when acting for you in an authorized conversation."
  );
}

function ToolSetupStatusIcon({
  status,
}: {
  status: ToolSetupAssignment["status"];
}) {
  if (status === "completed") return <CheckCircle className="h-4 w-4" weight="fill" />;
  if (status === "cancelled") return <XCircle className="h-4 w-4" />;
  if (status === "failed" || status === "expired") {
    return <WarningCircle className="h-4 w-4" weight="fill" />;
  }
  return <CircleNotch className={cn("h-4 w-4", status === "in_progress" && "animate-spin")} />;
}

function SchemaField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ToolSetupField;
  value: string | boolean;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `tool-setup-${field.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const descriptionId = field.description ? `${id}-description` : undefined;
  if (field.kind === "boolean") {
    return (
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          required={field.required}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-describedby={descriptionId}
          className="mt-0.5 h-4 w-4 accent-foreground"
        />
        <div className="space-y-1">
          <Label htmlFor={id}>{field.label}</Label>
          {field.description && (
            <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
              {field.description}
            </p>
          )}
        </div>
      </div>
    );
  }

  const label = (
    <Label htmlFor={id}>
      {field.label}
      {field.required ? <span aria-hidden="true"> *</span> : null}
    </Label>
  );
  const description = field.description ? (
    <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
      {field.description}
    </p>
  ) : null;

  // Secret fields always use a masked native input. Unsupported secret
  // complex/enum schemas are rejected before this renderer is reached.
  if (field.options.length && !field.secret) {
    return (
      <div className="space-y-1.5">
        {label}
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          required={field.required}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-describedby={descriptionId}
          className="flex h-11 w-full rounded-md border border-input bg-background px-3.5 py-2 text-sm"
        >
          <option value="">Select…</option>
          {field.options.map((option) => (
            <option key={option.token} value={option.token}>{option.label}</option>
          ))}
        </select>
        {description}
      </div>
    );
  }

  const inputType = field.secret
    ? "password"
    : field.kind === "number" || field.kind === "integer"
      ? "number"
      : field.format === "uri"
        ? "url"
        : field.format === "email"
          ? "email"
          : "text";
  return (
    <div className="space-y-1.5">
      {label}
      <Input
        id={id}
        type={inputType}
        value={typeof value === "string" ? value : ""}
        required={field.required}
        disabled={disabled}
        min={field.minimum}
        max={field.maximum}
        minLength={field.minLength}
        maxLength={field.maxLength}
        step={field.kind === "integer" ? 1 : inputType === "number" ? "any" : undefined}
        autoComplete={field.secret ? "new-password" : "off"}
        spellCheck={field.secret ? false : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-describedby={descriptionId}
        className={field.secret || field.format === "uri" ? "font-mono" : undefined}
      />
      {description}
    </div>
  );
}

export function ToolSetupDialog({
  open,
  onOpenChange,
  requestId,
  summary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  summary?: ToolSetupRequestMessage | null;
}) {
  const [assignment, setAssignment] = React.useState<ToolSetupAssignment | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [connectUrl, setConnectUrl] = React.useState("");
  const [fields, setFields] = React.useState<ToolSetupField[]>([]);
  const [schemaIssue, setSchemaIssue] = React.useState("");
  const [fieldValues, setFieldValues] = React.useState<ToolSetupFieldValues>({});
  const pollAttemptsRef = React.useRef(0);

  const acceptResponse = React.useCallback((value: unknown): ToolSetupAssignment => {
    const parsed = parseToolSetupAssignment(value, requestId);
    if (!parsed) throw new Error("The setup response did not match this request.");
    setAssignment(parsed);
    window.dispatchEvent(
      new CustomEvent(TOOL_SETUP_STATE_EVENT, { detail: parsed }),
    );
    const nextFields = toolSetupFields(parsed.completion_schema);
    setFields(nextFields);
    setSchemaIssue(toolSetupSchemaIssue(parsed.completion_schema) ?? "");
    if (["completed", "cancelled", "expired"].includes(parsed.status)) {
      setFieldValues({});
      setConnectUrl("");
      return parsed;
    }
    setFieldValues((current) => {
      if (Object.keys(current).length) return current;
      return initialToolSetupFieldValues(nextFields);
    });
    return parsed;
  }, [requestId]);

  const refresh = React.useCallback(async (
    signal?: AbortSignal,
    quiet = false,
  ): Promise<ToolSetupAssignment | null> => {
    if (!quiet) setLoading(true);
    try {
      const payload = await api.toolSetupRequest(requestId, signal);
      const parsed = acceptResponse(payload.request);
      setError("");
      return parsed;
    } catch (refreshError) {
      if (!signal?.aborted) setError(errorMessage(refreshError));
      return null;
    } finally {
      if (!quiet && !signal?.aborted) setLoading(false);
    }
  }, [acceptResponse, requestId]);

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setAssignment(null);
      setFields([]);
      setSchemaIssue("");
      setFieldValues({});
      setConnectUrl("");
      setError("");
      setBusy(false);
      pollAttemptsRef.current = 0;
      void refresh(controller.signal);
    });
    return () => controller.abort();
  }, [open, refresh]);

  React.useEffect(() => {
    if (open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setFieldValues({});
      setConnectUrl("");
      setSchemaIssue("");
      setError("");
    });
    return () => {
      active = false;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onState = (event: Event) => {
      const custom = event as CustomEvent<unknown>;
      const next = parseToolSetupAssignment(custom.detail, requestId);
      if (!next) return;
      setAssignment(next);
      if (["completed", "cancelled", "expired"].includes(next.status)) {
        setFieldValues({});
        setConnectUrl("");
      }
      setError("");
    };
    window.addEventListener(TOOL_SETUP_STATE_EVENT, onState);
    return () => window.removeEventListener(TOOL_SETUP_STATE_EVENT, onState);
  }, [open, requestId]);

  React.useEffect(() => {
    if (!open || assignment?.status !== "in_progress") return;
    let stopped = false;
    let timer = 0;
    let controller: AbortController | null = null;

    const poll = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
        setError("The provider is still waiting. Refresh the status when the connection is complete.");
        return;
      }
      pollAttemptsRef.current += 1;
      controller = new AbortController();
      const next = await refresh(controller.signal, true);
      if (!stopped && next?.status === "in_progress") {
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);

    const resume = () => {
      if (
        document.visibilityState === "visible"
        && !stopped
        && assignment.status === "in_progress"
      ) {
        window.clearTimeout(timer);
        timer = window.setTimeout(poll, 0);
      }
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [assignment?.status, open, refresh]);

  const beginSetup = React.useCallback(async (
    submittedFields?: Record<string, unknown>,
    options: { restart?: boolean } = {},
  ) => {
    const restarting = options.restart === true
      && assignment?.status === "in_progress"
      && assignment.completion_kind === "redirect";
    if (
      !assignment
      || busy
      || (!toolSetupCanStart(assignment) && !restarting)
    ) {
      return;
    }
    let popup: Window | null = null;
    if (assignment.completion_kind === "redirect") {
      try {
        popup = window.open(
          "about:blank",
          `tool-setup-${requestId}`,
          "popup,width=620,height=760",
        );
        if (popup) popup.opener = null;
      } catch {
        popup = null;
      }
    }

    setBusy(true);
    setError("");
    setConnectUrl("");
    if (submittedFields) {
      const secretKeys = new Set(fields.filter((field) => field.secret).map((field) => field.key));
      setFieldValues((current) => {
        const cleared = { ...current };
        for (const key of secretKeys) cleared[key] = "";
        return cleared;
      });
    }

    try {
      const payload = await api.startToolSetupRequest(
        requestId,
        {
          ...(submittedFields ? { fields: submittedFields } : {}),
          ...(restarting ? { restart: true as const } : {}),
        },
      );
      const next = acceptResponse(payload.request);
      const rawConnectUrl = payload.connect_url;
      const safeConnectUrl = safeToolSetupConnectUrl(rawConnectUrl);
      if (typeof rawConnectUrl === "string" && rawConnectUrl && !safeConnectUrl) {
        throw new Error("The provider returned an unsafe connection address.");
      }
      // Retain only the already-validated provider URL in component memory. If
      // the popup is closed or lost, the Carbon can reopen the same pending
      // connection without cancelling the Silicon's request.
      if (safeConnectUrl) setConnectUrl(safeConnectUrl);
      if (safeConnectUrl && popup && !popup.closed) {
        popup.location.replace(safeConnectUrl);
      } else {
        if (popup && !popup.closed) popup.close();
      }
      if (next.status === "in_progress") pollAttemptsRef.current = 0;
    } catch (startError) {
      if (popup && !popup.closed) popup.close();
      setError(errorMessage(startError));
    } finally {
      setBusy(false);
    }
  }, [acceptResponse, assignment, busy, fields, requestId]);

  const submitForm = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    const serialized = serializeToolSetupFields(fields, fieldValues);
    if ("error" in serialized) {
      setError(serialized.error);
      return;
    }
    void beginSetup(serialized.fields);
  }, [beginSetup, fieldValues, fields]);

  const cancelRequest = React.useCallback(async () => {
    if (
      !assignment
      || busy
      || !toolSetupCanCancel(assignment)
      || !window.confirm("Cancel this setup request?")
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = await api.cancelToolSetupRequest(requestId);
      acceptResponse(payload.request);
      setConnectUrl("");
      setFieldValues({});
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    } finally {
      setBusy(false);
    }
  }, [acceptResponse, assignment, busy, requestId]);

  const openProvider = React.useCallback(() => {
    const safeUrl = safeToolSetupConnectUrl(connectUrl);
    if (safeUrl) window.open(safeUrl, "_blank", "noopener,noreferrer");
  }, [connectUrl]);

  const restartProvider = React.useCallback(() => {
    if (
      assignment?.status !== "in_progress"
      || assignment.completion_kind !== "redirect"
      || busy
      || !window.confirm(
        "Restart this account connection? The unfinished provider attempt will be discarded.",
      )
    ) {
      return;
    }
    void beginSetup(undefined, { restart: true });
  }, [assignment, beginSetup, busy]);

  const heading = assignment?.tool_name || summary?.toolName || "Tool setup";
  const integration = assignment?.integration_name || summary?.integrationName || "";
  const actionable = assignment ? toolSetupCanStart(assignment) : false;
  const restartable = assignment?.status === "in_progress"
    && assignment.completion_kind === "redirect";
  const expiry = formatExpiry(assignment?.expires_at ?? null);
  const teamLabel = summary?.teamName || assignment?.team_slug || "this team";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="ph-no-capture max-h-[min(90dvh,48rem)] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto"
        data-private="true"
        aria-describedby="tool-setup-description"
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2.5 pr-8">
            <span className="grid h-8 w-8 shrink-0 place-items-center bg-foreground text-background">
              <Plug className="h-4 w-4" />
            </span>
            <span className="min-w-0 truncate">{heading}</span>
          </DialogTitle>
          <DialogDescription id="tool-setup-description">
            Complete this Silicon request here in Interface.
          </DialogDescription>
        </DialogHeader>

        {loading && !assignment ? (
          <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-muted-foreground">
            <CircleNotch className="h-4 w-4 animate-spin" />
            Loading setup…
          </div>
        ) : assignment ? (
          <div className="space-y-4">
            <div className="space-y-2 border bg-muted/20 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  {integration && <div className="text-sm font-medium">{integration}</div>}
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {assignment.tool_key}
                  </div>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 border px-2 py-1 text-[11px] font-medium capitalize",
                    statusTone(assignment.status),
                  )}
                >
                  <ToolSetupStatusIcon status={assignment.status} />
                  {prettyStatus(assignment.status)}
                </span>
              </div>
              {(assignment.note || summary?.note) && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {assignment.note || summary?.note}
                </p>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{assignment.requested_scope} setup</span>
                {expiry && <span>Expires {expiry}</span>}
              </div>
            </div>

            {assignment.status === "completed" && (
              <div className="flex items-start gap-2 border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" weight="fill" />
                <div>
                  <div className="font-medium">Setup complete</div>
                  <p className="text-xs text-muted-foreground">
                    The requesting Silicon can now use this connection.
                  </p>
                </div>
              </div>
            )}

            {assignment.status === "in_progress" && (
              <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <CircleNotch className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                <div>
                  <div className="font-medium">Waiting for the provider</div>
                  <p className="text-xs text-muted-foreground">
                    Finish the connection window. Interface will update this request automatically.
                  </p>
                </div>
              </div>
            )}

            {assignment.status === "failed" && (
              <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" weight="fill" />
                <div>
                  <div className="font-medium">Connection failed</div>
                  <p className="break-words text-xs text-muted-foreground">
                    {assignment.error_code
                      ? `Provider error: ${assignment.error_code.replace(/_/g, " ")}.`
                      : "The provider did not finish the connection."}
                  </p>
                </div>
              </div>
            )}

            {(actionable || restartable) && (
              <div className="border border-sky-500/30 bg-sky-500/10 p-3 text-xs">
                <div className="font-medium">Who can use this connection</div>
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  {connectionScopeNotice(assignment, teamLabel)}
                </p>
              </div>
            )}

            {assignment.will_enable_tool && toolSetupCanStart(assignment) && (
              <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Completing this request will enable {assignment.tool_name} for the team.
                </span>
              </div>
            )}

            {!assignment.tool_enabled
              && !assignment.will_enable_tool
              && ["pending", "failed"].includes(assignment.status) && (
              <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  A team manager must enable {assignment.tool_name} before you can connect it.
                </span>
              </div>
            )}

            {connectUrl && assignment.status === "in_progress" && (
              <Button type="button" className="w-full" onClick={openProvider}>
                Continue in connection window
                <ArrowSquareOut className="h-4 w-4" />
              </Button>
            )}

            {!connectUrl && restartable && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={restartProvider}
              >
                {busy && <CircleNotch className="h-4 w-4 animate-spin" />}
                Restart connection
              </Button>
            )}

            {actionable && assignment.completion_kind === "form" ? (
              fields.length && !schemaIssue ? (
                <form
                  className="ph-no-capture space-y-4"
                  data-private="true"
                  onSubmit={submitForm}
                >
                  <div>
                    <div className="text-sm font-medium">Connection details</div>
                    <p className="text-xs text-muted-foreground">
                      Secret values are submitted once and are not stored by Interface.
                    </p>
                  </div>
                  {fields.map((field) => (
                    <SchemaField
                      key={field.key}
                      field={field}
                      value={fieldValues[field.key] ?? (field.kind === "boolean" ? false : "")}
                      disabled={busy}
                      onChange={(value) => {
                        setFieldValues((current) => ({ ...current, [field.key]: value }));
                      }}
                    />
                  ))}
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <CircleNotch className="h-4 w-4 animate-spin" />}
                    Save connection
                  </Button>
                </form>
              ) : (
                <div className="border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {schemaIssue || "This integration has no usable setup fields. Ask a team manager to review it."}
                </div>
              )
            ) : actionable ? (
              <Button
                type="button"
                className="w-full"
                disabled={busy}
                onClick={() => void beginSetup()}
              >
                {busy && <CircleNotch className="h-4 w-4 animate-spin" />}
                {assignment.completion_kind === "redirect"
                  ? assignment.status === "failed"
                    ? "Retry account connection"
                    : "Connect account"
                  : "Complete setup"}
              </Button>
            ) : null}

            {error && (
              <div role="alert" className="flex items-start gap-2 border border-destructive/35 bg-destructive/10 p-3 text-xs text-destructive">
                <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" weight="fill" />
                <span className="min-w-0 flex-1 break-words">{error}</span>
                {assignment?.status === "in_progress" && (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 font-medium underline underline-offset-2"
                    onClick={() => {
                      pollAttemptsRef.current = 0;
                      setError("");
                      void refresh(undefined, true);
                    }}
                  >
                    <ArrowClockwise className="h-3.5 w-3.5" />
                    Refresh
                  </button>
                )}
              </div>
            )}

            {assignment && toolSetupCanCancel(assignment) && (
              <div className="flex justify-end border-t pt-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void cancelRequest()}
                  className="text-muted-foreground hover:text-destructive"
                >
                  Cancel setup request
                </Button>
              </div>
            )}
          </div>
        ) : error ? (
          <div role="alert" className="space-y-3 border border-destructive/35 bg-destructive/10 p-3">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" weight="fill" />
              <span>{error}</span>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
              <ArrowClockwise className="h-4 w-4" />
              Try again
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
