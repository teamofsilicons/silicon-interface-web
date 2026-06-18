import type { Event } from "./types";

/**
 * A small per-room cache of the most recent events, in localStorage, so a
 * reopened chat paints its last messages instantly instead of waiting for the
 * `api.events` round-trip. The room view writes it while open; the chat page
 * appends incoming websocket events for *closed* rooms so the newly-arrived
 * message is already in the cache when the user opens the chat (no ~1s gap).
 */
const ROOM_SNIPPET_LIMIT = 40;

function roomSnippetKey(roomId: string): string {
  return `silicon-interface:room-snippet:${roomId}`;
}

export function readRoomEventSnippet(roomId: string): Event[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(roomSnippetKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: Event[] };
    if (!Array.isArray(parsed.events)) return null;
    return parsed.events.filter((event) => event && typeof event.event_id === "string");
  } catch {
    return null;
  }
}

/** Durable subset of events worth caching (no optimistic temps / progress). */
function durableEvents<T extends Event>(events: T[]): Event[] {
  return events
    .filter((event) => !event.event_id.startsWith("temp-") && event.type !== "m.progress")
    .slice(-ROOM_SNIPPET_LIMIT)
    .map((event) => {
      // Strip any client-only fields (_status / _clientId) before persisting.
      const { ...rest } = event as Event & Record<string, unknown>;
      delete (rest as Record<string, unknown>)._status;
      delete (rest as Record<string, unknown>)._clientId;
      return rest as Event;
    });
}

export function saveRoomEventSnippet<T extends Event>(roomId: string, events: T[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      roomSnippetKey(roomId),
      JSON.stringify({ savedAt: Date.now(), events: durableEvents(events) }),
    );
  } catch {
    /* Keep chat usable when localStorage is unavailable or full. */
  }
}

/**
 * Append a single freshly-received event to a room's cached snippet, deduping
 * by event_id (a later copy wins, e.g. a finalized version of an optimistic
 * send). Used by the chat page for rooms that aren't currently open.
 */
export function appendRoomEventSnippet(roomId: string, event: Event): void {
  if (typeof window === "undefined") return;
  if (!event || typeof event.event_id !== "string") return;
  if (event.event_id.startsWith("temp-") || event.type === "m.progress") return;
  const existing = readRoomEventSnippet(roomId) ?? [];
  const next = existing.filter((e) => e.event_id !== event.event_id);
  next.push(event);
  saveRoomEventSnippet(roomId, next);
}
