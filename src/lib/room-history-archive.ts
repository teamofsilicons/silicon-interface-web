import type { Event, HistoryPage } from "./types";

export const COMPLETE_HISTORY_PAGE_SIZE = 200;

type HistoryPageLoader = (
  roomId: string,
  cursor: string,
  limit: number,
) => Promise<HistoryPage>;

function compareEvents(left: Event, right: Event): number {
  if (
    Number.isSafeInteger(left.stream_position) &&
    Number.isSafeInteger(right.stream_position) &&
    left.stream_position !== right.stream_position
  ) {
    return Number(left.stream_position) - Number(right.stream_position);
  }
  const leftAccepted = !left.event_id.startsWith("temp-");
  const rightAccepted = !right.event_id.startsWith("temp-");
  if (leftAccepted && rightAccepted && left.event_id !== right.event_id) {
    return left.event_id.localeCompare(right.event_id);
  }
  const timeOrder = left.created_at.localeCompare(right.created_at);
  return timeOrder || left.event_id.localeCompare(right.event_id);
}

/** Merge a fixed history traversal with a live room projection without showing duplicates. */
export function mergeRoomHistoryEvents(...collections: readonly Event[][]): Event[] {
  const byId = new Map<string, Event>();
  for (const collection of collections) {
    for (const event of collection) byId.set(event.event_id, event);
  }
  return [...byId.values()].sort(compareEvents);
}

/**
 * Walk the room's signed backward cursor until Glass proves there are no older
 * rows. The profile attachment browser uses this instead of mistaking the
 * currently rendered timeline window for the complete conversation.
 */
export async function loadCompleteRoomHistory(
  roomId: string,
  loadPage: HistoryPageLoader,
  onProgress?: (events: Event[]) => void,
): Promise<Event[]> {
  const pages: Event[][] = [];
  const seenCursors = new Set<string>();
  let cursor = "";

  while (true) {
    const page = await loadPage(roomId, cursor, COMPLETE_HISTORY_PAGE_SIZE);
    pages.unshift(page.events);
    const collected = mergeRoomHistoryEvents(...pages);
    onProgress?.(collected);

    if (!page.has_more) return collected;
    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new Error("Room history continuation did not make progress.");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
}
