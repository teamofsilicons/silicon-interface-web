import { ApiError } from "./api";
import { UploadStalledError } from "./upload-stall-error";
import type { HeldSend } from "./types";
export type CorrectionAction =
  | "review_input"
  | "repair_session"
  | "repair_device"
  | "solve_challenge"
  | "remove_reply"
  | "edit_message"
  | "copy_to_composer"
  | "replace_attachment"
  | "retry_transcription"
  | "resume_upload"
  | "restart_upload"
  | "request_access"
  | "upgrade_client"
  | "try_later"
  | "show_details"
  | "discard_local";

export type SendFailureCode =
  | "network_unavailable"
  | "upload_stalled"
  | "unknown_failure"
  | "invalid_request"
  | "invalid_client_id"
  | "client_id_mismatch"
  | "invalid_device_id"
  | "idempotency_conflict"
  | "invalid_payload"
  | "payload_too_large"
  | "invalid_reply"
  | "access_revoked"
  | "peer_unavailable"
  | "e2ee_client_required"
  | "media_missing"
  | "media_mismatch"
  | "media_not_ready"
  | "transcription_pending"
  | "transcription_failed"
  | "upload_expired"
  | "upload_incomplete"
  | "upload_checksum_mismatch"
  | "upload_identity_conflict"
  | "session_expired"
  | "request_timeout"
  | "too_early"
  | "rate_limited"
  | "capacity_unavailable"
  | "server_unavailable"
  | "challenge_required"
  | "challenge_failed"
  | "challenge_locked"
  | "challenge_unavailable"
  | "state_conflict"
  | "resource_unavailable";

export type PendingSendState =
  | "queued"
  | "resolving"
  | "retry_wait"
  | "challenge"
  | "blocked";

export interface SendFailureRecord {
  domain: "chat.operation" | "transport" | "protocol";
  code: SendFailureCode;
  messageKey: `send_failure.${SendFailureCode}`;
  retryable: boolean;
  automatic: boolean;
  correctionActions: CorrectionAction[];
  attempt: number;
  failedAt: number;
  nextAttemptAt?: number;
  retryAfterMs?: number;
  httpStatus: number;
}

type FailurePolicy = {
  retryable: boolean;
  automatic: boolean;
  actions: readonly CorrectionAction[];
};

const POLICY: Record<SendFailureCode, FailurePolicy> = {
  network_unavailable: { retryable: true, automatic: true, actions: [] },
  upload_stalled: { retryable: true, automatic: false, actions: ["resume_upload", "discard_local"] },
  unknown_failure: { retryable: false, automatic: false, actions: [] },
  invalid_request: { retryable: false, automatic: false, actions: ["review_input", "discard_local"] },
  invalid_client_id: { retryable: false, automatic: false, actions: ["copy_to_composer", "discard_local"] },
  client_id_mismatch: { retryable: false, automatic: false, actions: ["copy_to_composer", "discard_local"] },
  invalid_device_id: { retryable: false, automatic: false, actions: ["repair_device", "copy_to_composer"] },
  idempotency_conflict: { retryable: false, automatic: false, actions: ["show_details", "copy_to_composer", "discard_local"] },
  invalid_payload: { retryable: false, automatic: false, actions: ["edit_message", "discard_local"] },
  payload_too_large: { retryable: false, automatic: false, actions: ["edit_message", "replace_attachment", "discard_local"] },
  invalid_reply: { retryable: false, automatic: false, actions: ["remove_reply", "edit_message", "discard_local"] },
  access_revoked: { retryable: false, automatic: false, actions: ["request_access", "copy_to_composer", "discard_local"] },
  peer_unavailable: { retryable: true, automatic: false, actions: ["try_later", "copy_to_composer", "discard_local"] },
  e2ee_client_required: { retryable: false, automatic: false, actions: ["upgrade_client", "copy_to_composer", "discard_local"] },
  media_missing: { retryable: false, automatic: false, actions: ["replace_attachment", "discard_local"] },
  media_mismatch: { retryable: false, automatic: false, actions: ["replace_attachment", "discard_local"] },
  media_not_ready: { retryable: true, automatic: true, actions: [] },
  transcription_pending: { retryable: true, automatic: true, actions: [] },
  transcription_failed: { retryable: true, automatic: false, actions: ["retry_transcription", "replace_attachment", "discard_local"] },
  upload_expired: { retryable: true, automatic: false, actions: ["restart_upload", "discard_local"] },
  upload_incomplete: { retryable: true, automatic: true, actions: ["resume_upload"] },
  upload_checksum_mismatch: { retryable: false, automatic: false, actions: ["restart_upload", "replace_attachment", "discard_local"] },
  upload_identity_conflict: { retryable: false, automatic: false, actions: ["restart_upload", "replace_attachment", "discard_local"] },
  session_expired: { retryable: true, automatic: false, actions: ["repair_session"] },
  request_timeout: { retryable: true, automatic: true, actions: [] },
  too_early: { retryable: true, automatic: true, actions: [] },
  rate_limited: { retryable: true, automatic: true, actions: [] },
  capacity_unavailable: { retryable: true, automatic: true, actions: [] },
  server_unavailable: { retryable: true, automatic: true, actions: [] },
  challenge_required: { retryable: true, automatic: false, actions: ["solve_challenge"] },
  challenge_failed: { retryable: true, automatic: false, actions: ["solve_challenge", "show_details"] },
  challenge_locked: { retryable: true, automatic: true, actions: [] },
  challenge_unavailable: { retryable: true, automatic: true, actions: [] },
  state_conflict: { retryable: false, automatic: false, actions: ["show_details", "discard_local"] },
  resource_unavailable: { retryable: false, automatic: false, actions: ["show_details", "discard_local"] },
};

