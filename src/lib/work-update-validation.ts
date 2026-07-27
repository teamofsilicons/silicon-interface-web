import {
  WORK_UPDATE_SCHEMA_VERSION,
  type WorkBlockerEvent,
  type WorkCallEvent,
  type WorkCallState,
  type WorkCallTranscriptEntry,
  type WorkContentBlock,
  type WorkEventBase,
  type WorkEventKind,
  type WorkExecutionState,
  type WorkFileBlock,
  type WorkHistoryEntry,
  type WorkHistoryKind,
  type WorkImageBlock,
  type WorkMilestoneEvent,
  type WorkPersistentEvent,
  type WorkRemoteBrowserBlock,
  type WorkTaskSnapshot,
  type WorkTaskState,
  type WorkTerminalEvent,
  type WorkTextBlock,
  type WorkTimelineRecord,
  type WorkTimerPauseReason,
  type WorkTimerState,
  type WorkTimingSnapshot,
  type WorkTodo,
  type WorkTodoState,
  type WorkVoiceBlock,
  type WorkWorkerGroupEvent,
  type WorkWorkerInvocation,
} from "./work-update-types";

type UnknownRecord = Record<string, unknown>;

const TASK_STATES = new Set<WorkTaskState>([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
const TERMINAL_TASK_STATES = new Set<WorkTaskState>([
  "completed",
  "failed",
  "cancelled",
]);
const TODO_STATES = new Set<WorkTodoState>([
  "yet_to_start",
  "in_progress",
  "completed",
  "blocked",
]);
const EXECUTION_STATES = new Set<WorkExecutionState>([
  ...TODO_STATES,
  "failed",
  "cancelled",
]);
const TIMER_STATES = new Set<WorkTimerState>(["running", "paused", "stopped"]);
const PAUSE_REASONS = new Set<WorkTimerPauseReason>([
  "blocker",
  "rate_limited",
  "offline",
  "infrastructure",
]);
const EVENT_KINDS = new Set<WorkEventKind>([
  "milestone",
  "blocker",
  "completion",
  "failure",
  "cancellation",
  "worker_group",
  "call",
]);
const HISTORY_KINDS = new Set<WorkHistoryKind>([
  "task_created",
  "task_updated",
  "description_updated",
  "state_changed",
  "todo_created",
  "todo_updated",
  "worker_updated",
  "call_updated",
  "milestone",
  "blocker_opened",
  "blocker_resolved",
  "completed",
  "failed",
  "cancelled",
  "timer_updated",
  "note",
]);
const CALL_STATES = new Set<WorkCallState>([
  "connecting",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown, allowEmpty = true): string | null {
  if (typeof value !== "string") return null;
  if (!allowEmpty && value.trim().length === 0) return null;
  return value;
}

function identifier(value: unknown): string | null {
  return text(value, false);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function revision(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positiveDimension(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

function optionalString(row: UnknownRecord, key: string): string | null | undefined {
  if (!(key in row)) return undefined;
  return text(row[key]);
}

function parseTextBlock(row: UnknownRecord): WorkTextBlock | null {
  const body = text(row.body);
  if (body === null) return null;
  const format = row.format;
  if (format !== undefined && format !== "plain" && format !== "markdown") return null;
  return { type: "text", body, ...(format ? { format } : {}) };
}

function parseImageBlock(row: UnknownRecord): WorkImageBlock | null {
  const mediaId = identifier(row.media_id);
  if (!mediaId) return null;
  const filename = optionalString(row, "filename");
  const mime = optionalString(row, "mime");
  const caption = optionalString(row, "caption");
  const alt = optionalString(row, "alt");
  if (filename === null || mime === null || caption === null || alt === null) return null;
  const width = positiveDimension(row.width);
  const height = positiveDimension(row.height);
  if ((row.width !== undefined && width === undefined) ||
      (row.height !== undefined && height === undefined)) return null;
  return {
    type: "image",
    media_id: mediaId,
    ...(filename !== undefined ? { filename } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(alt !== undefined ? { alt } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function parseFileBlock(row: UnknownRecord): WorkFileBlock | null {
  const mediaId = identifier(row.media_id);
  const filename = identifier(row.filename);
  if (!mediaId || !filename) return null;
  const mime = optionalString(row, "mime");
  const caption = optionalString(row, "caption");
  if (mime === null || caption === null) return null;
  const size = row.size_bytes === null
    ? null
    : row.size_bytes === undefined
      ? undefined
      : nonNegativeInteger(row.size_bytes);
  if (row.size_bytes !== undefined && row.size_bytes !== null && size === null) return null;
  return {
    type: "file",
    media_id: mediaId,
    filename,
    ...(mime !== undefined ? { mime } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(size !== undefined ? { size_bytes: size } : {}),
  };
}

function parseVoiceBlock(row: UnknownRecord): WorkVoiceBlock | null {
  const mediaId = identifier(row.media_id);
  if (!mediaId) return null;
  const mime = optionalString(row, "mime");
  const transcript = optionalString(row, "transcript");
  if (mime === null || transcript === null) return null;
  const duration = row.duration_ms === null
    ? null
    : row.duration_ms === undefined
      ? undefined
      : nonNegativeInteger(row.duration_ms);
  if (row.duration_ms !== undefined && row.duration_ms !== null && duration === null) return null;
  return {
    type: "voice",
    media_id: mediaId,
    ...(mime !== undefined ? { mime } : {}),
    ...(duration !== undefined ? { duration_ms: duration } : {}),
    ...(transcript !== undefined ? { transcript } : {}),
  };
}

function parseRemoteBrowserBlock(row: UnknownRecord): WorkRemoteBrowserBlock | null {
  const url = safeHttpUrl(row.url);
  if (!url) return null;
  const title = optionalString(row, "title");
  const sessionId = row.session_id === undefined ? undefined : identifier(row.session_id);
  const ttlMinutes = row.ttl_minutes === undefined
    ? undefined
    : Number.isSafeInteger(row.ttl_minutes) && Number(row.ttl_minutes) > 0
      ? Number(row.ttl_minutes)
      : null;
  const expiresAt = row.expires_at === null
    ? null
    : row.expires_at === undefined
      ? undefined
      : isoDate(row.expires_at);
  if (title === null || sessionId === null || ttlMinutes === null ||
      (row.expires_at !== undefined && row.expires_at !== null && expiresAt === null)) return null;
  if (row.closed !== undefined && typeof row.closed !== "boolean") return null;
  return {
    type: "remote_browser",
    url,
    ...(title !== undefined ? { title } : {}),
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(ttlMinutes !== undefined ? { ttl_minutes: ttlMinutes } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(row.closed !== undefined ? { closed: row.closed } : {}),
  };
}

export function parseWorkContentBlock(value: unknown): WorkContentBlock | null {
  const row = record(value);
  if (!row) return null;
  switch (row.type) {
    case "text": return parseTextBlock(row);
    case "image": return parseImageBlock(row);
    case "file": return parseFileBlock(row);
    case "voice": return parseVoiceBlock(row);
    case "remote_browser": return parseRemoteBrowserBlock(row);
    default: return null;
  }
}

export function parseWorkContentBlocks(value: unknown): WorkContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const blocks: WorkContentBlock[] = [];
  for (const candidate of value) {
    const block = parseWorkContentBlock(candidate);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks;
}

export function parseWorkTimingSnapshot(value: unknown): WorkTimingSnapshot | null {
  const row = record(value);
  if (!row) return null;
  const estimate = nonNegativeInteger(row.estimate_seconds);
  const elapsed = nonNegativeInteger(row.active_elapsed_seconds);
  const timerUpdatedAt = isoDate(row.timer_updated_at);
  if (estimate === null || elapsed === null || !timerUpdatedAt ||
      !TIMER_STATES.has(row.timer_state as WorkTimerState)) return null;
  const pauseReason = row.timer_pause_reason === null
    ? null
    : row.timer_pause_reason === undefined
      ? undefined
      : PAUSE_REASONS.has(row.timer_pause_reason as WorkTimerPauseReason)
        ? row.timer_pause_reason as WorkTimerPauseReason
        : false;
  if (pauseReason === false) return null;
  if (row.timer_state === "paused" && pauseReason == null) return null;
  if (row.timer_state !== "paused" && pauseReason != null) return null;
  return {
    estimate_seconds: estimate,
    active_elapsed_seconds: elapsed,
    timer_state: row.timer_state as WorkTimerState,
    timer_updated_at: timerUpdatedAt,
    ...(pauseReason !== undefined ? { timer_pause_reason: pauseReason } : {}),
  };
}

export function parseWorkHistoryEntry(value: unknown): WorkHistoryEntry | null {
  const row = record(value);
  if (!row) return null;
  const historyId = identifier(row.history_id);
  const summary = text(row.summary);
  const entryRevision = revision(row.revision);
  const createdAt = isoDate(row.created_at);
  if (!historyId || summary === null || entryRevision === null || !createdAt ||
      !HISTORY_KINDS.has(row.kind as WorkHistoryKind)) return null;
  const body = optionalString(row, "body");
  const entityId = row.entity_id === undefined ? undefined : identifier(row.entity_id);
  const state = optionalString(row, "state");
  const actorId = row.actor_id === undefined ? undefined : identifier(row.actor_id);
  const actorName = optionalString(row, "actor_name");
  if (body === null || entityId === null || state === null || actorId === null ||
      actorName === null) return null;
  const actorKind = row.actor_kind;
  if (actorKind !== undefined && !["carbon", "silicon", "manager", "system"].includes(String(actorKind))) {
    return null;
  }
  let sequence: number | undefined;
  if (row.sequence !== undefined) {
    const parsedSequence = nonNegativeInteger(row.sequence);
    if (parsedSequence === null) return null;
    sequence = parsedSequence;
  }
  let blocks: WorkContentBlock[] | undefined;
  if (row.blocks !== undefined) {
    const parsedBlocks = parseWorkContentBlocks(row.blocks);
    if (parsedBlocks === null) return null;
    blocks = parsedBlocks;
  }
  return {
    history_id: historyId,
    kind: row.kind as WorkHistoryKind,
    summary,
    ...(body !== undefined ? { body } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(entityId !== undefined ? { entity_id: entityId } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(actorKind !== undefined
      ? { actor_kind: actorKind as WorkHistoryEntry["actor_kind"] }
      : {}),
    ...(actorId !== undefined ? { actor_id: actorId } : {}),
    ...(actorName !== undefined ? { actor_name: actorName } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    revision: entryRevision,
    created_at: createdAt,
  };
}

export function parseWorkHistory(value: unknown): WorkHistoryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: WorkHistoryEntry[] = [];
  for (const candidate of value) {
    const entry = parseWorkHistoryEntry(candidate);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries;
}

export function parseWorkTodo(value: unknown): WorkTodo | null {
  const row = record(value);
  if (!row) return null;
  const todoId = identifier(row.todo_id);
  const title = text(row.title, false);
  const description = text(row.description);
  const todoRevision = revision(row.revision);
  const history = parseWorkHistory(row.history);
  if (!todoId || !title || description === null || todoRevision === null || !history ||
      !TODO_STATES.has(row.state as WorkTodoState)) return null;
  const createdAt = row.created_at === undefined ? undefined : isoDate(row.created_at);
  const updatedAt = row.updated_at === undefined ? undefined : isoDate(row.updated_at);
  if ((row.created_at !== undefined && !createdAt) || (row.updated_at !== undefined && !updatedAt)) {
    return null;
  }
  return {
    todo_id: todoId,
    title,
    description,
    state: row.state as WorkTodoState,
    revision: todoRevision,
    history,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  };
}

export function parseWorkTaskSnapshot(value: unknown): WorkTaskSnapshot | null {
  const row = record(value);
  if (!row || row.schema_version !== WORK_UPDATE_SCHEMA_VERSION) return null;
  const taskId = identifier(row.task_id);
  const roomId = identifier(row.room_id);
  const title = text(row.title, false);
  const description = text(row.description);
  const taskRevision = revision(row.revision);
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  const timing = parseWorkTimingSnapshot(row);
  const history = parseWorkHistory(row.history);
  if (!taskId || !roomId || !title || description === null || taskRevision === null ||
      !createdAt || !updatedAt || !timing || !history ||
      !TASK_STATES.has(row.state as WorkTaskState) || !Array.isArray(row.todos)) return null;
  const taskState = row.state as WorkTaskState;
  if (TERMINAL_TASK_STATES.has(taskState) && timing.timer_state !== "stopped") {
    return null;
  }
  if (taskState === "blocked" &&
      (timing.timer_state !== "paused" || timing.timer_pause_reason !== "blocker")) {
    return null;
  }
  if ((taskState === "queued" || taskState === "running") && timing.timer_state === "stopped") {
    return null;
  }
  if ((taskState === "queued" || taskState === "running") &&
      timing.timer_state === "paused" && timing.timer_pause_reason === "blocker") {
    return null;
  }
  const todos: WorkTodo[] = [];
  const todoIds = new Set<string>();
  for (const candidate of row.todos) {
    const todo = parseWorkTodo(candidate);
    if (!todo || todoIds.has(todo.todo_id)) return null;
    todoIds.add(todo.todo_id);
    todos.push(todo);
  }
  return {
    schema_version: WORK_UPDATE_SCHEMA_VERSION,
    task_id: taskId,
    room_id: roomId,
    title,
    description,
    state: taskState,
    ...timing,
    todos,
    history,
    revision: taskRevision,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

interface ParsedEventBase extends Omit<WorkEventBase, "kind"> {
  kind: WorkEventKind;
}

function parseEventBase(row: UnknownRecord): ParsedEventBase | null {
  if (row.schema_version !== WORK_UPDATE_SCHEMA_VERSION) return null;
  const workEventId = identifier(row.work_event_id);
  const taskId = row.task_id == null ? null : identifier(row.task_id);
  const roomId = identifier(row.room_id);
  const taskTitle = row.task_title == null ? null : text(row.task_title, false);
  const body = text(row.body);
  const blocks = parseWorkContentBlocks(row.blocks);
  const timing = row.timing == null ? null : parseWorkTimingSnapshot(row.timing);
  const history = parseWorkHistory(row.history);
  const eventRevision = revision(row.revision);
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  const kind = EVENT_KINDS.has(row.kind as WorkEventKind)
    ? row.kind as WorkEventKind
    : null;
  if (!workEventId || !roomId || body === null || !blocks || !history ||
      eventRevision === null || !createdAt || !updatedAt || !kind ||
      (row.task_id != null && !taskId) ||
      (row.task_title != null && !taskTitle) ||
      (row.timing != null && !timing)) return null;
  const hasTaskId = taskId !== null;
  const hasTaskTitle = taskTitle !== null;
  const hasTiming = timing !== null;
  if (hasTaskId !== hasTaskTitle || hasTaskId !== hasTiming) return null;
  if (kind !== "call" && !hasTaskId) return null;
  return {
    schema_version: WORK_UPDATE_SCHEMA_VERSION,
    work_event_id: workEventId,
    task_id: taskId,
    room_id: roomId,
    task_title: taskTitle,
    kind,
    body,
    blocks,
    timing,
    history,
    revision: eventRevision,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseWorker(value: unknown): WorkWorkerInvocation | null {
  const row = record(value);
  if (!row) return null;
  const workerId = identifier(row.worker_id);
  const invocationId = identifier(row.invocation_id);
  const name = text(row.name, false);
  const description = text(row.description);
  const workerRevision = revision(row.revision);
  const history = parseWorkHistory(row.history);
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  if (!workerId || !invocationId || !name || description === null || workerRevision === null ||
      !history || !createdAt || !updatedAt ||
      !EXECUTION_STATES.has(row.state as WorkExecutionState)) return null;
  return {
    worker_id: workerId,
    invocation_id: invocationId,
    name,
    description,
    state: row.state as WorkExecutionState,
    revision: workerRevision,
    history,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseTranscriptEntry(value: unknown): WorkCallTranscriptEntry | null {
  const row = record(value);
  if (!row) return null;
  const transcriptId = identifier(row.transcript_id);
  const speakerId = identifier(row.speaker_id);
  const speakerName = text(row.speaker_name, false);
  const body = text(row.body);
  const blocks = parseWorkContentBlocks(row.blocks);
  const entryRevision = revision(row.revision);
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  if (!transcriptId || !speakerId || !speakerName || body === null || !blocks ||
      entryRevision === null || !createdAt || !updatedAt ||
      (row.speaker_kind !== "manager" && row.speaker_kind !== "silicon")) return null;
  return {
    transcript_id: transcriptId,
    speaker_kind: row.speaker_kind,
    speaker_id: speakerId,
    speaker_name: speakerName,
    body,
    blocks,
    revision: entryRevision,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function parseWorkPersistentEvent(value: unknown): WorkPersistentEvent | null {
  const row = record(value);
  if (!row) return null;
  const base = parseEventBase(row);
  if (!base) return null;
  const linkedBase = base.task_id !== null &&
      base.task_title !== null &&
      base.timing !== null
    ? {
        ...base,
        task_id: base.task_id,
        task_title: base.task_title,
        timing: base.timing,
      }
    : null;
  switch (base.kind) {
    case "milestone":
      return linkedBase
        ? { ...linkedBase, kind: "milestone" } satisfies WorkMilestoneEvent
        : null;
    case "completion":
    case "failure":
    case "cancellation":
      if (!linkedBase || linkedBase.timing.timer_state !== "stopped") return null;
      return { ...linkedBase, kind: base.kind } satisfies WorkTerminalEvent;
    case "blocker": {
      if (!linkedBase) return null;
      const blockerId = identifier(row.blocker_id);
      if (!blockerId || (row.state !== "open" && row.state !== "resolved")) return null;
      const resolvedAt = row.resolved_at === null ? null : isoDate(row.resolved_at);
      if (row.state === "open" ? row.resolved_at !== null : !resolvedAt) return null;
      if (row.state === "open" &&
          (linkedBase.timing.timer_state !== "paused" ||
            linkedBase.timing.timer_pause_reason !== "blocker")) return null;
      return {
        ...linkedBase,
        kind: "blocker",
        blocker_id: blockerId,
        state: row.state,
        resolved_at: resolvedAt,
      } satisfies WorkBlockerEvent;
    }
    case "worker_group": {
      if (!linkedBase) return null;
      const groupId = identifier(row.group_id);
      if (!groupId || !Array.isArray(row.workers)) return null;
      const workers: WorkWorkerInvocation[] = [];
      const invocationIds = new Set<string>();
      for (const candidate of row.workers) {
        const worker = parseWorker(candidate);
        if (!worker || invocationIds.has(worker.invocation_id)) return null;
        invocationIds.add(worker.invocation_id);
        workers.push(worker);
      }
      return {
        ...linkedBase,
        kind: "worker_group",
        group_id: groupId,
        workers,
      } satisfies WorkWorkerGroupEvent;
    }
    case "call": {
      const callId = identifier(row.call_id);
      const targetId = identifier(row.target_id);
      const targetName = text(row.target_name, false);
      if (!callId || !targetId || !targetName ||
          (row.direction !== "inbound" && row.direction !== "outbound") ||
          (row.target_kind !== "manager" && row.target_kind !== "silicon") ||
          !CALL_STATES.has(row.state as WorkCallState) || !Array.isArray(row.transcript)) {
        return null;
      }
      const transcript: WorkCallTranscriptEntry[] = [];
      const transcriptIds = new Set<string>();
      for (const candidate of row.transcript) {
        const entry = parseTranscriptEntry(candidate);
        if (!entry || transcriptIds.has(entry.transcript_id)) return null;
        transcriptIds.add(entry.transcript_id);
        transcript.push(entry);
      }
      return {
        ...base,
        kind: "call",
        call_id: callId,
        direction: row.direction,
        target_kind: row.target_kind,
        target_id: targetId,
        target_name: targetName,
        state: row.state as WorkCallState,
        transcript,
      } satisfies WorkCallEvent;
    }
  }
}

export function parseWorkTimelineRecord(
  type: unknown,
  content: unknown,
): WorkTimelineRecord | null {
  if (type === "m.work_task") {
    const task = parseWorkTaskSnapshot(content);
    return task ? { type, task } : null;
  }
  if (type === "m.work_event") {
    const event = parseWorkPersistentEvent(content);
    return event ? { type, event } : null;
  }
  return null;
}

export function isWorkTaskSnapshot(value: unknown): value is WorkTaskSnapshot {
  return parseWorkTaskSnapshot(value) !== null;
}

export function isWorkPersistentEvent(value: unknown): value is WorkPersistentEvent {
  return parseWorkPersistentEvent(value) !== null;
}
