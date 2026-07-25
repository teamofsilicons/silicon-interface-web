import type {
  ManagerActivityFrame,
  ManagerActivityGroup,
  ManagerActivityKind,
  ManagerActivityState,
} from "./work-update-types";
import type { Event } from "./types";

const MANAGER_ACTIVITY_REPLACING_EVENT_TYPES = new Set([
  "m.text",
  "m.image",
  "m.file",
  "m.album",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);

/** Only a committed conversational Silicon event ends transient activity.
 * Durable cards can interleave freely, and a normal event can opt into the
 * same behavior with `content.work_continues: true`. */
export function eventReplacesManagerActivity(
  event: Pick<Event, "sender_kind" | "type" | "content" | "is_final">,
): boolean {
  return event.sender_kind === "silicon" &&
    MANAGER_ACTIVITY_REPLACING_EVENT_TYPES.has(event.type) &&
    event.is_final !== false &&
    event.content.work_continues !== true;
}

interface ActivityFrameDefaults {
  room_id?: string;
  occurred_at: string;
  frame_id?: string;
}

const ACTIVITY_KIND_ALIASES: Record<string, ManagerActivityKind> = {
  thinking: "thinking",
  reading: "reading",
  reading_file: "reading",
  writing: "writing",
  writing_file: "writing",
  spawning_worker: "spawning_worker",
  spawning_workers: "spawning_worker",
  executing: "executing",
  searching_web: "searching_web",
  calling: "calling",
  done: "done",
};

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stableFrameId(
  roomId: string,
  groupId: string,
  revision: number,
  sourceOccurredAt: string | null,
  taskId: string | null | undefined,
  kind: ManagerActivityKind,
  note: string,
  pct: number | null | undefined,
): string {
  // Receipt time is deliberately absent. The page-level and open-room socket
  // consumers can observe the same legacy frame milliseconds apart, so using
  // their local clocks would turn one wire frame into two history entries.
  return `manager-activity:${JSON.stringify([
    roomId,
    groupId,
    revision,
    sourceOccurredAt,
    taskId ?? null,
    kind,
    note,
    pct ?? null,
  ])}`;
}

/** Room-scoped identity for a manager activity run. */
export function managerActivityGroupKey(
  roomId: string,
  progressGroupId: string,
): string {
  return JSON.stringify([roomId, progressGroupId]);
}

export function getManagerActivityGroup(
  state: ManagerActivityState,
  roomId: string,
  progressGroupId: string,
): ManagerActivityGroup | null {
  return state.groups[managerActivityGroupKey(roomId, progressGroupId)] ?? null;
}

/**
 * Normalize either a WebSocket `progress` frame or persisted `m.progress`
 * content. The caller supplies receipt time so the helper remains pure.
 */
export function normalizeManagerActivityFrame(
  value: unknown,
  defaults: ActivityFrameDefaults,
): ManagerActivityFrame | null {
  const input = row(value);
  if (!input || !validIso(defaults.occurred_at)) return null;
  const groupId = identifier(input.progress_group_id);
  const roomId = identifier(input.room_id) ?? identifier(defaults.room_id);
  if (!groupId || !roomId) return null;

  const rawKind = typeof input.state === "string"
    ? input.state
    : typeof input.kind === "string"
      ? input.kind
      : "";
  // Generic typing/uploading/recording beacons are not manager work history.
  if (["typing", "uploading", "recording"].includes(rawKind)) return null;
  const kind = ACTIVITY_KIND_ALIASES[rawKind] ?? (rawKind ? "other" : null);
  if (!kind) return null;

  const sourceOccurredAt = validIso(input.occurred_at)
    ? input.occurred_at
    : validIso(input.updated_at)
      ? input.updated_at
      : validIso(input.created_at)
        ? input.created_at
        : null;
  const occurredAt = sourceOccurredAt ?? defaults.occurred_at;
  const revision = Number.isSafeInteger(input.revision) && Number(input.revision) >= 0
    ? Number(input.revision)
    : 0;
  const note = typeof input.note === "string"
    ? input.note
    : typeof input.summary === "string"
      ? input.summary
      : "";
  const pct = input.progress_pct === null || input.progress_pct === undefined
    ? input.progress_pct as null | undefined
    : typeof input.progress_pct === "number" && Number.isFinite(input.progress_pct) &&
        input.progress_pct >= 0 && input.progress_pct <= 100
      ? input.progress_pct
      : false;
  if (pct === false) return null;
  const taskId = input.task_id === null || input.task_id === undefined
    ? input.task_id as null | undefined
    : identifier(input.task_id);
  if (input.task_id !== null && input.task_id !== undefined && !taskId) return null;
  const explicitFrameId = identifier(input.frame_id) ?? identifier(input.event_id) ??
    identifier(defaults.frame_id);
  const frameId = explicitFrameId ?? stableFrameId(
    roomId,
    groupId,
    revision,
    sourceOccurredAt,
    taskId,
    kind,
    note,
    pct,
  );
  return {
    frame_id: frameId,
    progress_group_id: groupId,
    room_id: roomId,
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    kind,
    note,
    ...(pct !== undefined ? { progress_pct: pct } : {}),
    revision,
    occurred_at: occurredAt,
  };
}

export function createManagerActivityState(): ManagerActivityState {
  return { groups: {} };
}

function compareFrames(left: ManagerActivityFrame, right: ManagerActivityFrame): number {
  const occurred = Date.parse(left.occurred_at) - Date.parse(right.occurred_at);
  if (occurred) return occurred;
  if (left.revision !== right.revision) return left.revision - right.revision;
  return left.frame_id.localeCompare(right.frame_id);
}

function frameKey(frame: ManagerActivityFrame): string {
  return `${frame.frame_id}\u0000${frame.revision}`;
}

function mergeActivityHistory(
  history: readonly ManagerActivityFrame[],
  frame: ManagerActivityFrame,
): ManagerActivityFrame[] {
  const entries = new Map(history.map((entry) => [frameKey(entry), entry]));
  const key = frameKey(frame);
  const current = entries.get(key);
  if (!current || JSON.stringify(frame) > JSON.stringify(current)) entries.set(key, frame);
  return [...entries.values()].sort(compareFrames);
}

/** Accumulate short manager actions without treating duplicate frames as work. */
export function reduceManagerActivityFrame(
  state: ManagerActivityState,
  frame: ManagerActivityFrame,
): ManagerActivityState {
  const groupKey = managerActivityGroupKey(frame.room_id, frame.progress_group_id);
  const existing = state.groups[groupKey];
  const history = mergeActivityHistory(existing?.history ?? [], frame);
  const isNewest = !existing || compareFrames(
    frame,
    existing.history.at(-1) ?? frame,
  ) >= 0;
  let current = existing?.current ?? null;
  let display = existing?.display ?? "active";
  if (isNewest && display !== "replaced") {
    current = frame.kind === "done" ? null : frame;
    display = frame.kind === "done" ? "history" : "active";
  }
  const group: ManagerActivityGroup = {
    progress_group_id: frame.progress_group_id,
    room_id: frame.room_id,
    ...(frame.task_id !== undefined
      ? { task_id: frame.task_id }
      : existing?.task_id !== undefined
        ? { task_id: existing.task_id }
        : {}),
    current,
    history,
    display,
    replaced_by_event_id: existing?.replaced_by_event_id ?? null,
    updated_at: isNewest ? frame.occurred_at : existing?.updated_at ?? frame.occurred_at,
  };
  return {
    groups: { ...state.groups, [groupKey]: group },
  };
}

export type SettleManagerActivityOptions =
  | {
      occurred_at: string;
      /** An explicit done signal leaves the accumulated history renderable. */
      reason: "done";
    }
  | {
      occurred_at: string;
      /** Only a committed final message may replace the transient row. */
      reason: "final_message";
      final_message_event_id: string;
    }
  | {
      occurred_at: string;
      /** A local user action explicitly hides the transient row. */
      reason: "dismissed";
    };

/**
 * Clear the current line after a run. With a final normal message the row is
 * replaced; without one the collapsed history remains renderable.
 */
export function settleManagerActivity(
  state: ManagerActivityState,
  roomId: string,
  progressGroupId: string,
  options: SettleManagerActivityOptions,
): ManagerActivityState {
  const groupKey = managerActivityGroupKey(roomId, progressGroupId);
  const existing = state.groups[groupKey];
  if (!existing || !validIso(options.occurred_at)) return state;
  if (
    options.reason !== "done" &&
    options.reason !== "final_message" &&
    options.reason !== "dismissed"
  ) return state;
  if (Date.parse(options.occurred_at) < Date.parse(existing.updated_at)) return state;
  const finalEventId = options.reason === "final_message"
    ? identifier(options.final_message_event_id)
    : null;
  if (options.reason === "final_message" && !finalEventId) return state;
  if (existing.display === "replaced" && options.reason === "done") return state;
  return {
    groups: {
      ...state.groups,
      [groupKey]: {
        ...existing,
        current: null,
        display: options.reason === "done" ? "history" : "replaced",
        replaced_by_event_id: finalEventId,
        updated_at: Date.parse(options.occurred_at) >= Date.parse(existing.updated_at)
          ? options.occurred_at
          : existing.updated_at,
      },
    },
  };
}

/**
 * Resolve a run for settlement. An omitted run id is safe only when the room
 * has one active run (or, with none active, one visible history run).
 */
export function resolveManagerActivityForSettlement(
  state: ManagerActivityState,
  roomId: string,
  progressGroupId?: string | null,
): ManagerActivityGroup | null {
  if (progressGroupId != null) {
    const explicitGroupId = identifier(progressGroupId);
    if (!explicitGroupId) return null;
    return getManagerActivityGroup(state, roomId, explicitGroupId);
  }
  const visible = visibleManagerActivityGroups(state, roomId);
  const active = visible.filter((group) => group.display === "active");
  if (active.length === 1) return active[0];
  if (active.length > 1) return null;
  return visible.length === 1 ? visible[0] : null;
}

export function visibleManagerActivityGroups(
  state: ManagerActivityState,
  roomId: string,
): ManagerActivityGroup[] {
  return Object.values(state.groups)
    .filter((group) => group.room_id === roomId && group.display !== "replaced")
    .sort((left, right) =>
      Date.parse(left.updated_at) - Date.parse(right.updated_at) ||
      left.progress_group_id.localeCompare(right.progress_group_id)
    );
}

export function managerActivityLabel(frame: ManagerActivityFrame): string {
  if (frame.note.trim()) return frame.note;
  switch (frame.kind) {
    case "thinking": return "Thinking";
    case "reading": return "Reading";
    case "writing": return "Writing";
    case "spawning_worker": return "Spawning worker";
    case "executing": return "Working";
    case "searching_web": return "Searching the web";
    case "calling": return "Calling";
    case "done": return "Done";
    case "other": return "Working";
  }
}
