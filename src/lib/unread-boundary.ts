import type { Event, Room, StreamVectorPosition, UnreadBoundary } from "./types";
import { workEventCountsAsUnread } from "./work-update-presentation";

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
  if (room.observed) return null;
  const lastPosition = room.last_event?.stream_position;
  const eventId = room.last_event?.event_id?.trim() || null;
  // Room-list unread projections can lag the authoritative membership row by
  // one socket/account-sync turn. Opening a non-empty room is cheap and
  // idempotent, so always persist the latest known event instead of trusting a
  // possibly stale zero badge and waiting for viewport hydration to repair it.
  if (!eventId && !room.unread && unreadCount < 1) return null;
  return {
    eventId,
    streamPosition: Math.max(
      room.unread_boundary.last_read_stream_position,
      room.unread_boundary.through_stream_position,
      Number.isSafeInteger(lastPosition) ? Number(lastPosition) : 0,
    ),
  };
}

export function isUnreadEligibleEvent(event: Event): boolean {
  if (event.type === "m.work_task" || event.type === "m.work_event") {
    return workEventCountsAsUnread(event) && event.sender_kind !== "system" &&
      event.is_final !== false && !event.redacted_at;
  }
  return event.type !== "m.reaction" && event.type !== "m.progress" &&
    event.type !== "m.system" && event.type !== "m.session_marker" &&
    event.sender_kind !== "system" && event.is_final !== false && !event.redacted_at;
}

/** Whether an incoming event sits beyond this room's current read checkpoint.
 * This deliberately ignores the event's current notification policy: a
 * blocker resolution is no longer countable, but its earlier open revision
 * may still contribute one projected unread item that must be retracted. */
export function roomProjectsEventAsUnread(
  room: Room,
  event: Event,
  myUsername: string | null,
): boolean {
  if (room.observed || !event.sender_handle || event.sender_handle === myUsername) return false;
  const count = Math.max(
    Number.isSafeInteger(room.unread_count) ? Number(room.unread_count) : 0,
    Number.isSafeInteger(room.unread_boundary.unread_count)
      ? Number(room.unread_boundary.unread_count)
      : 0,
  );
  if (count < 1) return false;
  if (room.unread_boundary.first_unread_event_id === event.event_id) return true;
  if (!Number.isSafeInteger(event.stream_position)) return false;
  const position = Number(event.stream_position);
  const writer = event.stream_writer;
  const vector = room.unread_boundary.last_read_stream_vector;
  if (writer && vector) {
    return position > (vector.writers[writer] ?? vector.floor);
  }
  return position > room.unread_boundary.last_read_stream_position;
}

/** Remove one previously-counted event while retaining a stale first-unread
 * anchor when other unread rows remain. Divider selection already falls
 * forward from an ineligible anchor, just as it does after redaction. */
export function retractRoomUnreadEvent(room: Room, eventId: string): Room {
  if (!eventId) return room;
  const projectedListCount = Number.isSafeInteger(room.unread_count)
    ? Number(room.unread_count)
    : room.unread_boundary.unread_count;
  const listCount = Math.max(0, projectedListCount - 1);
  const boundaryCount = Math.max(0, room.unread_boundary.unread_count - 1);
  const hasUnread = Math.max(listCount, boundaryCount) > 0;
  return {
    ...room,
    unread: hasUnread,
    unread_count: listCount,
    unread_boundary: {
      ...room.unread_boundary,
      first_unread_event_id: hasUnread
        ? room.unread_boundary.first_unread_event_id
        : null,
      first_unread_stream_position: hasUnread
        ? room.unread_boundary.first_unread_stream_position
        : null,
      first_unread_stream_writer: hasUnread
        ? room.unread_boundary.first_unread_stream_writer
        : null,
      unread_count: boundaryCount,
    },
  };
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
