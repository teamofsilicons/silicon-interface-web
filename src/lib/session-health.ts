"use client";

/**
 * Whether the browser session still carries request authority.
 *
 * Glass types `web_session_revoked` only for an explicitly blacklisted refresh
 * token, so a session that merely *expired* arrives as an ordinary anonymous
 * restore. That case must never end the local session — the owner's durable
 * history stays readable and the composer keeps queueing — but it also must not
 * stay silent, or the owner reads cached chats indefinitely inside an app whose
 * every request is being rejected.
 *
 * This module carries only that one bit. It never deletes anything, and it is
 * raised exclusively from restores that were observed while Glass was proved
 * reachable over HTTPS.
 */
export type SessionHealthIssue = {
  reason: "signin_required";
  at: number;
};

export const SESSION_HEALTH_EVENT = "silicon:session-health";
let current: SessionHealthIssue | null = null;

function emit(next: SessionHealthIssue | null): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent !== "function"
  ) {
    return;
  }
  window.dispatchEvent(new CustomEvent(SESSION_HEALTH_EVENT, { detail: next }));
}

/** Idempotent: repeated reports keep the original observation time. */
export function reportSignInRequired(): SessionHealthIssue {
  if (current) return current;
  current = { reason: "signin_required", at: Date.now() };
  emit(current);
  return current;
}

export function clearSessionIssue(): void {
  if (!current) return;
  current = null;
  emit(null);
}

export function currentSessionIssue(): SessionHealthIssue | null {
  return current;
}
