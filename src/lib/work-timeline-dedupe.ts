import { parseWorkTimelineRecord } from "./work-update-validation";

type WorkEnvelope = {
  event_id: string;
  type: unknown;
  content: unknown;
};

/**
 * One durable work resource owns one timeline position. Glass normally revises
 * the same outer event, but this guard also handles a producer that publishes a
 * newer snapshot in a fresh envelope: the first visible position remains the
 * anchor while the canonical reducer supplies its newest contents.
 */
export function workTimelineResourceKey(event: WorkEnvelope): string | null {
  const record = parseWorkTimelineRecord(event.type, event.content);
  if (!record) return null;
  if (record.type === "m.work_task") {
    return `${record.type}\u0000${record.task.room_id}\u0000${record.task.task_id}`;
  }
  return `${record.type}\u0000${record.event.room_id}\u0000${record.event.work_event_id}`;
}

export function dedupeWorkTimelineEnvelopes<T extends WorkEnvelope>(events: readonly T[]): T[] {
  const anchored = new Set<string>();
  return events.filter((event) => {
    const key = workTimelineResourceKey(event);
    if (!key) return true;
    if (anchored.has(key)) return false;
    anchored.add(key);
    return true;
  });
}
