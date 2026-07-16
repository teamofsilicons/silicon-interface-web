"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  api,
  type ModerationAppeal,
  type ModerationRestriction,
} from "@/lib/api";
import { Button } from "@/components/ui/button";

function formatExpiry(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

export function SafetyStatusSection() {
  const [restrictions, setRestrictions] = React.useState<ModerationRestriction[]>([]);
  const [appeals, setAppeals] = React.useState<ModerationAppeal[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [appealTarget, setAppealTarget] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoadError(false);
    try {
      const [restrictionResponse, appealResponse] = await Promise.all([
        api.moderationRestrictions(),
        api.moderationAppeals(),
      ]);
      setRestrictions(restrictionResponse.restrictions);
      setAppeals(appealResponse.appeals);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) void refresh();
    });
    return () => {
      alive = false;
    };
  }, [refresh]);

  const submit = async () => {
    if (!appealTarget || submitting) return;
    const normalized = reason.trim();
    if (normalized.length < 20) {
      toast.error("Please add at least 20 characters so the safety team can review it.");
      return;
    }
    setSubmitting(true);
    try {
      const existing = appeals.find((appeal) => appeal.restriction_id === appealTarget);
      if (!existing) await api.submitModerationAppeal({ restriction_id: appealTarget, reason: normalized });
      await refresh();
      setAppealTarget(null);
      setReason("");
      toast.success("appeal received");
    } catch {
      // A response can be lost after Glass committed the appeal. Resolve the
      // ambiguity by reading the private appeal list before inviting a retry.
      try {
        const result = await api.moderationAppeals();
        setAppeals(result.appeals);
        if (result.appeals.some((appeal) => appeal.restriction_id === appealTarget)) {
          setAppealTarget(null);
          setReason("");
          toast.success("appeal received");
          return;
        }
      } catch {
        // Preserve the user's text and target for a deliberate retry.
      }
      toast.error("We couldn't confirm the appeal. Your text is still here—try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const appealFor = (restrictionId: string) =>
    appeals.find((appeal) => appeal.restriction_id === restrictionId);

  return (
    <section className="border-t pt-5" aria-labelledby="safety-status-heading">
      <h2 id="safety-status-heading" className="text-sm font-semibold">Safety status</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Account limits and appeals are private to you.
      </p>
      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">checking safety status…</p>
      ) : loadError ? (
        <div className="mt-3 flex items-center gap-3 text-sm">
          <span role="alert">Safety status could not be loaded.</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>retry</Button>
        </div>
      ) : restrictions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No active account restrictions.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {restrictions.map((restriction) => {
            const appeal = appealFor(restriction.restriction_id);
            const editing = appealTarget === restriction.restriction_id;
            return (
              <article key={restriction.restriction_id} className="border border-input p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{restriction.state.replaceAll("_", " ")}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Ends {formatExpiry(restriction.expires_at)}
                    </div>
                  </div>
                  {appeal ? (
                    <span className="text-xs font-medium">appeal: {appeal.status}</span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAppealTarget(restriction.restriction_id);
                        setReason("");
                      }}
                    >
                      appeal
                    </Button>
                  )}
                </div>
                {editing && (
                  <div className="mt-3 space-y-2">
                    <label className="block text-xs font-medium" htmlFor={`appeal-${restriction.restriction_id}`}>
                      Explain why this should be reviewed
                    </label>
                    <textarea
                      id={`appeal-${restriction.restriction_id}`}
                      value={reason}
                      onChange={(event) => setReason(event.target.value.slice(0, 2000))}
                      minLength={20}
                      maxLength={2000}
                      rows={4}
                      autoFocus
                      disabled={submitting}
                      className="w-full resize-y border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
                    />
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs text-muted-foreground">{reason.length}/2000</span>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={submitting}
                          onClick={() => {
                            setAppealTarget(null);
                            setReason("");
                          }}
                        >
                          cancel
                        </Button>
                        <Button size="sm" disabled={submitting || reason.trim().length < 20} onClick={() => void submit()}>
                          {submitting ? "checking…" : "submit appeal"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
