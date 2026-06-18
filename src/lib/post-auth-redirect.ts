/**
 * A one-shot "where to land after authenticating" target, stored in
 * sessionStorage. Used so an invitee who has to log in / sign up (and, for new
 * users, pass through onboarding) returns to the invite page to finish joining
 * — without threading a `?next=` param through every auth pivot.
 *
 * Only same-origin relative paths are honored (no "//evil.com" open redirects).
 */
const KEY = "silicon-interface:post-auth-redirect";

function isSafe(path: string | null | undefined): path is string {
  return !!path && path.startsWith("/") && !path.startsWith("//");
}

export function setPostAuthRedirect(path: string): void {
  if (typeof window === "undefined" || !isSafe(path)) return;
  try {
    window.sessionStorage.setItem(KEY, path);
  } catch {
    /* sessionStorage unavailable — non-fatal, we just won't redirect back */
  }
}

/** Read and clear the pending redirect. Returns null when none / unsafe. */
export function consumePostAuthRedirect(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(KEY);
    if (v) window.sessionStorage.removeItem(KEY);
    return isSafe(v) ? v : null;
  } catch {
    return null;
  }
}
