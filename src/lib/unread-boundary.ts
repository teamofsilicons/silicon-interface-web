import type { Event, Room, StreamVectorPosition, UnreadBoundary } from "./types";

export type RoomOpenReadTarget = {
  eventId: string | null;
  streamPosition: number;
};

/** Opening a writable room is itself the read action. Resolve it entirely from
 * the room-list projection so the badge can clear before history hydration. */
export function roomOpenReadTarget(room: Room): RoomOpenReadTarget | null {
  const unreadCount = Math.max(
    Number.isSafeInteger(room.unread_count) ? Number(room.unread_count) : 0,
    Number.isSafeInteger(room.unread_boundary.unread_count)
      ? Number(room.unread_boundary.unread_count)
      : 0,
  );
  if (room.observed || (!room.unread && unreadCount < 1)) {
    return null;
  }
  const lastPosition = room.last_event?.stream_position;
  return {
    eventId: room.last_event?.event_id?.trim() || null,
    streamPosition: Math.max(
      room.unread_boundary.last_read_stream_position,
      room.unread_boundary.through_stream_position,
      Number.isSafeInteger(lastPosition) ? Number(lastPosition) : 0,
    ),
  };
}

export function isUnreadEligibleEvent(event: Event): boolean {
  return event.type !== "m.reaction" && event.type !== "m.progress" &&
    event.type !== "m.system" && event.type !== "m.session_marker" &&
    event.sender_kind !== "system" && event.is_final !== false && !event.redacted_at;
}

/** Resolve by immutable event id first; stream position keeps the divider
 * stable when the original anchor was later redacted or folded away. */
export function selectUnreadDividerEventId(
  events: Event[],
  boundary: UnreadBoundary,
): string | null {
  if (!boundary.first_unread_event_id || boundary.first_unread_stream_position == null) return null;
  const exact = events.find(
    (event) => isUnreadEligibleEvent(event) && event.event_id === boundary.first_unread_event_id,
  );
  if (exact) return exact.event_id;
  return events.find(
    (event) => isUnreadEligibleEvent(event) &&
      Number.isSafeInteger(event.stream_position) &&
      Number(event.stream_position) >= boundary.first_unread_stream_position!,
  )?.event_id ?? null;
}

export type VisibleUnreadCandidate = {
  event: Event;
  top: number;
  bottom: number;
  height: number;
};

/** Highest authoritative incoming event with a meaningful visible slice. */
export function selectVisibleReadTarget(
  candidates: VisibleUnreadCandidate[],
  viewport: { top: number; bottom: number },
  myUsername: string | null,
  afterPosition: number,
  afterVector?: StreamVectorPosition,
): Event | null {
  let target: Event | null = null;
  for (const candidate of candidates) {
    const event = candidate.event;
    if (!isUnreadEligibleEvent(event) || !event.sender_handle ||
      event.sender_handle === myUsername || !Number.isSafeInteger(event.stream_position)) continue;
    const position = Number(event.stream_position);
    // Event positions are per writer. Comparing writer-a:6 with the scalar
    // maximum writer-b:11 incorrectly calls a genuinely new event already
    // read. Prefer the authoritative vector whenever the event identifies its
    // writer, retaining the scalar only for legacy rows.
    const writer = event.stream_writer;
    const alreadyRead = writer && afterVector
      ? position <= (afterVector.writers[writer] ?? afterVector.floor)
      : position <= afterPosition;
    if (alreadyRead) continue;
    const visiblePixels = Math.min(candidate.bottom, viewport.bottom) -
      Math.max(candidate.top, viewport.top);
    if (visiblePixels < Math.min(24, Math.max(1, candidate.height * 0.25))) continue;
    // Candidates follow timeline order, which remains authoritative across
    // writers even when their independent numeric positions are incomparable.
    target = event;
  }
  return target;
}
