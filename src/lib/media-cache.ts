import type { MediaObject } from "./types";

/**
 * In-memory (per tab session) cache of resolved media details, keyed by
 * media_id. Timeline rows unmount off-screen, so without this every scroll
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

/**
 * Bytes selected by this tab are already safe to display back to their owner.
 * Keep a bounded local object-URL handoff by media id so replacing the
 * optimistic event with Glass's authoritative event never replaces an instant
 * preview with the malware-scan spinner. Recipients still wait for Glass's
 * clean verdict; this cache never crosses a device or account boundary.
 */
interface LocalMediaPreview {
  url: string;
  createdAt: number;
}

const localPreviews = new Map<string, LocalMediaPreview>();
const MAX_LOCAL_PREVIEWS = 100;
const LOCAL_PREVIEW_TTL_MS = 60 * 60 * 1_000;

function revokeLocalPreview(preview: LocalMediaPreview | undefined): void {
  if (!preview || !preview.url.startsWith("blob:")) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(preview.url);
  }
}

function pruneLocalPreviews(now = Date.now()): void {
  for (const [mediaId, preview] of localPreviews) {
    if (now - preview.createdAt <= LOCAL_PREVIEW_TTL_MS) continue;
    localPreviews.delete(mediaId);
    revokeLocalPreview(preview);
  }
  while (localPreviews.size > MAX_LOCAL_PREVIEWS) {
    const oldest = localPreviews.entries().next().value as
      | [string, LocalMediaPreview]
      | undefined;
    if (!oldest) break;
    localPreviews.delete(oldest[0]);
    revokeLocalPreview(oldest[1]);
  }
}

