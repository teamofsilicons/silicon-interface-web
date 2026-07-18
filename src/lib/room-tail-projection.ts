import {
  incomingEventRevisionIsCurrent,
  mergeEventRevision,
} from "./event-revision";
import type { Event, Room } from "./types";
import type { TimelineEvent } from "./timeline-identity";

const PROJECTED_TAIL_FIELD = "_projectedRoomTail" as const;

export type ProjectedRoomTailEvent = TimelineEvent & {
  _projectedRoomTail: true;
  _projectedRoomTailType: string;
};

export function isProjectedRoomTail(event: Event): boolean {
  return (event as TimelineEvent)[PROJECTED_TAIL_FIELD] === true;
}

function cachedRevisionCoversTail(event: Event, room: Room): boolean {
  const tail = room.last_event;
  if (!tail || event.event_id !== tail.event_id || isProjectedRoomTail(event)) return false;
  const eventVersion = Number.isSafeInteger(event.edit_version) ? Number(event.edit_version) : 0;
  const tailVersion = Number.isSafeInteger(tail.edit_version) ? Number(tail.edit_version) : 0;
  if (eventVersion !== tailVersion) return eventVersion > tailVersion;
  if (!tail.edited_at) return true;
  if (!event.edited_at) return false;
  return event.edited_at >= tail.edited_at;
}

/**
 * A room-list row knows the exact identity, sender, timestamp and preview of
 * its newest event even when the bounded timeline cache is missing that row.
 * Project that knowledge into a non-interactive text bubble for first paint;
 * authoritative history replaces it by the same event id moments later.
 */
export function seedTimelineWithRoomTail(room: Room, cached: readonly Event[]): Event[] {
  const tail = room.last_event;
  if (!tail?.event_id || !tail.at || !tail.preview) return [...cached];

  const exactIndex = cached.findIndex((event) => event.event_id === tail.event_id);
  if (exactIndex >= 0 && cachedRevisionCoversTail(cached[exactIndex], room)) {
    return [...cached];
  }

  const projected: ProjectedRoomTailEvent = {
    event_id: tail.event_id,
    ...(Number.isSafeInteger(tail.stream_position)
      ? { stream_position: Number(tail.stream_position) }
      : {}),
    ...(tail.stream_writer ? { stream_writer: tail.stream_writer } : {}),
    room: 0,
    sender_kind: tail.sender_kind ?? "system",
    sender_id: null,
    sender_handle: tail.sender_handle,
    // The list projection deliberately carries no media payload. Rendering
    // its preview as text is stable for every event type and avoids broken
    // attachment controls while the canonical event is loading.
    type: "m.text",
    content: { body: tail.preview },
    reply_to_event_id: "",
    is_final: true,
    created_at: tail.at,
    edited_at: tail.edited_at ?? null,
    edit_version: Number.isSafeInteger(tail.edit_version) ? Number(tail.edit_version) : 0,
    redacted_at: null,
    redaction_reason: "",
    ...(tail.delivery ? { delivery: tail.delivery } : {}),
    _projectedRoomTail: true,
    _projectedRoomTailType: tail.type,
  };

  if (exactIndex < 0) return [...cached, projected];
  const next = [...cached];
  next[exactIndex] = projected;
  return next;
}

/** Canonical history must remove every marker/content byte from the preview. */
export function reconcileRoomTailProjection<T extends TimelineEvent>(
  current: T,
  incoming: T,
): T {
  const revised = mergeEventRevision(current, incoming);
  if (
    !isProjectedRoomTail(current) ||
    current.event_id !== incoming.event_id ||
    !incomingEventRevisionIsCurrent(current, incoming)
  ) {
    return revised;
  }
  const canonical = { ...revised } as T & Record<string, unknown>;
  delete canonical._projectedRoomTail;
  delete canonical._projectedRoomTailType;
  return canonical;
}
