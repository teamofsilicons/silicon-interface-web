import type { Event } from "./types";

export function editableTextForEvent(event: Pick<Event, "type" | "content">): string | null {
  if (event.type === "m.text") return String(event.content.body ?? "");
  if (event.type === "m.image" || event.type === "m.file" || event.type === "m.album") {
    return String(event.content.caption ?? "");
  }
  return null;
}

export function editedContentForEvent(
  event: Pick<Event, "type" | "content">,
  nextText: string,
): Record<string, unknown> {
  const content = { ...(event.content ?? {}) };
  if (event.type === "m.text") content.body = nextText;
  else if (event.type === "m.image" || event.type === "m.file" || event.type === "m.album") {
    content.caption = nextText;
  }
  return content;
}

export function withEditedText<T extends Event>(
  event: T,
  nextText: string,
  editedAt: string,
): T {
  return {
    ...event,
    content: editedContentForEvent(event, nextText),
    edited_at: editedAt,
  };
}

export function eventShowsEdited(event: Pick<Event, "edited_at" | "content">): boolean {
  return Boolean(event.edited_at || event.content.edited_before_send);
}
