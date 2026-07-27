import type {
  ManagerActivityFrame,
  ManagerActivityGroup,
  ManagerActivityKind,
  ManagerActivityState,
} from "./work-update-types";
import type { Event, ProgressState } from "./types";

const MANAGER_ACTIVITY_REPLACING_EVENT_TYPES = new Set([
  "m.text",
  "m.image",
  "m.file",
  "m.album",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);

/** A missed terminal frame must not leave transient manager work live forever. */
export const MANAGER_ACTIVITY_STALE_MS = 100_000;

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

/**
 * Find the committed reply that belongs to a manager run.
 *
 * Stemcell deliberately sends its final reply before its durable `done`
 * progress frame. A client that missed the transient activity therefore sees
 * the reply first and can only join the two when the later frame arrives.
 */
export function managerActivityReplacementEvent(
  events: readonly Pick<
    Event,
    "event_id" | "sender_kind" | "type" | "content" | "is_final"
  >[],
  progressGroupId: string,
): Pick<
  Event,
  "event_id" | "sender_kind" | "type" | "content" | "is_final"
> | null {
  const groupId = identifier(progressGroupId);
  if (!groupId) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.content.progress_group_id === groupId &&
      eventReplacesManagerActivity(event)
    ) {
      return event;
    }
  }
  return null;
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

function collapsePublicPathMentions(value: string): string {
  return value.replace(
    /(`?)(?!(?:[a-z][a-z0-9+.-]*:\/\/))((?:~?\/|\.{1,2}\/|[A-Za-z]:[\\/]|(?:[A-Za-z0-9_.-]+[\\/]))[^\s`"'<>]*)(`?)/gi,
    (match, open: string, rawPath: string, close: string, offset: number, input: string) => {
      if (input.slice(Math.max(0, offset - 8), offset).includes("://")) return match;
      const suffixMatch = rawPath.match(/[),.;:\]}]+$/);
      const suffix = suffixMatch?.[0] ?? "";
      const path = suffix ? rawPath.slice(0, -suffix.length) : rawPath;
      const parts = path.split(/[\\/]+/).filter(Boolean);
      const fileName = parts[parts.length - 1];
      if (!fileName || fileName === path) return match;
      const tick = open || close ? "`" : "";
      return `${tick}${fileName}${tick}${suffix}`;
    },
  );
}

function sentenceCase(value: string): string {
  const text = value.trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/**
 * Convert a producer note into user-facing manager activity copy.
 *
 * Both the transient line and retained history use this formatter so internal
 * tool mechanics, generic reasoning shells, and local filesystem paths cannot
 * leak through one presentation while being hidden by the other.
 */
export function publicManagerActivityNote(
  note: string,
  kind: ManagerActivityKind | ProgressState,
): string | null {
  const text = collapsePublicPathMentions(note.trim());
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/[.…]+$/g, "").trim();
  if (
    kind === "done" &&
    (!normalized || normalized === "done" || normalized === "manager finished")
  ) {
    return null;
  }
  if (
    normalized.startsWith("called tool") ||
    normalized.startsWith("calling tool") ||
    normalized.startsWith("tool call") ||
    normalized.startsWith("tool:")
  ) {
    return null;
  }
  if (
    kind === "thinking" &&
    (normalized === "thinking" || normalized.startsWith("thought for "))
  ) {
    return null;
  }
  if (
    kind === "executing" &&
    (normalized.startsWith("executing command failed") ||
      normalized.startsWith("message failed:"))
  ) {
    return sentenceCase(text);
  }
  if (
    kind === "executing" &&
    (normalized.startsWith("executing:") ||
      normalized === "executing command" ||
      normalized.startsWith("executing output:") ||
      normalized.startsWith("executing done:"))
  ) {
    return "Executing command";
  }
  return sentenceCase(text);
}

export function isTerminalManagerActivityShell(
  frame: ManagerActivityFrame,
): boolean {
  return frame.kind === "done" &&
    publicManagerActivityNote(frame.note, frame.kind) === null;
}

function hasPresentableActivity(group: ManagerActivityGroup): boolean {
  return [...group.history, ...(group.current ? [group.current] : [])]
    .some((frame) => !isTerminalManagerActivityShell(frame));
}

function publicFrameKey(frame: ManagerActivityFrame): string {
  return JSON.stringify([
    frame.kind,
    publicManagerActivityNote(frame.note, frame.kind),
    frame.task_id ?? null,
    frame.progress_pct ?? null,
  ]);
}

