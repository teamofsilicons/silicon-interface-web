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
  /** Carbon message this run is working on — anchors the status under it. */
  anchorEventId?: string | null;
}

// A progress line older than this is treated as dead on reopen — a silicon that
// crashed without a `done` frame shouldn't leave a stale line forever.
export const PROGRESS_CACHE_TTL_MS = 120_000;

// Backed by sessionStorage so an in-flight task survives a page refresh (same
// tab). The server never replays progress frames, so without this a refresh
// would lose all knowledge of what's working until the next frame arrives.
const STORAGE_KEY = "silicon-interface:room-progress";

const cache = new Map<string, CachedProgressEntry>();

let hydrated = false;
function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, CachedProgressEntry>;
    for (const [roomId, entry] of Object.entries(obj)) cache.set(roomId, entry);
  } catch {
    // corrupt / unavailable storage — start empty
  }
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(cache)),
    );
  } catch {
    // quota / unavailable — in-memory cache still works for this session
  }
}

export function setRoomProgress(roomId: string, entry: CachedProgressEntry): void {
  ensureHydrated();
  cache.set(roomId, entry);
  persist();
}

export function clearRoomProgress(roomId: string): void {
  ensureHydrated();
  if (cache.delete(roomId)) persist();
}

export function getRoomProgress(roomId: string): CachedProgressEntry | null {
  ensureHydrated();
  const entry = cache.get(roomId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > PROGRESS_CACHE_TTL_MS) {
    cache.delete(roomId);
    persist();
    return null;
  }
  return entry;
}
