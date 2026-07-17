import type { PresenceProjection } from "./types";

function newestTimestamp(...values: string[]): string {
  let newest = "";
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= newestMs) continue;
    newest = value;
    newestMs = parsed;
  }
  return newest;
}

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
  if (!current) return incoming;
  if (incoming.revision > current.revision) {
    // A message accepted after the last presence heartbeat is direct proof the
    // peer was active at that instant. Preserve that observation across a
    // newer offline heartbeat whose last_seen projection is lagging. Hidden
    // remains an explicit privacy boundary and always clears derived activity.
    if (incoming.state === "hidden" || current.state === "hidden") return incoming;
    const lastSeen = newestTimestamp(incoming.last_seen_at, current.last_seen_at);
    return lastSeen === incoming.last_seen_at
      ? incoming
      : { ...incoming, last_seen_at: lastSeen };
  }
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

/** Fold a message/event authored by the peer into the ephemeral presence
 * projection. This cannot make somebody appear online and never bypasses the
 * hidden privacy state; it only prevents an impossible "last seen 48m ago"
 * label beside a message they sent four minutes ago. */
export function observePresenceActivity(
  presence: PresenceProjection | undefined,
  activityAt: string,
): PresenceProjection | undefined {
  if (!presence || presence.state === "hidden" || !activityAt) return presence;
  const lastSeen = newestTimestamp(presence.last_seen_at, activityAt);
  if (!lastSeen || lastSeen === presence.last_seen_at) return presence;
  return { ...presence, last_seen_at: lastSeen };
}