function mergePresentedFrames(
  groups: readonly ManagerActivityGroup[],
): ManagerActivityFrame[] {
  const frames = new Map<string, ManagerActivityFrame>();
  for (const group of groups) {
    for (const frame of group.history) {
      if (isTerminalManagerActivityShell(frame)) continue;
      const key = publicFrameKey(frame);
      const current = frames.get(key);
      if (!current || compareFrames(frame, current) > 0) frames.set(key, frame);
    }
  }
  return [...frames.values()].sort(compareFrames);
}

function commonTaskId(
  groups: readonly ManagerActivityGroup[],
): string | null | undefined {
  return groups.every((group) => group.task_id === groups[0]?.task_id)
    ? groups[0]?.task_id
    : undefined;
}

function mergeActivityHistory(
  history: readonly ManagerActivityFrame[],
  frame: ManagerActivityFrame,
): ManagerActivityFrame[] {
  const retained = frame.kind === "done"
    ? history.filter((entry) =>
        entry.kind !== "done" ||
        entry.note !== frame.note ||
        entry.task_id !== frame.task_id
      )
    : history;
  const duplicateDone = frame.kind === "done"
    ? history.filter((entry) =>
        entry.kind === "done" &&
        entry.note === frame.note &&
        entry.task_id === frame.task_id
      )
    : [];
  const terminalFrame = duplicateDone.reduce(
    (latest, candidate) => {
      const order = compareFrames(candidate, latest);
      return order > 0 ||
          (order === 0 && JSON.stringify(candidate) > JSON.stringify(latest))
        ? candidate
        : latest;
    },
    frame,
  );
  const entries = new Map(retained.map((entry) => [frameKey(entry), entry]));
  const key = frameKey(terminalFrame);
  const current = entries.get(key);
  if (!current || JSON.stringify(terminalFrame) > JSON.stringify(current)) {
    entries.set(key, terminalFrame);
  }
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
  if (isNewest && display !== "replaced" && !existing?.replaced_by_event_id) {
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
      /** A committed final message replaces the transient activity row. */
      reason: "final_message";
      final_message_event_id: string;
    }
  | {
      occurred_at: string;
      /** A local user action explicitly hides the transient row. */
      reason: "dismissed";
    };

/**
 * Clear the current line after a run. A bare done signal retains collapsed
 * history; a committed final message replaces the transient row.
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
  if (
    (existing.display === "replaced" || existing.replaced_by_event_id) &&
    options.reason === "done"
  ) return state;
  return {
    groups: {
      ...state.groups,
      [groupKey]: {
        ...existing,
        current: null,
        display:
          options.reason === "done"
            ? "history"
            : "replaced",
        replaced_by_event_id:
          options.reason === "final_message"
            ? existing.replaced_by_event_id ?? finalEventId
            : options.reason === "dismissed"
              ? null
              : existing.replaced_by_event_id,
        updated_at: Date.parse(options.occurred_at) >= Date.parse(existing.updated_at)
          ? options.occurred_at
          : existing.updated_at,
      },
    },
  };
}

/**
 * Resolve a run for settlement. An omitted run id is safe when the room has
 * one active run. With no active work, the newest retained history is the only
 * plausible target for an untagged final message.
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
  return visible.at(-1) ?? null;
}

export function visibleManagerActivityGroups(
  state: ManagerActivityState,
  roomId: string,
): ManagerActivityGroup[] {
  return Object.values(state.groups)
    .filter((group) =>
      group.room_id === roomId &&
      group.display !== "replaced" &&
      !group.replaced_by_event_id
    )
    .sort((left, right) =>
      Date.parse(left.updated_at) - Date.parse(right.updated_at) ||
      left.progress_group_id.localeCompare(right.progress_group_id)
    );
}

/**
 * Build the room timeline projection without reviving one row per historical
 * manager handoff. Active runs retain their own identity; two or more
 * completed, unanchored runs become one expandable history row.
 *
 * This is presentation-only. The underlying groups remain separate so a late
 * final message can still settle the exact run it belongs to.
 */
export function presentedManagerActivityGroups(
  state: ManagerActivityState,
  roomId: string,
  options: { asOfMs?: number } = {},
): ManagerActivityGroup[] {
  // A final message replaces the transient *position*, not the history. Keep
  // those settled groups in the presentation projection so placement can
  // render them collapsed above the exact reply. A dismissed group has no
  // replacement event and stays hidden.
  const presented = Object.values(state.groups)
    .filter((group) =>
      group.room_id === roomId &&
      hasPresentableActivity(group) &&
      (group.display !== "replaced" || Boolean(group.replaced_by_event_id)) &&
      (
        group.display !== "active" ||
        options.asOfMs === undefined ||
        !Number.isFinite(options.asOfMs) ||
        options.asOfMs - Date.parse(group.updated_at) < MANAGER_ACTIVITY_STALE_MS
      )
    )
    .sort((left, right) =>
      Date.parse(left.updated_at) - Date.parse(right.updated_at) ||
      left.progress_group_id.localeCompare(right.progress_group_id)
    );
  const histories = presented.filter((group) => group.display === "history");
  let projected = histories.length < 2
    ? presented
    : [
        ...presented.filter((group) => group.display !== "history"),
        {
          progress_group_id: `manager-history:${roomId}`,
          room_id: roomId,
          ...(commonTaskId(histories) !== undefined
            ? { task_id: commonTaskId(histories) }
            : {}),
          current: null,
          history: mergePresentedFrames(histories),
          display: "history" as const,
          replaced_by_event_id: null,
          updated_at: histories.at(-1)!.updated_at,
        },
      ];

  const replacedByEvent = new Map<string, ManagerActivityGroup[]>();
  for (const group of projected) {
    if (!group.replaced_by_event_id) continue;
    const matches = replacedByEvent.get(group.replaced_by_event_id) ?? [];
    matches.push(group);
    replacedByEvent.set(group.replaced_by_event_id, matches);
  }
  for (const [eventId, groups] of replacedByEvent) {
    if (groups.length < 2) continue;
    const groupIds = new Set(groups.map((group) => group.progress_group_id));
    projected = [
      ...projected.filter((group) => !groupIds.has(group.progress_group_id)),
      {
        progress_group_id: `manager-replaced:${JSON.stringify([roomId, eventId])}`,
        room_id: roomId,
        ...(commonTaskId(groups) !== undefined
          ? { task_id: commonTaskId(groups) }
          : {}),
        current: null,
        history: mergePresentedFrames(groups),
        display: "replaced",
        replaced_by_event_id: eventId,
        updated_at: groups.at(-1)!.updated_at,
      },
    ];
  }

  return projected.sort((left, right) =>
    Date.parse(left.updated_at) - Date.parse(right.updated_at) ||
    left.progress_group_id.localeCompare(right.progress_group_id)
  );
}

/**
 * Attach manager activity above the Silicon message carrying the same run
 * identity. A settled replacement uses its exact final event id, which keeps
 * the collapsed history beside the reply even when the final message arrived
 * before the durable done frame. Only genuinely unassociated activity trails
 * the timeline.
 */
export function placeManagerActivityGroups(
  groups: readonly ManagerActivityGroup[],
  events: readonly Pick<
    Event,
    "event_id" | "sender_kind" | "type" | "content" | "is_final" | "created_at"
  >[],
): {
  attachedToEvent: Map<string, ManagerActivityGroup[]>;
  trailing: ManagerActivityGroup[];
} {
  const attachedToEvent = new Map<string, ManagerActivityGroup[]>();
  const trailing: ManagerActivityGroup[] = [];
  const eventsById = new Map(events.map((event) => [event.event_id, event]));

  const attach = (eventId: string, group: ManagerActivityGroup) => {
    const attached = attachedToEvent.get(eventId) ?? [];
    attached.push(group);
    attachedToEvent.set(eventId, attached);
  };

  for (const group of groups) {
    if (group.replaced_by_event_id) {
      if (eventsById.has(group.replaced_by_event_id)) {
        attach(group.replaced_by_event_id, group);
      }
      // If the exact reply is outside this loaded history window, do not move
      // its activity to the bottom and misrepresent it as current work.
      continue;
    }
    if (group.display === "replaced") continue;

    const associatedMessage = [...events].reverse().find((event) =>
      event.sender_kind === "silicon" &&
      MANAGER_ACTIVITY_REPLACING_EVENT_TYPES.has(event.type) &&
      event.is_final !== false &&
      event.content.progress_group_id === group.progress_group_id
    );
    if (associatedMessage) {
      attach(associatedMessage.event_id, group);
      continue;
    }
    const supersedingMessage = events.some((event) =>
      eventReplacesManagerActivity(event) &&
      Date.parse(event.created_at) >= Date.parse(group.updated_at)
    );
    if (supersedingMessage) {
      // A later final Silicon reply proves this unmatched run is no longer
      // current. Keep its cached identity available for a late done frame, but
      // never misrepresent it as new work below the reply.
      continue;
    }
    trailing.push(group);
  }
  return { attachedToEvent, trailing };
}

export function managerActivityLabel(frame: ManagerActivityFrame): string {
  const note = publicManagerActivityNote(frame.note, frame.kind);
  if (note) return note;
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
