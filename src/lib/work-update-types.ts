/**
 * Durable work-update wire shapes.
 *
 * Glass persists root cards as `m.work_task` events and child cards as
 * `m.work_event` events.  These interfaces intentionally use snake_case so a
 * parsed value can move between Glass, the CLI, and the renderer without a
 * second lossy translation layer.
 */

export const WORK_UPDATE_SCHEMA_VERSION = 1 as const;

export type WorkTaskState =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkTodoState =
  | "yet_to_start"
  | "in_progress"
  | "completed"
  | "blocked";

export type WorkExecutionState = WorkTodoState | "failed" | "cancelled";

export type WorkTimerState = "running" | "paused" | "stopped";

export type WorkTimerPauseReason =
  | "blocker"
  | "rate_limited"
  | "offline"
  | "infrastructure";

export interface WorkTimingSnapshot {
  estimate_seconds: number;
  /** Accumulated elapsed time as of timer_updated_at. */
  active_elapsed_seconds: number;
  timer_state: WorkTimerState;
  timer_updated_at: string;
  timer_pause_reason?: WorkTimerPauseReason | null;
}

export interface WorkTextBlock {
  type: "text";
  body: string;
  format?: "plain" | "markdown";
}

export interface WorkImageBlock {
  type: "image";
  media_id: string;
  filename?: string;
  mime?: string;
  caption?: string;
  alt?: string;
  width?: number | null;
  height?: number | null;
}

export interface WorkFileBlock {
  type: "file";
  media_id: string;
  filename: string;
  mime?: string;
  caption?: string;
  size_bytes?: number | null;
}

export interface WorkVoiceBlock {
  type: "voice";
  media_id: string;
  mime?: string;
  duration_ms?: number | null;
  transcript?: string;
}

export interface WorkRemoteBrowserBlock {
  type: "remote_browser";
  url: string;
  title?: string;
  session_id?: string;
  ttl_minutes?: number;
  expires_at?: string | null;
  closed?: boolean;
}

/** Ordered blocks allow one update or blocker to mix copy and attachments. */
export type WorkContentBlock =
  | WorkTextBlock
  | WorkImageBlock
  | WorkFileBlock
  | WorkVoiceBlock
  | WorkRemoteBrowserBlock;

export type WorkHistoryKind =
  | "task_created"
  | "task_updated"
  | "description_updated"
  | "state_changed"
  | "todo_created"
  | "todo_updated"
  | "worker_updated"
  | "call_updated"
  | "milestone"
  | "blocker_opened"
  | "blocker_resolved"
  | "completed"
  | "failed"
  | "cancelled"
  | "timer_updated"
  | "note";

/**
 * History entries are immutable journal facts.  A corrected fact keeps the
 * same history_id and increments revision; reducers retain both revisions.
 */
export interface WorkHistoryEntry {
  history_id: string;
  kind: WorkHistoryKind;
  summary: string;
  body?: string;
  blocks?: WorkContentBlock[];
  entity_id?: string;
  state?: string;
  actor_kind?: "carbon" | "silicon" | "manager" | "system";
  actor_id?: string;
  actor_name?: string;
  sequence?: number;
  revision: number;
  created_at: string;
}

export interface WorkTodo {
  todo_id: string;
  title: string;
  description: string;
  state: WorkTodoState;
  revision: number;
  history: WorkHistoryEntry[];
  created_at?: string;
  updated_at?: string;
}

/** Mutable snapshot rendered by the persistent root task card. */
export interface WorkTaskSnapshot extends WorkTimingSnapshot {
  schema_version: typeof WORK_UPDATE_SCHEMA_VERSION;
  task_id: string;
  room_id: string;
  title: string;
  description: string;
  state: WorkTaskState;
  todos: WorkTodo[];
  history: WorkHistoryEntry[];
  revision: number;
  created_at: string;
  updated_at: string;
}

export type WorkEventKind =
  | "milestone"
  | "blocker"
  | "completion"
  | "failure"
  | "cancellation"
  | "worker_group"
  | "call";

export interface WorkEventBase {
  schema_version: typeof WORK_UPDATE_SCHEMA_VERSION;
  work_event_id: string;
  task_id: string | null;
  room_id: string;
  task_title: string | null;
  kind: WorkEventKind;
  body: string;
  blocks: WorkContentBlock[];
  timing: WorkTimingSnapshot | null;
  history: WorkHistoryEntry[];
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkTaskLinkedEventBase extends WorkEventBase {
  task_id: string;
  task_title: string;
  timing: WorkTimingSnapshot;
}

export interface WorkMilestoneEvent extends WorkTaskLinkedEventBase {
  kind: "milestone";
}

export interface WorkBlockerEvent extends WorkTaskLinkedEventBase {
  kind: "blocker";
  blocker_id: string;
  state: "open" | "resolved";
  resolved_at: string | null;
}

export interface WorkTerminalEvent extends WorkTaskLinkedEventBase {
  kind: "completion" | "failure" | "cancellation";
}

export interface WorkWorkerInvocation {
  worker_id: string;
  invocation_id: string;
  name: string;
  description: string;
  state: WorkExecutionState;
  revision: number;
  history: WorkHistoryEntry[];
  created_at: string;
  updated_at: string;
}

export interface WorkWorkerGroupEvent extends WorkTaskLinkedEventBase {
  kind: "worker_group";
  group_id: string;
  workers: WorkWorkerInvocation[];
}

export type WorkCallState =
  | "connecting"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkCallTranscriptEntry {
  transcript_id: string;
  speaker_kind: "manager" | "silicon";
  speaker_id: string;
  speaker_name: string;
  body: string;
  blocks: WorkContentBlock[];
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface WorkCallEvent extends WorkEventBase {
  kind: "call";
  call_id: string;
  direction: "inbound" | "outbound";
  target_kind: "manager" | "silicon";
  target_id: string;
  target_name: string;
  state: WorkCallState;
  transcript: WorkCallTranscriptEntry[];
}

export type WorkPersistentEvent =
  | WorkMilestoneEvent
  | WorkBlockerEvent
  | WorkTerminalEvent
  | WorkWorkerGroupEvent
  | WorkCallEvent;

export type WorkTimelineRecord =
  | { type: "m.work_task"; task: WorkTaskSnapshot }
  | { type: "m.work_event"; event: WorkPersistentEvent };

export type ManagerActivityKind =
  | "thinking"
  | "reading"
  | "writing"
  | "spawning_worker"
  | "executing"
  | "searching_web"
  | "calling"
  | "other"
  | "done";

/** Normalized form of either an m.progress event or a live progress frame. */
export interface ManagerActivityFrame {
  frame_id: string;
  progress_group_id: string;
  room_id: string;
  task_id?: string | null;
  kind: ManagerActivityKind;
  note: string;
  progress_pct?: number | null;
  revision: number;
  occurred_at: string;
}

export interface ManagerActivityGroup {
  progress_group_id: string;
  room_id: string;
  task_id?: string | null;
  current: ManagerActivityFrame | null;
  history: ManagerActivityFrame[];
  display: "active" | "history" | "replaced";
  replaced_by_event_id: string | null;
  updated_at: string;
}

export interface ManagerActivityState {
  groups: Record<string, ManagerActivityGroup>;
}
