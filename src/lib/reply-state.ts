import type { Event } from "./types";

/** Refresh an active reply only from the same authoritative event identity. */
export function reconcileReplyTarget<T extends Pick<Event, "event_id">>(
  active: T | null,
  authoritative: T | undefined,
): T | null {
  if (!active || !authoritative) return active;
  return authoritative.event_id === active.event_id ? authoritative : active;
}
