import type { Room } from "./types";

export function roomVisibleInArchiveView(
  room: Room,
  showArchived: boolean,
  searchActive: boolean,
): boolean {
  return searchActive || Boolean(room.list_preferences?.archived) === showArchived;
}

/** The full "start a chat" empty state replaces the entire list chrome. Keep
 * the list chrome mounted while browsing archives—even after the final room is
 * unarchived—so its Back to conversations control can never disappear. */
export function useStandaloneRoomListEmptyState(
  loading: boolean,
  topLevelEmpty: boolean,
  archivedCount: number,
  showArchived: boolean,
): boolean {
  return !loading && topLevelEmpty && archivedCount === 0 && !showArchived;
}

/** Aggregate the archive entry from the complete room projection. Its preview
 * follows the newest activity—not pin state—because the archive row represents
 * the latest archived conversation as a whole. */
export function projectArchivedRoomListEntry(rooms: Room[]): {
  count: number;
  latest: Room | null;
} {
  let count = 0;
  let latest: Room | null = null;
  for (const room of rooms) {
    if (!room.list_preferences?.archived) continue;
    count += 1;
    if (
      latest === null ||
      room.list_projection.activity_stream_position >
        latest.list_projection.activity_stream_position ||
      (
        room.list_projection.activity_stream_position ===
          latest.list_projection.activity_stream_position &&
        room.room_id.localeCompare(latest.room_id) > 0
      )
    ) {
      latest = room;
    }
  }
  return { count, latest };
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
