import type * as React from "react";

/** States shared by the durable task and its persistent child events. */
export type WorkTaskState =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/** The four intentionally smaller states supported by checklist items. */
export type WorkItemState =
  | "yet_to_start"
  | "in_progress"
  | "completed"
  | "blocked";

export type WorkTimerState = "running" | "paused" | "stopped";

export interface WorkHistoryEntry {
  id: string;
  at: string | number;
  /** A terse, human-readable update such as “UI shell completed”. */
  title?: string;
  /** Safe summary or status detail. Never raw chain-of-thought. */
  description?: string;
  state?: WorkTaskState | WorkItemState;
  actor?: string;
  /** Optional already-rendered rich material (media, file, browser card, etc.). */
  content?: React.ReactNode;
}

export interface WorkChecklistItem {
  id: string;
  title: string;
  state: WorkItemState;
  description?: string;
  currentActivity?: string;
  history?: WorkHistoryEntry[];
}

export interface WorkTimer {
  estimateSeconds?: number;
  activeElapsedSeconds?: number;
  state?: WorkTimerState;
  /** Instant at which activeElapsedSeconds was last measured. */
  updatedAt?: string | number;
  pausedReason?: string;
}

/** View model for the m.work_task snapshot. */
export interface WorkTaskView {
  id: string;
  title: string;
  state: WorkTaskState;
  description?: string;
  currentActivity?: string;
  items: WorkChecklistItem[];
  history?: WorkHistoryEntry[];
  timer?: WorkTimer;
  revision?: number;
}

export type WorkPersistentEventKind =
  | "milestone"
  | "blocker"
  | "completion"
  | "failure"
  | "cancellation";

/** Presentation model shared by milestone/blocker/terminal cards. */
export interface WorkPersistentEventView {
  id: string;
  taskId: string;
  taskTitle: string;
  kind: WorkPersistentEventKind;
  title?: string;
  description?: string;
  content?: React.ReactNode;
  history?: WorkHistoryEntry[];
  timer?: WorkTimer;
  createdAt?: string | number;
  /** Only applies to blocker cards; resolved blockers stay in the timeline. */
  resolved?: boolean;
  /** Stable blocker identity, distinct from the persistent card event id. */
  blockerId?: string;
  /** Latest root snapshot, when the timeline has materialized it. */
  task?: WorkTaskView;
}

export type WorkWorkerState = WorkItemState | "failed" | "cancelled";

export interface WorkWorkerView {
  id: string;
  name: string;
  task?: string;
  state: WorkWorkerState;
  description?: string;
  currentActivity?: string;
  history?: WorkHistoryEntry[];
}

export interface WorkWorkerGroupView {
  id: string;
  taskId: string;
  taskTitle: string;
  workers: WorkWorkerView[];
  description?: string;
  content?: React.ReactNode;
  history?: WorkHistoryEntry[];
  timer?: WorkTimer;
  task?: WorkTaskView;
}

export type WorkCallDirection = "inbound" | "outbound";
export type WorkCallState = "calling" | "connected" | "completed" | "failed" | "cancelled";

export interface WorkTranscriptEntry {
  id: string;
  at: string | number;
  speaker: string;
  body: string;
  content?: React.ReactNode;
}

export interface WorkCallView {
  id: string;
  taskId?: string;
  taskTitle?: string;
  direction: WorkCallDirection;
  state: WorkCallState;
  peer: string;
  summary?: string;
  content?: React.ReactNode;
  transcript: WorkTranscriptEntry[];
  startedAt?: string | number;
  endedAt?: string | number;
  history?: WorkHistoryEntry[];
  task?: WorkTaskView;
}

export type WorkActivityKind =
  | "thinking"
  | "reading"
  | "writing"
  | "spawning_worker"
  | "calling"
  | "tool"
  | "other";

export type WorkActivityState = "active" | "completed" | "failed";

export interface WorkManagerActivity {
  id: string;
  kind: WorkActivityKind;
  label: string;
  state: WorkActivityState;
  at?: string | number;
  description?: string;
}