const ACTIONS = new Set<CorrectionAction>(
  Object.values(POLICY).flatMap((policy) => [...policy.actions]),
);

export function isCorrectionAction(value: unknown): value is CorrectionAction {
  return typeof value === "string" && ACTIONS.has(value as CorrectionAction);
}

function fallbackCode(status: number): SendFailureCode {
  if (status === 0) return "network_unavailable";
  if (status === 401) return "session_expired";
  if (status === 403) return "access_revoked";
  if (status === 404) return "resource_unavailable";
  if (status === 408) return "request_timeout";
  if (status === 409) return "state_conflict";
  if (status === 413) return "payload_too_large";
  if (status === 425) return "too_early";
  if (status === 428) return "challenge_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_unavailable";
  return "invalid_request";
}

const MAX_RETRY_AFTER_MS = 86_400_000;

type ParsedContract =
  | { kind: "fallback" }
  | { kind: "invalid" }
  | {
      kind: "valid";
      code: SendFailureCode;
      actions: CorrectionAction[];
      retryAfterMs?: number;
    };

function parseServerContract(body: unknown): ParsedContract {
  if (!body || typeof body !== "object") return { kind: "fallback" };
  const failure = (body as { failure?: unknown }).failure;
  if (!failure || typeof failure !== "object") return { kind: "fallback" };
  const value = failure as Record<string, unknown>;
  if (value.domain !== "chat.operation") return { kind: "fallback" };
  const code = typeof value.code === "string" && value.code in POLICY
    ? (value.code as SendFailureCode)
    : null;
  if (
    !code ||
    code === "network_unavailable" ||
    code === "upload_stalled" ||
    code === "unknown_failure"
  ) {
    return { kind: "invalid" };
  }
  const policy = POLICY[code];
  if (value.retryable !== policy.retryable || value.automatic !== policy.automatic) {
    return { kind: "invalid" };
  }
  if (!Array.isArray(value.correction_actions)) return { kind: "invalid" };
  const actions = value.correction_actions.filter(
    (action): action is CorrectionAction => isCorrectionAction(action),
  );
  if (
    actions.length !== policy.actions.length ||
    actions.some((action, index) => action !== policy.actions[index])
  ) {
    return { kind: "invalid" };
  }
  const seconds = Number(value.retry_after_seconds);
  return {
    kind: "valid",
    code,
    actions,
    ...(Number.isFinite(seconds)
      ? {
          retryAfterMs:
            Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1_000)),
        }
      : {}),
  };
}

