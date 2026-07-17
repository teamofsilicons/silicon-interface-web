import { mergeDeliverySummaries } from "./delivery-state";
import type { Event } from "./types";

function editVersion(event: Event): number {
  return Number.isSafeInteger(event.edit_version) && Number(event.edit_version) >= 0
    ? Number(event.edit_version)
    : 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRedacted(event: Event): boolean {
  return Boolean(event.redacted_at || event.content?.redacted === true);
}

/** A slow snapshot must never overwrite a newer edit or undo a redaction. */
export function incomingEventRevisionIsCurrent(current: Event, incoming: Event): boolean {
  if (current.event_id !== incoming.event_id) return true;
  const currentRedacted = isRedacted(current);
  const incomingRedacted = isRedacted(incoming);
  if (currentRedacted !== incomingRedacted) return incomingRedacted;
  const currentVersion = editVersion(current);
  const incomingVersion = editVersion(incoming);
  if (currentVersion !== incomingVersion) return incomingVersion > currentVersion;
  const currentEditedAt = timestamp(current.edited_at);
  const incomingEditedAt = timestamp(incoming.edited_at);
  if (currentEditedAt !== incomingEditedAt) return incomingEditedAt > currentEditedAt;
  return true;
}

/** Merge one event identity without allowing any final state to regress. */
export function mergeEventRevision<T extends Event>(current: T, incoming: T): T {
  if (current.event_id !== incoming.event_id) return incoming;
  const winner = incomingEventRevisionIsCurrent(current, incoming) ? incoming : current;
  const loser = winner === incoming ? current : incoming;
  const delivery = mergeDeliverySummaries(current.delivery, incoming.delivery);
  const sameBody = JSON.stringify(current.content) === JSON.stringify(incoming.content);
  const merged = {
    ...loser,
    ...winner,
    is_final: current.is_final !== false || incoming.is_final !== false,
    can_unsend: current.can_unsend === false || incoming.can_unsend === false
      ? false
      : winner.can_unsend,
    ...(delivery ? { delivery } : {}),
    ...(sameBody && !winner.link_preview && loser.link_preview
      ? { link_preview: loser.link_preview }
      : {}),
    ...(sameBody && !winner.media_meta && loser.media_meta
      ? { media_meta: loser.media_meta }
      : {}),
    ...(sameBody && !winner.media_items && loser.media_items
      ? { media_items: loser.media_items }
      : {}),
  } as T;

  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith("_") && value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
