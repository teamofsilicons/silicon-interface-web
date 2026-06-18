import type { MediaObject } from "./types";

/**
 * In-memory (per tab session) cache of resolved media details, keyed by
 * media_id. Virtuoso unmounts off-screen rows, so without this every scroll
 * back to an image re-fired `api.mediaDetail`, flashed a spinner, then snapped
 * the bubble to the real aspect ratio when the dimensions finally arrived —
 * the main source of "the timeline jumps around while I scroll".
 *
 * We only cache fully-ready objects that already have a usable download URL, so
 * pending/processing media keep polling normally. Presigned URLs are long-lived
 * enough for a session; a stale one still self-heals via the on-error refetch.
 */
export interface CachedMedia {
  media: MediaObject;
  download_url: string | null;
}

const cache = new Map<string, CachedMedia>();

export function getCachedMedia(mediaId: string | null | undefined): CachedMedia | null {
  if (!mediaId) return null;
  return cache.get(mediaId) ?? null;
}

export function setCachedMedia(mediaId: string | null | undefined, value: CachedMedia): void {
  if (!mediaId) return;
  if (!value.download_url) return;
  if (value.media?.status && value.media.status !== "ready") return;
  cache.set(mediaId, value);
}
