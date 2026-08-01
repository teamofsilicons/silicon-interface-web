export type WebSessionRestoreState =
  | "restored"
  | "anonymous"
  | "unavailable"
  | "revoked";

export type SessionBootDecision =
  | "enter"
  | "enter-and-retry"
  | "confirm-anonymous"
  | "login"
  | "retry";

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
 */
export function sessionBootDecision(
  state: WebSessionRestoreState,
  hasKnownOwner: boolean,
  anonymousConfirmations: number,
): SessionBootDecision {
  if (state === "restored") return "enter";
  if (state === "unavailable") return hasKnownOwner ? "enter-and-retry" : "retry";
  if (state === "revoked") return "login";
  // A missing/expired browser cookie alone is not logout evidence when the
  // browser still owns durable local state. This covers cookie eviction,
  // browser privacy races, and temporarily inconsistent intermediaries. Only
  // an explicit backend revocation may discard that known owner automatically.
  if (hasKnownOwner) return "enter-and-retry";
  return anonymousConfirmations >= 2 ? "login" : "confirm-anonymous";
}

export function compatibilityRestoreAllowsEntry(
  state: WebSessionRestoreState,
  hasKnownOwner: boolean,
): boolean {
  return state === "restored" ||
    ((state === "unavailable" || state === "anonymous") && hasKnownOwner);
}
