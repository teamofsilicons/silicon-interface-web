"use client";

/**
 * Persisted outbox for plain text sends — a per-user localStorage queue of
 * messages that have been handed to the send pipeline but not yet acked by
 * the server. Glass's POST /rooms/{id}/events is idempotent per
 * `content.client_id` (a re-POST of the same client_id returns the ORIGINAL
 * event instead of duplicating), so flushing this queue after a crash,
 * reload, or reconnect is safe: at-least-once delivery with exactly-once
 * storage.
 *
 * Lifecycle: `enqueueOutbox` right before the POST, `ackOutbox` on success.
 * On failure the entry simply STAYS — that's the retry state the flusher
 * (chat page mount + socket reconnect) and the failed-bubble tap-to-retry
 * both re-POST from.
 */

const PREFIX = "silicon-interface:outbox";
/** Entries older than this are abandoned — the moment has passed. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Hard cap so a broken backend can't grow the queue unboundedly. */
const MAX_ENTRIES = 50;

export interface OutboxEntry {
  roomId: string;
  clientId: string;
  body: string;
  /** reply_to_event_id, when the send quoted another message. */
  replyTo?: string;
  /** Enqueue time (epoch ms) — drives the 48h prune. */
  at: number;
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function read(ownerId: string): OutboxEntry[] {
  if (typeof window === "undefined" || !ownerId) return [];
  try {
    const raw = window.localStorage.getItem(key(ownerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is OutboxEntry =>
        !!e &&
        typeof e === "object" &&
        typeof (e as OutboxEntry).roomId === "string" &&
        typeof (e as OutboxEntry).clientId === "string" &&
        typeof (e as OutboxEntry).body === "string" &&
        typeof (e as OutboxEntry).at === "number",
    );
  } catch {
    return [];
  }
}

function write(ownerId: string, entries: OutboxEntry[]) {
  if (typeof window === "undefined" || !ownerId) return;
  try {
    window.localStorage.setItem(key(ownerId), JSON.stringify(entries));
  } catch {
    /* quota / private mode — the queue is best-effort */
  }
}

/** Drop stale entries (>48h) and cap at the newest MAX_ENTRIES. */
function prune(entries: OutboxEntry[]): OutboxEntry[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh = entries.filter((e) => e.at >= cutoff);
  return fresh.length > MAX_ENTRIES ? fresh.slice(fresh.length - MAX_ENTRIES) : fresh;
}

export function enqueueOutbox(ownerId: string, entry: OutboxEntry): void {
  if (typeof window === "undefined" || !ownerId) return;
  // Re-enqueueing the same clientId (a retry) replaces the old entry.
  const next = prune(read(ownerId)).filter((e) => e.clientId !== entry.clientId);
  next.push(entry);
  write(ownerId, prune(next));
}

export function ackOutbox(ownerId: string, clientId: string): void {
  if (typeof window === "undefined" || !ownerId) return;
  const cur = read(ownerId);
  const next = cur.filter((e) => e.clientId !== clientId);
  if (next.length !== cur.length) write(ownerId, next);
}

/** Pending entries, oldest first (persisting the prune as a side effect). */
export function listOutbox(ownerId: string): OutboxEntry[] {
  const cur = read(ownerId);
  const pruned = prune(cur);
  if (pruned.length !== cur.length) write(ownerId, pruned);
  return pruned;
}
