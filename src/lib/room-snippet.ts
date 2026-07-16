import type { Event } from "./types";
import type { TimelineEvent } from "./timeline-identity";

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
// Keep retryable optimistic rows for the same lifetime as the persisted text
// outbox. Their own send deadline turns "pending" into "failed" on reopen;
// dropping them after two minutes used to erase the retry for large uploads.
const OPTIMISTIC_SNIPPET_MAX_AGE_MS = 48 * 60 * 60_000;

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
    return parsed.events.filter(
      (event) => {
        if (!event || typeof event.event_id !== "string") return false;
        if (!event.event_id.startsWith("temp-")) return true;
        const createdAt = Date.parse(event.created_at);
        const base = Number.isFinite(createdAt) ? createdAt : parsed.savedAt;
        return (
          typeof base === "number" && Date.now() - base <= OPTIMISTIC_SNIPPET_MAX_AGE_MS
        );
      },
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
      // Real events keep their receipt status and immutable local identity so
      // reopening a room uses the same React key, order, and authored timestamp
      // that the optimistic row had before Glass accepted it.
      const { ...rest } = event as Event & Record<string, unknown>;
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
  const local = (event as TimelineEvent)._clientId;
  if (typeof local === "string" && local) return local;
  const transaction = event.transaction_id;
  return typeof transaction === "string" && transaction ? transaction : null;
}

export function appendRoomEventSnippet(roomId: string, event: Event): void {
  if (typeof window === "undefined") return;
  if (!event || typeof event.event_id !== "string") return;
  if (event.type === "m.progress") return;
  const existing = readRoomEventSnippet(roomId) ?? [];
  const clientId = eventClientId(event);
  const localKey = (event as TimelineEvent)._localKey;
  const matches = existing
    .map((candidate, index) => ({ candidate: candidate as TimelineEvent, index }))
    .filter(
      ({ candidate }) =>
        candidate.event_id === event.event_id ||
        (typeof localKey === "string" && localKey && candidate._localKey === localKey) ||
        (clientId !== null && candidate._clientId === clientId),
    )
    .map(({ index }) => index);
  const idx =
    matches.find((index) => Boolean((existing[index] as TimelineEvent)._localKey)) ??
    matches[0] ??
    -1;
  if (idx >= 0) {
    const local = existing[idx] as TimelineEvent;
    const authoritativeAt = (event as TimelineEvent)._authoritativeCreatedAt ?? event.created_at;
    const reconciled: TimelineEvent = {
      ...event,
      _localKey: local._localKey ?? (event as TimelineEvent)._localKey,
      _localSequence: local._localSequence ?? (event as TimelineEvent)._localSequence,
      _originDevice: local._originDevice ?? (event as TimelineEvent)._originDevice,
      _localCreatedAt: local._localCreatedAt ?? (event as TimelineEvent)._localCreatedAt,
      _authoritativeCreatedAt: authoritativeAt,
      _clientId: local._clientId ?? clientId ?? undefined,
      created_at:
        local._localCreatedAt ??
        (event as TimelineEvent)._localCreatedAt ??
        event.created_at,
    };
    const next = [...existing];
    next[idx] = reconciled;
    for (const duplicate of matches.sort((left, right) => right - left)) {
      if (duplicate !== idx) next.splice(duplicate, 1);
    }
    saveRoomEventSnippet(roomId, next);
    return;
  }
  const next = existing.filter((e) => e.event_id !== event.event_id);
  next.push(event);
  saveRoomEventSnippet(roomId, next);
}
