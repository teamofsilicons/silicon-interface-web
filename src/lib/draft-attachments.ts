"use client";

/**
 * Per-room persistence of *uploaded* draft attachments, so staging files and
 * then switching chats / refreshing doesn't lose them. We can only persist
 * attachments that already finished uploading (they have a media_id) — the raw
 * File bytes of an in-flight upload can't be stashed in localStorage. On
 * restore the row shows from its stored name/size/mime and sends via media_id.
 */
export interface PersistedAttachment {
  id: string;
  mediaId: string;
  mime: string;
  name: string;
  size: number;
}

const PREFIX = "silicon-interface:draft-att:";
const key = (roomId: string) => `${PREFIX}${roomId}`;

export function getDraftAttachments(roomId: string): PersistedAttachment[] {
  if (typeof window === "undefined" || !roomId) return [];
  try {
    const raw = window.localStorage.getItem(key(roomId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as PersistedAttachment[];
    return Array.isArray(arr) ? arr.filter((a) => a && a.mediaId && a.id) : [];
  } catch {
    return [];
  }
}

export function setDraftAttachments(roomId: string, list: PersistedAttachment[]): void {
  if (typeof window === "undefined" || !roomId) return;
  try {
    if (list.length) window.localStorage.setItem(key(roomId), JSON.stringify(list));
    else window.localStorage.removeItem(key(roomId));
  } catch {
    /* quota / unavailable — non-fatal */
  }
}
