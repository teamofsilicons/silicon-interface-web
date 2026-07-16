import type { Room } from "./types";

export function roomVisibleInArchiveView(
  room: Room,
  showArchived: boolean,
  searchActive: boolean,
): boolean {
  return searchActive || Boolean(room.list_preferences?.archived) === showArchived;
}

export function compareRoomListRows(a: Room, b: Room): number {
  const pinned = Number(Boolean(b.list_preferences?.pinned)) -
    Number(Boolean(a.list_preferences?.pinned));
  if (pinned) return pinned;
  const activity = b.list_projection.activity_stream_position -
    a.list_projection.activity_stream_position;
  if (activity) return activity;
  return b.room_id.localeCompare(a.room_id);
}

/** Server-owned fallback only. Local working/outbox/draft text takes precedence
 * in the row and remains in its owning durable store. */
export function serverRoomListStatus(room: Room): "attention" | "held" | null {
  if (room.list_projection.held.attention_count > 0) return "attention";
  if (room.list_projection.held.active_count > 0) return "held";
  return null;
}
