import type {
  WorkCallEvent,
  WorkCallTranscriptEntry,
  WorkHistoryEntry,
  WorkPersistentEvent,
  WorkTaskSnapshot,
  WorkTimelineRecord,
  WorkTodo,
  WorkWorkerGroupEvent,
  WorkWorkerInvocation,
} from "./work-update-types";

export interface WorkUpdateState {
  tasks: Record<string, WorkTaskSnapshot>;
  task_order: string[];
  events: Record<string, WorkPersistentEvent>;
  event_order: string[];
  task_event_ids: Record<string, string[]>;
}

type Versioned = { revision: number; updated_at?: string; created_at: string };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`
  ).join(",")}}`;
}

function instant(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Deterministic even when two producers incorrectly reuse one revision. */
function compareVersion<T extends Versioned>(left: T, right: T): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  const leftUpdated = instant(left.updated_at ?? left.created_at);
  const rightUpdated = instant(right.updated_at ?? right.created_at);
  if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function latestVersion<T extends Versioned>(left: T, right: T): T {
  return compareVersion(left, right) >= 0 ? left : right;
}

function historySort(left: WorkHistoryEntry, right: WorkHistoryEntry): number {
  if (left.sequence !== undefined && right.sequence !== undefined &&
      left.sequence !== right.sequence) return left.sequence - right.sequence;
  const created = instant(left.created_at) - instant(right.created_at);
  if (created) return created;
  const identity = left.history_id.localeCompare(right.history_id);
  if (identity) return identity;
  return left.revision - right.revision;
}

function historyKey(entry: WorkHistoryEntry): string {
  return `${entry.history_id}\u0000${entry.revision}`;
}

function hasNovelHistory(
  candidate: readonly WorkHistoryEntry[],
  previous: readonly WorkHistoryEntry[],
): boolean {
  const previousKeys = new Set(previous.map(historyKey));
  return candidate.some((entry) => !previousKeys.has(historyKey(entry)));
}

function stableHistorySuffix(value: unknown): string {
  const source = canonicalJson(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A malformed producer revision must not erase the previous human-readable
 * state merely because it forgot to append a journal entry. Preserve a
 * deterministic system-authored fallback; well-formed revisions that include
 * any new history fact remain untouched.
 */
function retainPreviousDetails(
  merged: readonly WorkHistoryEntry[],
  candidate: readonly WorkHistoryEntry[],
  previous: readonly WorkHistoryEntry[],
  details: {
    entityId: string;
    entityLabel: string;
    body: string;
    state?: string;
    at: string;
    snapshot: unknown;
    kind?: WorkHistoryEntry["kind"];
  },
): WorkHistoryEntry[] {
  if (hasNovelHistory(candidate, previous)) return [...merged];
  const retained: WorkHistoryEntry = {
    history_id: `interface-retained:${details.entityId}:${stableHistorySuffix(details.snapshot)}`,
    kind: details.kind ?? "note",
    summary: `Previous ${details.entityLabel} details`,
    body: details.body,
    entity_id: details.entityId,
    ...(details.state ? { state: details.state } : {}),
    actor_kind: "system",
    actor_name: "Silicon Interface",
    revision: 0,
    created_at: details.at,
  };
  return mergeWorkHistory(merged, [retained]);
}

/**
 * Histories are append-only by (history_id, revision). Duplicate replays are
 * collapsed; a correction with a higher revision remains beside the original.
 */
export function mergeWorkHistory(
  left: readonly WorkHistoryEntry[],
  right: readonly WorkHistoryEntry[],
): WorkHistoryEntry[] {
  const entries = new Map<string, WorkHistoryEntry>();
  for (const entry of [...left, ...right]) {
    const key = `${entry.history_id}\u0000${entry.revision}`;
    const current = entries.get(key);
    if (!current || canonicalJson(entry) > canonicalJson(current)) entries.set(key, entry);
  }
  return [...entries.values()].sort(historySort);
}

export function mergeWorkTodo(current: WorkTodo, incoming: WorkTodo): WorkTodo {
  if (current.todo_id !== incoming.todo_id) {
    throw new Error("cannot merge different work todo identities");
  }
  if (current.created_at && incoming.created_at && current.created_at !== incoming.created_at) {
    throw new Error("work todo immutable created_at changed");
  }
  const currentVersion = {
    ...current,
    created_at: current.created_at ?? current.updated_at ?? "",
  };
  const incomingVersion = {
    ...incoming,
    created_at: incoming.created_at ?? incoming.updated_at ?? "",
  };
  const winner = compareVersion(currentVersion, incomingVersion) >= 0
    ? current
    : incoming;
  const loser = winner === current ? incoming : current;
  let history = mergeWorkHistory(current.history, incoming.history);
  if (
    winner.title !== loser.title ||
    winner.description !== loser.description ||
    winner.state !== loser.state
  ) {
    history = retainPreviousDetails(history, winner.history, loser.history, {
      entityId: loser.todo_id,
      entityLabel: "todo item",
      body: `**${loser.title}**\n\n${loser.description}`,
      state: loser.state,
      at: loser.updated_at ?? loser.created_at ?? winner.updated_at ?? winner.created_at ?? "1970-01-01T00:00:00.000Z",
      snapshot: { title: loser.title, description: loser.description, state: loser.state, revision: loser.revision },
      kind: "todo_updated",
    });
  }
  return {
    ...winner,
    history,
    ...(current.created_at || incoming.created_at
      ? { created_at: current.created_at ?? incoming.created_at }
      : {}),
  };
}

function mergeTodoLists(
  preferred: readonly WorkTodo[],
  fallback: readonly WorkTodo[],
): WorkTodo[] {
  const current = new Map(fallback.map((todo) => [todo.todo_id, todo]));
  const merged = new Map<string, WorkTodo>();
  for (const todo of [...preferred, ...fallback]) {
    if (merged.has(todo.todo_id)) continue;
    const other = current.get(todo.todo_id);
    merged.set(todo.todo_id, other ? mergeWorkTodo(todo, other) : todo);
  }
  return [...merged.values()];
}

/** Merge a mutable root card without permitting a stale replay to regress it. */
export function mergeWorkTaskSnapshot(
  current: WorkTaskSnapshot,
  incoming: WorkTaskSnapshot,
): WorkTaskSnapshot {
  if (current.task_id !== incoming.task_id) {
    throw new Error("cannot merge different work task identities");
  }
  if (current.room_id !== incoming.room_id || current.created_at !== incoming.created_at) {
    throw new Error("work task immutable identity fields changed");
  }
  const winner = latestVersion(current, incoming);
  const loser = winner === current ? incoming : current;
  let history = mergeWorkHistory(current.history, incoming.history);
  if (
    winner.title !== loser.title ||
    winner.description !== loser.description ||
    winner.state !== loser.state
  ) {
    history = retainPreviousDetails(history, winner.history, loser.history, {
      entityId: loser.task_id,
      entityLabel: "task",
      body: `**${loser.title}**\n\n${loser.description}`,
      state: loser.state,
      at: loser.updated_at,
      snapshot: { title: loser.title, description: loser.description, state: loser.state, revision: loser.revision },
      kind: "task_updated",
    });
  }
  return {
    ...winner,
    todos: mergeTodoLists(winner.todos, loser.todos),
    history,
  };
}

function mergeWorker(
  current: WorkWorkerInvocation,
  incoming: WorkWorkerInvocation,
): WorkWorkerInvocation {
  if (current.invocation_id !== incoming.invocation_id ||
      current.worker_id !== incoming.worker_id ||
      current.created_at !== incoming.created_at) {
    throw new Error("work invocation immutable identity fields changed");
  }
  const winner = latestVersion(current, incoming);
  const loser = winner === current ? incoming : current;
  let history = mergeWorkHistory(current.history, incoming.history);
  if (
    winner.name !== loser.name ||
    winner.description !== loser.description ||
    winner.state !== loser.state
  ) {
    history = retainPreviousDetails(history, winner.history, loser.history, {
      entityId: loser.invocation_id,
      entityLabel: "worker",
      body: `**${loser.name}**\n\n${loser.description}`,
      state: loser.state,
      at: loser.updated_at,
      snapshot: { name: loser.name, description: loser.description, state: loser.state, revision: loser.revision },
      kind: "worker_updated",
    });
  }
  return {
    ...winner,
    history,
  };
}

function mergeWorkers(
  preferred: readonly WorkWorkerInvocation[],
  fallback: readonly WorkWorkerInvocation[],
): WorkWorkerInvocation[] {
  const byId = new Map(fallback.map((worker) => [worker.invocation_id, worker]));
  const merged = new Map<string, WorkWorkerInvocation>();
  for (const worker of [...preferred, ...fallback]) {
    if (merged.has(worker.invocation_id)) continue;
    const other = byId.get(worker.invocation_id);
    merged.set(worker.invocation_id, other ? mergeWorker(worker, other) : worker);
  }
  return [...merged.values()];
}

function mergeTranscriptEntry(
  current: WorkCallTranscriptEntry,
  incoming: WorkCallTranscriptEntry,
): WorkCallTranscriptEntry {
  if (current.transcript_id !== incoming.transcript_id ||
      current.created_at !== incoming.created_at ||
      current.speaker_kind !== incoming.speaker_kind ||
      current.speaker_id !== incoming.speaker_id) {
    throw new Error("call transcript immutable identity fields changed");
  }
  return latestVersion(current, incoming);
}

function mergeTranscript(
  left: readonly WorkCallTranscriptEntry[],
  right: readonly WorkCallTranscriptEntry[],
): WorkCallTranscriptEntry[] {
  const entries = new Map<string, WorkCallTranscriptEntry>();
  for (const entry of [...left, ...right]) {
    const current = entries.get(entry.transcript_id);
    entries.set(
      entry.transcript_id,
      current ? mergeTranscriptEntry(current, entry) : entry,
    );
  }
  return [...entries.values()].sort((a, b) => {
    const created = instant(a.created_at) - instant(b.created_at);
    return created || a.transcript_id.localeCompare(b.transcript_id);
  });
}

function assertSameWorkEvent(current: WorkPersistentEvent, incoming: WorkPersistentEvent): void {
  if (current.work_event_id !== incoming.work_event_id) {
    throw new Error("cannot merge different work event identities");
  }
  if (current.task_id !== incoming.task_id || current.room_id !== incoming.room_id ||
      current.kind !== incoming.kind || current.created_at !== incoming.created_at) {
    throw new Error("work event immutable identity fields changed");
  }
}

/** Merge one persistent child card and retain all of its prior history facts. */
export function mergeWorkPersistentEvent(
  current: WorkPersistentEvent,
  incoming: WorkPersistentEvent,
): WorkPersistentEvent {
  assertSameWorkEvent(current, incoming);
  const winner = latestVersion(current, incoming);
  const loser = winner === current ? incoming : current;
  let history = mergeWorkHistory(current.history, incoming.history);
  const eventPresentationChanged =
    winner.task_title !== loser.task_title ||
    winner.body !== loser.body ||
    canonicalJson(winner.blocks) !== canonicalJson(loser.blocks) ||
    (winner.kind === "blocker" && loser.kind === "blocker" && winner.state !== loser.state) ||
    (winner.kind === "call" && loser.kind === "call" && winner.state !== loser.state);
  if (eventPresentationChanged) {
    history = retainPreviousDetails(history, winner.history, loser.history, {
      entityId: loser.work_event_id,
      entityLabel: `${loser.kind.replaceAll("_", " ")} update`,
      body: loser.body,
      state:
        loser.kind === "blocker" || loser.kind === "call"
          ? loser.state
          : undefined,
      at: loser.updated_at,
      snapshot: {
        task_title: loser.task_title,
        body: loser.body,
        blocks: loser.blocks,
        state:
          loser.kind === "blocker" || loser.kind === "call"
            ? loser.state
            : undefined,
        revision: loser.revision,
      },
      kind:
        loser.kind === "blocker"
          ? "blocker_opened"
          : loser.kind === "call"
            ? "call_updated"
            : "note",
    });
  }
  switch (winner.kind) {
    case "worker_group": {
      const other = (winner === current ? incoming : current) as WorkWorkerGroupEvent;
      if (winner.group_id !== other.group_id) {
        throw new Error("work group immutable group_id changed");
      }
      return {
        ...winner,
        history,
        workers: mergeWorkers(winner.workers, other.workers),
      };
    }
    case "call": {
      const other = (winner === current ? incoming : current) as WorkCallEvent;
      const currentCall = current as WorkCallEvent;
      const incomingCall = incoming as WorkCallEvent;
      if (winner.call_id !== other.call_id || winner.direction !== other.direction ||
          winner.target_kind !== other.target_kind || winner.target_id !== other.target_id) {
        throw new Error("work call immutable identity fields changed");
      }
      return {
        ...winner,
        history,
        transcript: mergeTranscript(currentCall.transcript, incomingCall.transcript),
      };
    }
    case "blocker": {
      const other = winner === current ? incoming : current;
      if (other.kind !== "blocker" || winner.blocker_id !== other.blocker_id) {
        throw new Error("work blocker immutable blocker_id changed");
      }
      return { ...winner, history };
    }
    case "milestone":
    case "completion":
    case "failure":
    case "cancellation":
      return { ...winner, history };
  }
}

export function createWorkUpdateState(): WorkUpdateState {
  return {
    tasks: {},
    task_order: [],
    events: {},
    event_order: [],
    task_event_ids: {},
  };
}

function insertByCreatedAt<T extends { created_at: string }>(
  ids: readonly string[],
  id: string,
  rows: Record<string, T>,
): string[] {
  const unique = ids.includes(id) ? [...ids] : [...ids, id];
  return unique.sort((leftId, rightId) => {
    const left = rows[leftId];
    const right = rows[rightId];
    if (!left || !right) return leftId.localeCompare(rightId);
    const created = instant(left.created_at) - instant(right.created_at);
    return created || leftId.localeCompare(rightId);
  });
}

/** Pure upsert reducer for history snapshots and WebSocket revisions. */
export function reduceWorkTimelineRecord(
  state: WorkUpdateState,
  record: WorkTimelineRecord,
): WorkUpdateState {
  if (record.type === "m.work_task") {
    for (const eventId of state.task_event_ids[record.task.task_id] ?? []) {
      const linked = state.events[eventId];
      if (linked && linked.room_id !== record.task.room_id) {
        throw new Error("work task and child event room identities disagree");
      }
    }
    const task = state.tasks[record.task.task_id]
      ? mergeWorkTaskSnapshot(state.tasks[record.task.task_id], record.task)
      : record.task;
    const tasks = { ...state.tasks, [task.task_id]: task };
    return {
      ...state,
      tasks,
      task_order: insertByCreatedAt(state.task_order, task.task_id, tasks),
    };
  }

  const incoming = record.event;
  const linkedTask = incoming.task_id ? state.tasks[incoming.task_id] : undefined;
  if (linkedTask && linkedTask.room_id !== incoming.room_id) {
    throw new Error("work task and child event room identities disagree");
  }
  const event = state.events[incoming.work_event_id]
    ? mergeWorkPersistentEvent(state.events[incoming.work_event_id], incoming)
    : incoming;
  const events = { ...state.events, [event.work_event_id]: event };
  const next = {
    ...state,
    events,
    event_order: insertByCreatedAt(state.event_order, event.work_event_id, events),
  };
  if (!event.task_id) return next;
  const currentTaskEvents = state.task_event_ids[event.task_id] ?? [];
  const taskEventIds = insertByCreatedAt(currentTaskEvents, event.work_event_id, events);
  return {
    ...next,
    task_event_ids: {
      ...state.task_event_ids,
      [event.task_id]: taskEventIds,
    },
  };
}

/** Batch materialization is order-independent for revisions of one identity. */
export function reduceWorkTimelineRecords(
  records: readonly WorkTimelineRecord[],
  initial: WorkUpdateState = createWorkUpdateState(),
): WorkUpdateState {
  return records.reduce(reduceWorkTimelineRecord, initial);
}

export function workEventsForTask(
  state: WorkUpdateState,
  taskId: string,
): WorkPersistentEvent[] {
  return (state.task_event_ids[taskId] ?? [])
    .map((id) => state.events[id])
    .filter((event): event is WorkPersistentEvent => Boolean(event));
}

export function openWorkBlockers(
  state: WorkUpdateState,
  taskId: string,
): Extract<WorkPersistentEvent, { kind: "blocker" }>[] {
  return workEventsForTask(state, taskId)
    .filter((event): event is Extract<WorkPersistentEvent, { kind: "blocker" }> =>
      event.kind === "blocker" && event.state === "open"
    );
}

export function activeWorkTasks(state: WorkUpdateState): WorkTaskSnapshot[] {
  return state.task_order
    .map((id) => state.tasks[id])
    .filter((task): task is WorkTaskSnapshot =>
      Boolean(task) && !["completed", "failed", "cancelled"].includes(task.state)
    );
}
