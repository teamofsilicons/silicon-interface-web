export type WebSessionRestoreState = "restored" | "anonymous" | "unavailable";

export type SessionBootDecision =
  | "enter"
  | "enter-and-retry"
  | "confirm-anonymous"
  | "login"
  | "retry";

/** Only an explicit client/auth rejection proves that browser authority ended. */
export function classifySessionRestoreFailure(status: number | null): WebSessionRestoreState {
  return status === 400 || status === 401 || status === 403
    ? "anonymous"
    : "unavailable";
}

/**
 * A transient refresh failure must never be presented as logout. Even an
 * anonymous response is confirmed once because a browser without Web Locks
 * can briefly submit a refresh cookie that another tab has just rotated.
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
