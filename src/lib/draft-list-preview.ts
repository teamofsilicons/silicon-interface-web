export type DraftListPreview = {
  active: boolean;
  text: string;
  updatedAt: string;
  originDevice: string;
};

export function draftListPreviewText(
  text: string,
  attachmentCount: number,
  hasReply: boolean,
): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact) return compact.slice(0, 150);
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? "Attachment" : `${attachmentCount} attachments`;
  }
  return hasReply ? "Reply" : "";
}

export function draftListPreviewVisible(
  draft: DraftListPreview,
  unreadCount: number,
  lastMessageAt: string | null | undefined,
): boolean {
  if (!draft.active) return false;
  if (unreadCount <= 0 || !lastMessageAt || !draft.updatedAt) return true;
  const draftAt = Date.parse(draft.updatedAt);
  const messageAt = Date.parse(lastMessageAt);
  if (!Number.isFinite(draftAt) || !Number.isFinite(messageAt)) return true;
  return draftAt >= messageAt;
}
