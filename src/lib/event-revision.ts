import { mergeDeliverySummaries } from "./delivery-state";
import type { Event } from "./types";
import {
  mergeWorkPersistentEvent,
  mergeWorkTaskSnapshot,
} from "./work-update-state";
import type { WorkTimelineRecord } from "./work-update-types";
import { parseWorkTimelineRecord } from "./work-update-validation";

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

function workRecord(event: Event): WorkTimelineRecord | null {
  return parseWorkTimelineRecord(event.type, event.content);
}

function workResourceId(record: WorkTimelineRecord): string {
  return record.type === "m.work_task"
    ? record.task.task_id
    : record.event.work_event_id;
}

function matchingWorkRecords(
  current: Event,
  incoming: Event,
): [WorkTimelineRecord, WorkTimelineRecord] | null {
  const currentRecord = workRecord(current);
  const incomingRecord = workRecord(incoming);
  if (!currentRecord || !incomingRecord) return null;
  if (
    currentRecord.type !== incomingRecord.type ||
    workResourceId(currentRecord) !== workResourceId(incomingRecord)
  ) {
    return null;
  }
  return [currentRecord, incomingRecord];
}

function workRecordVersion(record: WorkTimelineRecord): {
  revision: number;
  updatedAt: number;
} {
  const resource = record.type === "m.work_task" ? record.task : record.event;
  return {
    revision: resource.revision,
    updatedAt: timestamp(resource.updated_at),
  };
}

function compareWorkRecordVersion(
  current: WorkTimelineRecord,
  incoming: WorkTimelineRecord,
): number {
  const currentVersion = workRecordVersion(current);
  const incomingVersion = workRecordVersion(incoming);
  if (currentVersion.revision !== incomingVersion.revision) {
    return incomingVersion.revision - currentVersion.revision;
  }
  return incomingVersion.updatedAt - currentVersion.updatedAt;
}

function mergeWorkContent(current: Event, incoming: Event): Record<string, unknown> | null {
  const records = matchingWorkRecords(current, incoming);
  if (!records) return null;
  const [currentRecord, incomingRecord] = records;
  try {
    if (
      currentRecord.type === "m.work_task" &&
      incomingRecord.type === "m.work_task"
    ) {
      return mergeWorkTaskSnapshot(
        currentRecord.task,
        incomingRecord.task,
      ) as unknown as Record<string, unknown>;
    }
    if (
      currentRecord.type === "m.work_event" &&
      incomingRecord.type === "m.work_event"
    ) {
      return mergeWorkPersistentEvent(
        currentRecord.event,
        incomingRecord.event,
      ) as unknown as Record<string, unknown>;
    }
  } catch {
    // A same-envelope resource cannot be rebound by mutating immutable work
    // identity fields. Keep the last coherent payload already on this device.
    return current.content;
  }
  return null;
}

/**
 * Identity used to suppress exact WebSocket replays without dropping a work
 * snapshot whose inner revision advanced under the same outer event.
 */
export function eventReplayRevisionKey(event: Event): string {
  const outerRevision = Number.isSafeInteger(event.stream_position)
    ? String(event.stream_position)
    : `${event.edited_at ?? ""}:${event.redacted_at ?? ""}`;
  const record = workRecord(event);
  if (!record) return `${event.event_id}:${outerRevision}`;
  const resource = record.type === "m.work_task" ? record.task : record.event;
  return [
    event.event_id,
    outerRevision,
    record.type,
    workResourceId(record),
    resource.revision,
    resource.updated_at,
  ].join(":");
}

/** A slow snapshot must never overwrite a newer edit or undo a redaction. */
export function incomingEventRevisionIsCurrent(current: Event, incoming: Event): boolean {
  if (current.event_id !== incoming.event_id) return true;
  const currentRedacted = isRedacted(current);
  const incomingRedacted = isRedacted(incoming);
  if (currentRedacted !== incomingRedacted) return incomingRedacted;
  const workRecords = matchingWorkRecords(current, incoming);
  if (workRecords) {
    const workOrder = compareWorkRecordVersion(workRecords[0], workRecords[1]);
    if (workOrder !== 0) return workOrder > 0;
  }
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
  const workContent = mergeWorkContent(current, incoming);
  const delivery = mergeDeliverySummaries(current.delivery, incoming.delivery);
  const sameBody = JSON.stringify(current.content) === JSON.stringify(incoming.content);
  const merged = {
    ...loser,
    ...winner,
    ...(workContent ? { content: workContent } : {}),
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
