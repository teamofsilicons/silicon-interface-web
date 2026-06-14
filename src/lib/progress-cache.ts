import type { ProgressState } from "./types";

/**
 * Per-room "is a silicon working?" cache, scoped to the current tab session.
 *
 * Live progress (`m.progress` frames) is otherwise only tracked inside the
 * mounted room view, so closing a chat and reopening it — or progress that
 * arrives entirely while the chat is closed — would leave the reopened room
 * with no progress line until the *next* frame happens to land (which can be a
 * long gap). The chat page writes every server progress frame here (it stays
 * mounted and sees all frames), and the room view seeds its progress line from
 * this cache on open so an in-flight task shows immediately.
 */
export interface CachedProgressEntry {
  roomId: string;
  groupId: string;
  state: ProgressState;
  note: string;
  updatedAt: number;
  source: "local" | "server";
  pct?: number | null;
  handle?: string | null;
  receipt?: "sent" | "read";
}

// A progress line older than this is treated as dead on reopen — a silicon that
// crashed without a `done` frame shouldn't leave a stale line forever.
export const PROGRESS_CACHE_TTL_MS = 120_000;

const cache = new Map<string, CachedProgressEntry>();

export function setRoomProgress(roomId: string, entry: CachedProgressEntry): void {
  cache.set(roomId, entry);
}

export function clearRoomProgress(roomId: string): void {
  cache.delete(roomId);
}

export function getRoomProgress(roomId: string): CachedProgressEntry | null {
  const entry = cache.get(roomId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > PROGRESS_CACHE_TTL_MS) {
    cache.delete(roomId);
    return null;
  }
  return entry;
}
