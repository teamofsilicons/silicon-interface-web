"use client";

/**
 * Global event cursor — the max event_id this client has SEEN across all
 * visible rooms (initial room loads, live WS `event` frames, sync pages, and
 * the rooms list's `last_event` projections). Persisted per-user so a
 * reconnect (or a fresh page load) can backfill the gap via
 * GET /api/v1/events/sync?after=<cursor> instead of relying purely on the
 * rooms refetch.
 *
 * Event ids are Crockford ULIDs — fixed-width, so lexicographic max IS
 * chronological max. Anything that doesn't look like a ULID (temp- optimistic
 * ids, UUID fallbacks) is ignored: letting one in would poison the compare
 * and could pin the cursor in the future forever.
 */

const PREFIX = "silicon-interface:event-cursor";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

export function getEventCursor(ownerId: string): string | null {
  if (typeof window === "undefined" || !ownerId) return null;
  try {
    const v = window.localStorage.getItem(key(ownerId));
    return v && ULID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Monotonic: only ever moves the cursor forward. Non-ULID ids are no-ops. */
export function advanceEventCursor(ownerId: string, eventId: string | null | undefined): void {
  if (typeof window === "undefined" || !ownerId || !eventId || !ULID_RE.test(eventId)) return;
  try {
    const cur = window.localStorage.getItem(key(ownerId));
    if (!cur || !ULID_RE.test(cur) || eventId > cur) {
      window.localStorage.setItem(key(ownerId), eventId);
    }
  } catch {
    /* storage unavailable — cursor resync just won't run */
  }
}
