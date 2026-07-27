import type { Event } from "./types";
import type { OutboxEntry } from "./outbox";

export const ALBUM_MIN_ITEMS = 2;
export const ALBUM_MAX_ITEMS = 10;
export const ALBUM_CAPTION_MAX = 4_000;
export const ALBUM_FILENAME_MAX = 255;

export interface AlbumDraftItem {
  mediaId: string;
  filename: string;
}

export interface AlbumMediaItem {
  position: number;
  media_id: string;
  filename: string;
  kind?: "file" | "image";
  mime?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  status?: "pending" | "ready" | "failed";
}

function canonicalAlbumFilename(raw: string, index: number): string {
  const printable = raw.replace(/[\u0000-\u001f]/g, "").trim();
  const codePoints = Array.from(printable || `attachment-${index + 1}`);
  return codePoints.slice(0, ALBUM_FILENAME_MAX).join("");
}

/** Build the one immutable album payload used by the outbox, optimistic row,
 * retry path, and Glass. Order is meaningful and captions always belong to
 * item zero; callers must not split this payload into per-file events. */
export function buildAlbumContent(
  items: AlbumDraftItem[],
  caption: string,
): Record<string, unknown> {
  if (items.length < ALBUM_MIN_ITEMS || items.length > ALBUM_MAX_ITEMS) {
    throw new Error(`An album needs ${ALBUM_MIN_ITEMS}-${ALBUM_MAX_ITEMS} attachments`);
  }
  const ids = items.map((item) => item.mediaId.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("Every album attachment must be ready and unique");
  }
  if (Array.from(caption).length > ALBUM_CAPTION_MAX) {
    throw new Error(`An album caption can contain at most ${ALBUM_CAPTION_MAX} characters`);
  }
  return {
    caption,
    caption_item_index: 0,
    items: items.map((item, index) => ({
      media_id: ids[index],
      filename: canonicalAlbumFilename(item.filename, index),
    })),
  };
}

/** Server responses carry authoritative media metadata. Optimistic/restored
 * rows can fall back to the immutable content manifest until that arrives. */
export function albumMediaItems(
  event: Pick<Event, "content" | "media_items">,
): AlbumMediaItem[] {
  if (Array.isArray(event.media_items) && event.media_items.length > 0) {
    return [...event.media_items].sort((left, right) => left.position - right.position);
  }
  const raw = Array.isArray(event.content.items) ? event.content.items : [];
  return raw.flatMap((value, position) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const mediaId = typeof item.media_id === "string" ? item.media_id : "";
    if (!mediaId) return [];
    return [{
      position,
      media_id: mediaId,
      filename: typeof item.filename === "string" ? item.filename : "",
    }];
  });
}

/** Strictly extract the immutable media identities from one album manifest. */
export function albumContentMediaIds(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const items = (content as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const mediaId = (value as Record<string, unknown>).media_id;
    if (typeof mediaId !== "string" || !mediaId || mediaId !== mediaId.trim()) continue;
    if (seen.has(mediaId)) continue;
    seen.add(mediaId);
    ids.push(mediaId);
  }
  return ids;
}

/**
 * Media already owned by a durable album outbox must not reappear as sendable
 * draft chips after a crash between outbox commit and upload-row cleanup.
 */
export function albumMediaIdsOwnedByOutbox(
  entries: readonly Pick<OutboxEntry, "roomId" | "type" | "content">[],
  roomId: string,
): Set<string> {
  const owned = new Set<string>();
  for (const entry of entries) {
    if (entry.roomId !== roomId || entry.type !== "m.album") continue;
    for (const mediaId of albumContentMediaIds(entry.content)) owned.add(mediaId);
  }
  return owned;
}
