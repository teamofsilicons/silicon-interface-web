import type { PresenceProjection } from "./types";

/** A server online claim is only valid while its short lease is unexpired. */
export function presenceIsOnline(
  presence: PresenceProjection | undefined,
  nowMs = Date.now(),
): boolean {
  if (presence?.state !== "online") return false;
  const expiry = Date.parse(presence.expires_at);
  return Number.isFinite(expiry) && expiry > nowMs;
}

/** Apply an ephemeral update monotonically. Equal-revision contradictions
 * fail closed so reordering can never reveal a hidden user or resurrect a
 * false online indicator. */
export function mergePresence(
  current: PresenceProjection | undefined,
  incoming: PresenceProjection,
): PresenceProjection {
  if (!current || incoming.revision > current.revision) return incoming;
  if (incoming.revision < current.revision) return current;
  if (
    incoming.state === current.state &&
    incoming.expires_at === current.expires_at &&
    incoming.last_seen_at === current.last_seen_at
  ) return current;
  if (incoming.state === "hidden" || current.state === "hidden") {
    return { state: "hidden", expires_at: "", last_seen_at: "", revision: current.revision };
  }
  if (incoming.state === "offline" || current.state === "offline") {
    const lastSeen = [incoming.last_seen_at, current.last_seen_at]
      .filter(Boolean)
      .sort()
      .at(-1) ?? "";
    return { state: "offline", expires_at: "", last_seen_at: lastSeen, revision: current.revision };
  }
  return current;
}
