export type WebSessionRestoreState = "restored" | "anonymous" | "unavailable";

export type SessionBootDecision =
  | "enter"
  | "enter-and-retry"
  | "confirm-anonymous"
  | "login"
  | "retry";

/** Only an explicit client/auth rejection proves that browser authority ended. */
export function classifySessionRestoreFailure(status: number | null): WebSessionRestoreState {
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
  return anonymousConfirmations >= 2 ? "login" : "confirm-anonymous";
}

export function compatibilityRestoreAllowsEntry(
  state: WebSessionRestoreState,
  hasKnownOwner: boolean,
): boolean {
  return state === "restored" || (state === "unavailable" && hasKnownOwner);
}
