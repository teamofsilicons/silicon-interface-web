import type { Event } from "@/lib/types";
import { mergeEventRevision } from "@/lib/event-revision";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Keep the browser's recent/offline projection identical to Glass.content_text. */
export function searchableEventText(event: Event): string {
  if (event.redacted_at || event.content?.redacted === true) return "";
  const content = event.content ?? {};
  switch (event.type) {
    case "m.text":
      return text(content.body);
    case "m.voice":
      return text(content.transcript) || text(content.caption);
    case "m.tts":
      return text(content.text);
    case "m.image":
    case "m.file":
    case "m.album":
      return text(content.caption);
    case "m.remote_browser":
      return text(content.url);
    case "m.system":
    case "m.session_marker":
      return text(content.body) || text(content.summary);
    default:
      return "";
  }
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().normalize("NFC").toLowerCase();
}

/** Search the already hydrated durable room window before Glass is reachable. */
export function recentLocalSearch<T extends Event>(events: T[], query: string): T[] {
  const needle = normalizeSearchQuery(query);
  if (!needle) return [];
  return events
    .filter((event) => searchableEventText(event).normalize("NFC").toLowerCase().includes(needle))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

/** Append a keyset page without allowing retries/overlap to duplicate a row. */
export function mergeSearchPage<T extends Event>(existing: T[], page: T[]): T[] {
  const byId = new Map(existing.map((event) => [event.event_id, event]));
  for (const event of page) {
    const current = byId.get(event.event_id);
    byId.set(event.event_id, current ? mergeEventRevision(current, event) : event);
  }
  return [...byId.values()].sort((left, right) => right.created_at.localeCompare(left.created_at));
}
