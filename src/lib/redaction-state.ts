import type { Event } from "@/lib/types";

export interface RedactionProjection<T extends Event> {
  event: T;
  mediaIds: string[];
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Build the only local projection allowed for a redacted event. Timeline,
 * sender, reply/thread, delivery, and transaction identity stay stable, while
 * every body-bearing or remotely fetchable field is removed immediately.
 */
export function projectRedactedEvent<T extends Event>(
  source: T,
  redactedAt: string,
  reason = "redacted",
): RedactionProjection<T> {
  if (!nonBlank(redactedAt)) throw new Error("A redaction timestamp is required");
  const mediaIds = new Set<string>();
  if (nonBlank(source.content?.media_id)) mediaIds.add(source.content.media_id);
  const contentItems = Array.isArray(source.content?.items) ? source.content.items : [];
  for (const item of contentItems) {
    if (item && typeof item === "object" && nonBlank((item as { media_id?: unknown }).media_id)) {
      mediaIds.add((item as { media_id: string }).media_id);
    }
  }
  for (const item of source.media_items ?? []) {
    if (nonBlank(item.media_id)) mediaIds.add(item.media_id);
  }

  return {
    event: {
      ...source,
      content: { redacted: true, reason },
      media_items: null,
      media_meta: null,
      link_preview: null,
      redacted_at: redactedAt,
      redaction_reason: reason,
    },
    mediaIds: [...mediaIds],
  };
}

export function projectRedactedWindow<T extends Event>(
  events: T[],
  eventIds: Iterable<string>,
  redactedAt: string,
  reason = "redacted",
): { events: T[]; changed: T[]; mediaIds: string[] } {
  const targets = new Set(eventIds);
  const changed: T[] = [];
  const mediaIds = new Set<string>();
  const projected = events.map((event) => {
    if (!targets.has(event.event_id)) return event;
    const next = projectRedactedEvent(event, redactedAt, reason);
    changed.push(next.event);
    next.mediaIds.forEach((id) => mediaIds.add(id));
    return next.event;
  });
  return { events: projected, changed, mediaIds: [...mediaIds] };
}