/** Retain the just-uploaded bytes for an instant optimistic/accepted preview. */
export function retainLocalMediaPreview(mediaId: string, blob: Blob): string | null {
  if (!mediaId || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  const previous = localPreviews.get(mediaId);
  if (previous) return previous.url;
  const url = URL.createObjectURL(blob);
  localPreviews.set(mediaId, { url, createdAt: Date.now() });
  pruneLocalPreviews();
  return url;
}

export function getLocalMediaPreview(mediaId: string | null | undefined): string | null {
  if (!mediaId) return null;
  pruneLocalPreviews();
  return localPreviews.get(mediaId)?.url ?? null;
}

export function evictLocalMediaPreview(mediaId: string | null | undefined): void {
  if (!mediaId) return;
  const preview = localPreviews.get(mediaId);
  localPreviews.delete(mediaId);
  revokeLocalPreview(preview);
}

export interface MediaDetailState {
  value: CachedMedia | null;
  failed: boolean;
  exhausted: boolean;
}

type MediaDetailLoader = () => Promise<CachedMedia>;
type MediaDetailListener = (state: MediaDetailState) => void;

interface MediaDetailQuery {
  mediaId: string;
  loader: MediaDetailLoader;
  listeners: Set<MediaDetailListener>;
  value: CachedMedia | null;
  inflight: Promise<CachedMedia> | null;
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: number;
  attempts: number;
  errors: number;
  failed: boolean;
  exhausted: boolean;
}

const queries = new Map<string, MediaDetailQuery>();
const PENDING_POLL_INTERVAL_MS = 4_000;
const MAX_PENDING_POLLS = 30;
const FAILED_RETRY_INTERVAL_MS = 30_000;

function snapshot(query: MediaDetailQuery): MediaDetailState {
  return {
    value: query.value,
    failed: query.failed,
    exhausted: query.exhausted,
  };
}

function notify(query: MediaDetailQuery): void {
  const state = snapshot(query);
  for (const listener of query.listeners) listener(state);
}

function schedule(query: MediaDetailQuery, delay: number): void {
  if (query.timer !== null || query.exhausted) return;
  query.nextRunAt = Date.now() + Math.max(0, delay);
  if (!query.listeners.size) return;
  query.timer = setTimeout(() => {
    query.timer = null;
    query.nextRunAt = 0;
    void runQuery(query);
  }, delay);
}

async function runQuery(query: MediaDetailQuery, force = false): Promise<CachedMedia | null> {
  if (query.inflight) return query.inflight.catch(() => null);
  const ready = cache.get(query.mediaId) ?? null;
  if (!force && ready) {
    query.value = ready;
    query.failed = false;
    query.exhausted = false;
    query.nextRunAt = 0;
    notify(query);
    return ready;
  }

  const request = query.loader();
  query.inflight = request;
  let nextDelay: number | null = null;
  try {
    const value = await request;
    query.value = value;
    query.errors = 0;
    query.failed = false;
    setCachedMedia(query.mediaId, value);
    const stillPending = value.media.status === "pending" && !value.download_url;
    if (stillPending) {
      query.attempts += 1;
      if (query.attempts >= MAX_PENDING_POLLS) query.exhausted = true;
      else nextDelay = PENDING_POLL_INTERVAL_MS;
    } else {
      query.attempts = 0;
      query.exhausted = false;
      query.nextRunAt = 0;
    }
    return value;
  } catch {
    query.errors += 1;
    query.failed = query.errors >= 4 && !query.value?.download_url;
    nextDelay = query.failed
      ? FAILED_RETRY_INTERVAL_MS
      : 1_000 * query.errors;
    return null;
  } finally {
    query.inflight = null;
    notify(query);
    if (nextDelay !== null) schedule(query, nextDelay);
  }
}

/** One request/poll loop per object, shared by every mounted timeline copy. */
export function subscribeMediaDetail(
  mediaId: string,
  loader: MediaDetailLoader,
  listener: MediaDetailListener,
): () => void {
  let query = queries.get(mediaId);
  if (!query) {
    query = {
      mediaId,
      loader,
      listeners: new Set(),
      value: cache.get(mediaId) ?? null,
      inflight: null,
      timer: null,
      nextRunAt: 0,
      attempts: 0,
      errors: 0,
      failed: false,
      exhausted: false,
    };
    queries.set(mediaId, query);
  } else {
    query.loader = loader;
  }
  query.listeners.add(listener);
  queueMicrotask(() => {
    if (query?.listeners.has(listener)) listener(snapshot(query));
  });
  if (!query.value?.download_url && !query.exhausted) {
    const remainingDelay = Math.max(0, query.nextRunAt - Date.now());
    if (remainingDelay > 0) schedule(query, remainingDelay);
    else void runQuery(query);
  }

  return () => {
    query?.listeners.delete(listener);
    if (query && query.listeners.size === 0 && query.timer !== null) {
      clearTimeout(query.timer);
      query.timer = null;
    }
    if (
      query &&
      query.listeners.size === 0 &&
      query.inflight === null &&
      query.value?.media.status === "ready" &&
      Boolean(query.value.download_url)
    ) {
      queries.delete(mediaId);
    }
  };
}

/** Force one metadata refresh for an expired signed download URL. */
export async function refreshMediaDetail(
  mediaId: string,
  loader: MediaDetailLoader,
): Promise<CachedMedia | null> {
  let query = queries.get(mediaId);
  if (!query) {
    query = {
      mediaId,
      loader,
      listeners: new Set(),
      value: cache.get(mediaId) ?? null,
      inflight: null,
      timer: null,
      nextRunAt: 0,
      attempts: 0,
      errors: 0,
      failed: false,
      exhausted: false,
    };
    queries.set(mediaId, query);
  } else {
    query.loader = loader;
  }
  query.failed = false;
  query.exhausted = false;
  query.nextRunAt = 0;
  return runQuery(query, true);
}

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

/**
 * Apply a server-pushed scan result to every mounted copy immediately. This
 * removes the old four-second polling tail after ClamAV has already finished.
 */
export function acceptMediaDetail(
  mediaId: string | null | undefined,
  value: CachedMedia,
): void {
  if (!mediaId) return;
  setCachedMedia(mediaId, value);
  const query = queries.get(mediaId);
  if (!query) return;
  if (query.timer !== null) clearTimeout(query.timer);
  query.timer = null;
  query.nextRunAt = 0;
  query.attempts = 0;
  query.errors = 0;
  query.failed = false;
  query.exhausted = false;
  query.value = value;
  notify(query);
}

/** A redaction revokes the session's signed capability immediately. */
export function evictCachedMedia(mediaId: string | null | undefined): void {
  if (!mediaId) return;
  cache.delete(mediaId);
  evictLocalMediaPreview(mediaId);
  const query = queries.get(mediaId);
  if (query?.timer) clearTimeout(query.timer);
  queries.delete(mediaId);
}
