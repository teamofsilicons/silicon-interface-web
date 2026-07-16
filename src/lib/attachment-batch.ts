export const MAX_COMPOSER_ATTACHMENTS = 10;

export interface AttachmentBatch<T> {
  accepted: T[];
  rejected: number;
}

/**
 * Preserve the OS/browser order of a picker, paste, or drop batch while
 * applying the one shared composer limit. Keeping this policy outside the UI
 * prevents platform-specific paths from silently retaining only the first
 * file.
 */
export function planAttachmentBatch<T>(
  incoming: ArrayLike<T> | readonly T[] | null | undefined,
  currentCount: number,
  limit = MAX_COMPOSER_ATTACHMENTS,
): AttachmentBatch<T> {
  const items = incoming ? Array.from(incoming as ArrayLike<T>) : [];
  const used = Number.isFinite(currentCount) ? Math.max(0, Math.trunc(currentCount)) : limit;
  const capacity = Math.max(0, Math.trunc(limit) - used);
  const accepted = items.slice(0, capacity);
  return { accepted, rejected: items.length - accepted.length };
}
