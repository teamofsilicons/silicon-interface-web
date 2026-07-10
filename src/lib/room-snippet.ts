import type { Event } from "./types";

/**
 * A small per-room cache of the most recent events, in localStorage, so a
 * reopened chat paints its last messages instantly instead of waiting for the
 * `api.events` round-trip. The room view writes it while open; the chat page
 * appends incoming websocket events for *closed* rooms so the newly-arrived
 * message is already in the cache when the user opens the chat (no ~1s gap).
 */
// Keep this in lockstep with the room view's initial page size: the cached
// snippet and the first server fetch must cover the same recent messages so
// the cache → server hydration is a near-identical list (no reflow / glitch).
const ROOM_SNIPPET_LIMIT = 30;
// Optimistic rows make an immediate room switch feel instant, but an abandoned
// request must not leave a permanent "waiting" message after a later reopen.
const OPTIMISTIC_SNIPPET_MAX_AGE_MS = 2 * 60_000;

function roomSnippetKey(roomId: string): string {
  return `silicon-interface:room-snippet:${roomId}`;
}

export function readRoomEventSnippet(roomId: string): Event[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(roomSnippetKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; events?: Event[] };
    if (!Array.isArray(parsed.events)) return null;
    const optimisticExpired =
      typeof parsed.savedAt !== "number" ||
      Date.now() - parsed.savedAt > OPTIMISTIC_SNIPPET_MAX_AGE_MS;
    return parsed.events.filter(
      (event) =>
        event &&
        typeof event.event_id === "string" &&
        (!optimisticExpired || !event.event_id.startsWith("temp-")),
    );
  } catch {
    return null;
  }
}

/** Recent timeline rows worth caching. Short-lived optimistic rows are kept. */
function cacheableEvents<T extends Event>(events: T[]): Event[] {
  return events
    .filter((event) => event.type !== "m.progress")
    .slice(-ROOM_SNIPPET_LIMIT)
    .map((event) => {
      // Real events don't need client-only state. Optimistic rows do: it lets
      // RoomView reconcile the placeholder with the eventual server event.
      const { ...rest } = event as Event & Record<string, unknown>;
      if (!event.event_id.startsWith("temp-")) {
        delete (rest as Record<string, unknown>)._status;
        delete (rest as Record<string, unknown>)._clientId;
      }
      return rest as Event;
    });
}

export function saveRoomEventSnippet<T extends Event>(roomId: string, events: T[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      roomSnippetKey(roomId),
      JSON.stringify({ savedAt: Date.now(), events: cacheableEvents(events) }),
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
function eventClientId(event: Event): string | null {
  const local = (event as Event & { _clientId?: unknown })._clientId;
  if (typeof local === "string" && local) return local;
  const content = event.content?.client_id;
  return typeof content === "string" && content ? content : null;
}

export function appendRoomEventSnippet(roomId: string, event: Event): void {
  if (typeof window === "undefined") return;
  if (!event || typeof event.event_id !== "string") return;
  if (event.type === "m.progress") return;
  const existing = readRoomEventSnippet(roomId) ?? [];
  const clientId = eventClientId(event);
  const idx = existing.findIndex(
    (e) =>
      e.event_id === event.event_id ||
      (clientId !== null && eventClientId(e) === clientId),
  );
  if (idx >= 0) {
    const next = [...existing];
    next[idx] = event;
    saveRoomEventSnippet(roomId, next);
    return;
  }
  const next = existing.filter((e) => e.event_id !== event.event_id);
  next.push(event);
  saveRoomEventSnippet(roomId, next);
}
