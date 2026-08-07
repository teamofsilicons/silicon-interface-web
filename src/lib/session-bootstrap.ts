export type WebSessionRestoreState =
  | "restored"
  | "anonymous"
  | "unavailable"
  | "revoked";

export type SessionBootDecision =
  | "enter"
  | "enter-and-retry"
  | "enter-and-signin-required"
  | "confirm-anonymous"
  | "login"
  | "retry";

/** Consecutive anonymous restores that end a session with no durable owner. */
export const ANONYMOUS_CONFIRMATIONS_BEFORE_LOGIN = 2;
/**
 * Consecutive anonymous restores — each one observed while Glass was proved
 * reachable — before a retained owner is told that signing in is required.
 * Deliberately never ends the local session; it only stops the silence.
 */
export const ANONYMOUS_CONFIRMATIONS_BEFORE_SIGNIN_PROMPT = 2;

/**
 * A returning browser can paint its owner-scoped, durable shell before the
 * network renews request authority. Explicit logout is the one synchronous
 * signal that must keep protected UI hidden; backend revocation is handled as
 * soon as the restore request answers.
 */
export function canPaintRetainedSession(
  hasInMemoryAuthority: boolean,
  hasKnownOwner: boolean,
  explicitlyLoggedOut: boolean,
): boolean {
  return !explicitlyLoggedOut && (hasInMemoryAuthority || hasKnownOwner);
}

/** Only an explicit client/auth rejection proves that browser authority ended. */
export function isAuthoritativeSessionRevocation(
  status: number | null,
  body?: unknown,
): boolean {
  return status === 401 && Boolean(
    body &&
    typeof body === "object" &&
    "code" in body &&
    (body as { code?: unknown }).code === "web_session_revoked",
  );
}

export function classifySessionRestoreFailure(
  status: number | null,
  body?: unknown,
): WebSessionRestoreState {
  if (isAuthoritativeSessionRevocation(status, body)) return "revoked";
  return status === 400 || status === 401
    ? "anonymous"
    : "unavailable";
}

/**
 * A transient refresh failure must never be presented as logout. A browser
 * with a known owner may stay in its offline-capable session while the server
 * is unavailable. A confirmed anonymous response is different: it proves the
 * renewable credential is no longer valid and must end the local session.
 *
 * `glassReachable` must be exact HTTPS reachability evidence for the moment
 * this restore answered — never `navigator.onLine`, and never a stale probe
 * from an earlier attempt. A renewable credential that is merely unreachable
 * is indistinguishable from cookie eviction, so it stays in the silent retry
 * path; only a reachable Glass that keeps answering anonymous proves the
 * session genuinely ended rather than momentarily failing to present itself.
 */
export function sessionBootDecision(
  state: WebSessionRestoreState,
  hasKnownOwner: boolean,
  anonymousConfirmations: number,
  glassReachable = false,
): SessionBootDecision {
  if (state === "restored") return "enter";
  if (state === "unavailable") return hasKnownOwner ? "enter-and-retry" : "retry";
  if (state === "revoked") return "login";
  // A missing/expired browser cookie alone is not logout evidence when the
  // browser still owns durable local state. This covers cookie eviction,
  // browser privacy races, and temporarily inconsistent intermediaries. Only
  // an explicit backend revocation may discard that known owner automatically.
  if (hasKnownOwner) {
    // Expiry and revocation are indistinguishable at the transport layer: Glass
    // only types `web_session_revoked` for an explicitly blacklisted refresh
    // token, so a naturally expired session arrives here as plain "anonymous".
    // Retaining it silently forever leaves the owner reading cached history
    // inside an app whose every request is rejected. Keep the session and its
    // durable history, and say so instead.
    return glassReachable &&
        anonymousConfirmations >= ANONYMOUS_CONFIRMATIONS_BEFORE_SIGNIN_PROMPT
      ? "enter-and-signin-required"
      : "enter-and-retry";
  }
  return anonymousConfirmations >= ANONYMOUS_CONFIRMATIONS_BEFORE_LOGIN
    ? "login"
    : "confirm-anonymous";
}

/** Every decision that keeps the owner inside their offline-capable session. */
export function bootDecisionEntersApp(decision: SessionBootDecision): boolean {
  return decision === "enter" ||
    decision === "enter-and-retry" ||
    decision === "enter-and-signin-required";
}

export function compatibilityRestoreAllowsEntry(
  state: WebSessionRestoreState,
  hasKnownOwner: boolean,
): boolean {
  return state === "restored" ||
    ((state === "unavailable" || state === "anonymous") && hasKnownOwner);
}
