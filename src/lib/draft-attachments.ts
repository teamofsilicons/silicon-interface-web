"use client";

import {
  getDraftAttachments as getCloudDraftAttachments,
  setDraftAttachments as setCloudDraftAttachments,
} from "./drafts";
import type { DraftAttachment } from "./types";

export interface PersistedAttachment {
  id: string;
  mediaId: string;
  mime: string;
  name: string;
  size: number;
}

export function getDraftAttachments(roomId: string): PersistedAttachment[] {
  return getCloudDraftAttachments(roomId).map((a) => ({
    id: a.id || a.mediaId,
    mediaId: a.mediaId,
    mime: a.mime,
    name: a.name,
    size: a.size ?? 0,
  }));
}

export function setDraftAttachments(roomId: string, list: PersistedAttachment[]): void {
  setCloudDraftAttachments(roomId, list as DraftAttachment[]);
}