export function isSendFailureRecord(value: unknown): value is SendFailureRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SendFailureRecord>;
  const policy =
    typeof row.code === "string" && row.code in POLICY
      ? POLICY[row.code as SendFailureCode]
      : null;
  if (!policy) return false;
  const expectedDomain =
    row.code === "network_unavailable" || row.code === "upload_stalled"
      ? "transport"
      : row.code === "unknown_failure"
        ? "protocol"
        : "chat.operation";
  return Boolean(
    row.domain === expectedDomain &&
      row.messageKey === `send_failure.${row.code}` &&
      row.retryable === policy.retryable &&
      row.automatic === policy.automatic &&
      Array.isArray(row.correctionActions) &&
      row.correctionActions.length === policy.actions.length &&
      row.correctionActions.every(
        (action, index) => action === policy.actions[index],
      ) &&
      Number.isInteger(row.attempt) &&
      (row.attempt ?? 0) > 0 &&
      typeof row.failedAt === "number" &&
      Number.isFinite(row.failedAt) &&
      typeof row.httpStatus === "number" &&
      Number.isFinite(row.httpStatus) &&
      (policy.automatic
        ? typeof row.nextAttemptAt === "number" &&
          Number.isFinite(row.nextAttemptAt) &&
          row.nextAttemptAt >= row.failedAt
        : row.nextAttemptAt == null) &&
      (row.retryAfterMs == null ||
        (typeof row.retryAfterMs === "number" &&
          Number.isFinite(row.retryAfterMs) &&
          row.retryAfterMs >= 0 &&
          row.retryAfterMs <= MAX_RETRY_AFTER_MS))
  );
}

export interface ClassifySendFailureOptions {
  attempt: number;
  now?: number;
  jitter?: number;
}

export function classifySendFailure(
  error: unknown,
  options: ClassifySendFailureOptions,
): {
  state: "queued" | "blocked" | "challenge";
  phase: Exclude<PendingSendState, "queued" | "resolving">;
  failure: SendFailureRecord;
} {
  const now = options.now ?? Date.now();
  const attempt = Math.max(1, Math.trunc(options.attempt));
  const status = error instanceof ApiError ? error.status : 0;
  const server: ParsedContract = error instanceof ApiError
    ? parseServerContract(error.body)
    : { kind: "fallback" };
  const fallback = fallbackCode(status);
  // Unknown domains are not authoritative and use conservative HTTP fallback.
  // A malformed/unknown chat.operation contract fails closed.
  const code: SendFailureCode =
    error instanceof UploadStalledError
      ? "upload_stalled"
      : server.kind === "valid"
      ? server.code
      : server.kind === "invalid"
        ? "unknown_failure"
        : fallback;
  const policy = POLICY[code];
  const retryAfterMs = Math.max(
    0,
    Math.min(
      MAX_RETRY_AFTER_MS,
      server.kind === "valid"
        ? server.retryAfterMs ?? (error instanceof ApiError ? error.retryAfterMs ?? 0 : 0)
        : error instanceof ApiError
          ? error.retryAfterMs ?? 0
          : 0,
    ),
  );
  const ceiling = Math.min(1_000 * 2 ** Math.min(attempt, 6), 60_000);
  const jitter = Math.max(0, options.jitter ?? 0.5 + Math.random());
  const automaticDelay = Math.max(Math.floor(ceiling * jitter), retryAfterMs);
  const nextAttemptAt = policy.automatic
    ? now + automaticDelay
    : undefined;
  const failure: SendFailureRecord = {
    domain:
      code === "network_unavailable" || code === "upload_stalled"
        ? "transport"
        : code === "unknown_failure"
          ? "protocol"
          : "chat.operation",
    code,
    messageKey: `send_failure.${code}`,
    retryable: policy.retryable,
    automatic: policy.automatic,
    correctionActions:
      server.kind === "valid" ? [...server.actions] : [...policy.actions],
    attempt,
    failedAt: now,
    ...(nextAttemptAt != null ? { nextAttemptAt } : {}),
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    httpStatus: status,
  };
  const phase: Exclude<PendingSendState, "queued" | "resolving"> =
    code === "challenge_required" || code === "challenge_failed"
      ? "challenge"
      : policy.automatic
        ? "retry_wait"
        : "blocked";
  const state = phase === "retry_wait" ? "queued" : phase;
  return { state, phase, failure };
}

