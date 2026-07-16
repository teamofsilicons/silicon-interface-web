import type { Event, ThreadPage } from "./types";

const HIDDEN_THREAD_TYPES = new Set(["m.reaction", "m.progress", "m.session_marker", "m.system"]);

export function seedLocalThreadPage(
  timeline: readonly Event[],
  targetEventId: string,
): ThreadPage | null {
  const target = timeline.find((event) => event.event_id === targetEventId);
  const rootEventId = target?.thread_root_event_id || target?.event_id || targetEventId;
  const root = timeline.find((event) => event.event_id === rootEventId);
  if (!root || HIDDEN_THREAD_TYPES.has(root.type)) return null;
  const events = timeline.filter((event) =>
    event.thread_root_event_id === rootEventId && !HIDDEN_THREAD_TYPES.has(event.type)
  ).sort((a, b) => a.event_id.localeCompare(b.event_id));
  return {
    root,
    events,
    cursor: null,
    has_more: false,
    through_event_id: events.at(-1)?.event_id ?? null,
    reply_count: events.length,
    unread_count: 0,
  };
}

export function mergeOlderThreadPage(current: ThreadPage, older: ThreadPage): ThreadPage {
  if (
    current.root.event_id !== older.root.event_id ||
    current.through_event_id !== older.through_event_id
  ) {
    throw new Error("thread page changed its fixed history boundary");
  }
  const byId = new Map<string, Event>();
  for (const event of [...older.events, ...current.events]) byId.set(event.event_id, event);
  return {
    ...current,
    root: older.root,
    events: [...byId.values()].sort((a, b) => a.event_id.localeCompare(b.event_id)),
    cursor: older.cursor,
    has_more: older.has_more,
    reply_count: older.reply_count,
    unread_count: older.unread_count,
  };
}

export function projectLiveThreadEvents(
  current: ThreadPage,
  timeline: readonly Event[],
): ThreadPage {
  const root = timeline.find((event) => event.event_id === current.root.event_id) ?? current.root;
  const byId = new Map(current.events.map((event) => [event.event_id, event]));
  for (const event of timeline) {
    if (
      event.thread_root_event_id === current.root.event_id &&
      !HIDDEN_THREAD_TYPES.has(event.type)
    ) {
      byId.set(event.event_id, event);
    }
  }
  const events = [...byId.values()].sort((a, b) => a.event_id.localeCompare(b.event_id));
  return {
    ...current,
    root,
    events,
    reply_count: Math.max(current.reply_count, events.length),
  };
}
