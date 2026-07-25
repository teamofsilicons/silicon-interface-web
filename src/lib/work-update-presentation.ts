import type { Event } from "./types";
import type { WorkContentBlock, WorkTimelineRecord } from "./work-update-types";
import { parseWorkTimelineRecord } from "./work-update-validation";

export type WorkNotificationTier = "none" | "in_app" | "push" | "prominent_push";

function compact(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
}

export function parsedWorkRecord(event: Pick<Event, "type" | "content">): WorkTimelineRecord | null {
  return parseWorkTimelineRecord(event.type, event.content);
}

export function workRecordPreview(record: WorkTimelineRecord): string {
  if (record.type === "m.work_task") {
    const prefix = record.task.state === "blocked"
      ? "Blocked"
      : record.task.state === "completed"
        ? "Completed"
        : record.task.state === "failed"
          ? "Failed"
          : record.task.state === "cancelled"
            ? "Cancelled"
            : "Started";
    return `${prefix} · ${record.task.title}`;
  }
  const event = record.event;
  switch (event.kind) {
    case "milestone":
      return compact(event.body) || `Update · ${event.task_title}`;
    case "blocker":
      return compact(event.body)
        ? `Blocker · ${event.task_title}: ${compact(event.body, 90)}`
        : `Blocker · ${event.task_title}`;
    case "completion":
      return `Completed · ${event.task_title}`;
    case "failure":
      return `Failed · ${event.task_title}`;
    case "cancellation":
      return `Cancelled · ${event.task_title}`;
    case "worker_group":
      return `${event.workers.length} ${event.workers.length === 1 ? "worker" : "workers"} · ${event.task_title}`;
    case "call": {
      if (event.direction === "inbound") return `Received call from ${event.target_name}`;
      return event.state === "connecting" || event.state === "in_progress"
        ? `Calling ${event.target_name}`
        : `Called ${event.target_name}`;
    }
  }
}

export function workEventPreview(event: Pick<Event, "type" | "content">): string | null {
  const record = parsedWorkRecord(event);
  return record ? workRecordPreview(record) : null;
}

export function workNotificationTier(
  event: Pick<Event, "type" | "content">,
): WorkNotificationTier {
  const record = parsedWorkRecord(event);
  if (!record || record.type === "m.work_task") return "none";
  switch (record.event.kind) {
    case "milestone":
      return "in_app";
    case "blocker":
      return record.event.state === "open" ? "prominent_push" : "none";
    case "completion":
    case "failure":
    case "cancellation":
      return "push";
    case "worker_group":
    case "call":
      return "none";
  }
}

export function workEventCountsAsUnread(event: Pick<Event, "type" | "content">): boolean {
  return workNotificationTier(event) !== "none";
}

/** A blocker resolution edits the durable card but retracts the alert raised
 * by its open revision. Keeping this predicate next to notification policy
 * prevents the page socket projection from duplicating wire-shape checks. */
export function isResolvedWorkBlocker(
  event: Pick<Event, "type" | "content">,
): boolean {
  const record = parsedWorkRecord(event);
  return record?.type === "m.work_event" &&
    record.event.kind === "blocker" &&
    record.event.state === "resolved";
}

function blockText(block: WorkContentBlock): string {
  if (block.type === "text") return block.body;
  if (block.type === "image") return [block.filename, block.caption, block.alt].filter(Boolean).join(" ");
  if (block.type === "file") return [block.filename, block.caption].filter(Boolean).join(" ");
  if (block.type === "voice") return block.transcript ?? "";
  return [block.title, block.url].filter(Boolean).join(" ");
}

/** Browser-side recent search text; Glass should mirror this projection. */
export function workRecordSearchText(record: WorkTimelineRecord): string {
  if (record.type === "m.work_task") {
    const task = record.task;
    return [
      task.title,
      task.description,
      ...task.todos.flatMap((todo) => [
        todo.title,
        todo.description,
        ...todo.history.flatMap((entry) => [entry.summary, entry.body ?? ""]),
      ]),
      ...task.history.flatMap((entry) => [entry.summary, entry.body ?? ""]),
    ].filter(Boolean).join(" ");
  }
  const event = record.event;
  const base = [
    event.task_title,
    event.body,
    ...event.blocks.map(blockText),
    ...event.history.flatMap((entry) => [entry.summary, entry.body ?? ""]),
  ];
  if (event.kind === "worker_group") {
    base.push(...event.workers.flatMap((worker) => [worker.name, worker.description]));
  } else if (event.kind === "call") {
    base.push(
      event.target_name,
      ...event.transcript.flatMap((entry) => [
        entry.speaker_name,
        entry.body,
        ...entry.blocks.map(blockText),
      ]),
    );
  }
  return base.filter(Boolean).join(" ");
}