export function stateAfterResolution(failure: SendFailureRecord): PendingSendState {
  if (failure.code === "challenge_required" || failure.code === "challenge_failed") {
    return "challenge";
  }
  return failure.automatic ? "retry_wait" : "blocked";
}

/** Project Glass-owned held release metadata through the same closed client
 * contract. The server deadline remains authoritative; raw `error` text is
 * never read or copied into the UI record. */
export function sendFailureFromHeld(held: HeldSend): SendFailureRecord | null {
  if (!held.failure && !held.failure_code) return null;
  const failedAtValue = held.failure_at ? Date.parse(held.failure_at) : Number.NaN;
  const failedAt = Number.isFinite(failedAtValue) ? failedAtValue : Date.now();
  const body = held.failure
    ? { failure: held.failure }
    : {
        failure: {
          domain: "chat.operation",
          code: held.failure_code,
          // Missing policy flags intentionally make this legacy shape fail
          // closed as unknown_failure.
        },
      };
  const classified = classifySendFailure(
    new ApiError(400, body, "held send requires attention"),
    {
      attempt: Math.max(1, held.release_attempts ?? 1),
      now: failedAt,
      jitter: 0,
    },
  ).failure;
  if (!classified.automatic) return classified;
  const deadlineValue = held.next_attempt_at
    ? Date.parse(held.next_attempt_at)
    : Number.NaN;
  return {
    ...classified,
    nextAttemptAt: Number.isFinite(deadlineValue)
      ? Math.max(failedAt, deadlineValue)
      : classified.nextAttemptAt,
  };
}

const COPY: Partial<Record<SendFailureCode, string>> = {
  network_unavailable: "Offline. Saved on this device.",
  upload_stalled: "Upload stopped making progress.",
  session_expired: "Sign in again to send this message.",
  invalid_device_id: "This device needs to be repaired before sending.",
  invalid_reply: "The replied-to message is no longer available.",
  access_revoked: "You no longer have access to this chat.",
  peer_unavailable: "The recipient is unavailable right now.",
  payload_too_large: "This message or attachment is too large.",
  media_missing: "The attachment source is missing.",
  media_mismatch: "The attachment no longer matches this send.",
  media_not_ready: "Attachment processing is still finishing.",
  transcription_pending: "Transcription is still finishing.",
  transcription_failed: "Transcription needs attention.",
  upload_expired: "The upload session expired.",
  upload_incomplete: "The upload will resume.",
  upload_checksum_mismatch: "The attachment failed its integrity check.",
  upload_identity_conflict: "This upload identity is already bound to different bytes.",
  rate_limited: "Sending is temporarily limited.",
  capacity_unavailable: "Sending is temporarily unavailable.",
  server_unavailable: "Service is temporarily unavailable.",
  challenge_required: "Verify this device to continue sending.",
  challenge_failed: "Verification was not accepted.",
  challenge_locked: "Verification is temporarily locked.",
  challenge_unavailable: "Verification is temporarily unavailable.",
  idempotency_conflict: "This saved send conflicts with an earlier operation.",
  e2ee_client_required: "Update this client before sending in this chat.",
  unknown_failure: "The server returned an unsafe recovery response.",
};

export function sendFailureMessage(failure: SendFailureRecord): string {
  return COPY[failure.code] ?? "This message needs attention before it can be sent.";
}

export function correctionActionLabel(action: CorrectionAction): string {
  const labels: Record<CorrectionAction, string> = {
    review_input: "review",
    repair_session: "sign in",
    repair_device: "repair device",
    solve_challenge: "verify",
    remove_reply: "remove reply",
    edit_message: "edit",
    copy_to_composer: "copy",
    replace_attachment: "replace file",
    retry_transcription: "retry transcript",
    resume_upload: "resume upload",
    restart_upload: "restart upload",
    request_access: "request access",
    upgrade_client: "update app",
    try_later: "try again",
    show_details: "details",
    discard_local: "discard",
  };
  return labels[action];
}
