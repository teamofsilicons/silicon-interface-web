"use client";

import * as React from "react";

import type {
  ManagerActivityFrame,
  ManagerActivityGroup,
  WorkBlockerEvent,
  WorkCallEvent,
  WorkHistoryEntry as WireHistoryEntry,
  WorkPersistentEvent,
  WorkTaskSnapshot,
  WorkTimelineRecord,
  WorkTimingSnapshot,
  WorkWorkerGroupEvent,
} from "@/lib/work-update-types";
import {
  isTerminalManagerActivityShell,
  managerActivityLabel,
} from "@/lib/work-manager-activity";

import { WorkCallCard } from "./work-call-card";
import { WorkContentBlocks } from "./work-content-blocks";
import { WorkManagerActivityList } from "./work-manager-activity";
import { WorkStatusCard } from "./work-status-card";
import { WorkTaskCard } from "./work-task-card";
import type {
  WorkActivityKind,
  WorkCallState,
  WorkCallView,
  WorkHistoryEntry,
  WorkManagerActivity,
  WorkPersistentEventView,
  WorkTaskView,
  WorkTimer,
  WorkWorkerGroupView,
} from "./work-update-types";
import { WorkWorkerGroupCard } from "./work-worker-group-card";

function timerView(timing: WorkTimingSnapshot): WorkTimer {
  return {
    estimateSeconds: timing.estimate_seconds,
    activeElapsedSeconds: timing.active_elapsed_seconds,
    state: timing.timer_state,
    updatedAt: timing.timer_updated_at,
    pausedReason: timing.timer_pause_reason?.replaceAll("_", " ") ?? undefined,
  };
}

const presentableStates = new Set([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "yet_to_start",
  "in_progress",
]);

function historyView(
  history: WireHistoryEntry[],
  roomId?: string,
  eventId?: string,
): WorkHistoryEntry[] {
  return history.map((entry) => ({
    // Reducers intentionally retain corrected revisions, so the revision is
    // part of the React identity as well.
    id: `${entry.history_id}:${entry.revision}`,
    at: entry.created_at,
    title: entry.summary,
    description: entry.body,
    state: entry.state && presentableStates.has(entry.state)
      ? (entry.state as WorkHistoryEntry["state"])
      : undefined,
    actor: entry.actor_name,
    content: entry.blocks?.length ? (
      <WorkContentBlocks
        blocks={entry.blocks}
        roomId={roomId}
        eventId={eventId}
        excludeText={entry.body}
      />
    ) : undefined,
  }));
}

function latestSummary(history: WireHistoryEntry[]): string | undefined {
  return history.at(-1)?.summary;
}

function taskView(task: WorkTaskSnapshot): WorkTaskView {
  return {
    id: task.task_id,
    title: task.title,
    state: task.state,
    description: task.description,
    currentActivity:
      task.state === "running" || task.state === "blocked" ? latestSummary(task.history) : undefined,
    items: task.todos.map((todo) => ({
      id: todo.todo_id,
      title: todo.title,
      state: todo.state,
      description: todo.description,
      currentActivity:
        todo.state === "in_progress" || todo.state === "blocked" ? latestSummary(todo.history) : undefined,
      history: historyView(todo.history, task.room_id),
    })),
    history: historyView(task.history, task.room_id),
    timer: timerView(task),
    revision: task.revision,
  };
}

function statusEventView(
  event: Exclude<WorkPersistentEvent, WorkWorkerGroupEvent | WorkCallEvent>,
  task?: WorkTaskView,
): WorkPersistentEventView {
  return {
    id: event.work_event_id,
    taskId: event.task_id,
    taskTitle: task?.title ?? event.task_title,
    kind: event.kind,
    description: event.body,
    content: event.blocks.length ? (
      <WorkContentBlocks
        blocks={event.blocks}
        roomId={event.room_id}
        eventId={event.work_event_id}
        excludeText={event.body}
      />
    ) : undefined,
    history: historyView(event.history, event.room_id, event.work_event_id),
    timer: timerView(event.timing),
    createdAt: event.created_at,
    resolved: event.kind === "blocker" ? event.state === "resolved" : undefined,
    blockerId: event.kind === "blocker" ? event.blocker_id : undefined,
    task,
  };
}

function workerGroupView(event: WorkWorkerGroupEvent, task?: WorkTaskView): WorkWorkerGroupView {
  return {
    id: event.work_event_id,
    taskId: event.task_id,
    taskTitle: task?.title ?? event.task_title,
    description: event.body,
    content: event.blocks.length ? (
      <WorkContentBlocks
        blocks={event.blocks}
        roomId={event.room_id}
        eventId={event.work_event_id}
        excludeText={event.body}
      />
    ) : undefined,
    workers: event.workers.map((worker) => ({
      id: worker.invocation_id,
      name: worker.name,
      task: worker.description,
      state: worker.state,
      description: worker.description,
      currentActivity:
        worker.state === "in_progress" || worker.state === "blocked"
          ? latestSummary(worker.history)
          : undefined,
      history: historyView(worker.history, event.room_id, event.work_event_id),
    })),
    history: historyView(event.history, event.room_id, event.work_event_id),
    timer: timerView(event.timing),
    task,
  };
}

function callState(state: WorkCallEvent["state"]): WorkCallState {
  if (state === "connecting") return "calling";
  if (state === "in_progress") return "connected";
  return state;
}

function callView(event: WorkCallEvent, task?: WorkTaskView): WorkCallView {
  return {
    id: event.work_event_id,
    taskId: event.task_id ?? undefined,
    taskTitle: task?.title ?? event.task_title ?? undefined,
    direction: event.direction,
    state: callState(event.state),
    peer: event.target_name,
    summary: event.body,
    content: event.blocks.length ? (
      <WorkContentBlocks
        blocks={event.blocks}
        roomId={event.room_id}
        eventId={event.work_event_id}
        excludeText={event.body}
      />
    ) : undefined,
    transcript: event.transcript.map((entry) => ({
      id: `${entry.transcript_id}:${entry.revision}`,
      at: entry.created_at,
      speaker: entry.speaker_name,
      body: entry.body,
      content: entry.blocks.length ? (
        <WorkContentBlocks
          blocks={entry.blocks}
          roomId={event.room_id}
          eventId={event.work_event_id}
          excludeText={entry.body}
        />
      ) : undefined,
    })),
    startedAt: event.created_at,
    endedAt: event.state === "completed" || event.state === "failed" || event.state === "cancelled"
      ? event.updated_at
      : undefined,
    history: historyView(event.history, event.room_id, event.work_event_id),
    task,
  };
}

function unpackEvent(input: WorkEventCardInput): WorkTaskSnapshot | WorkPersistentEvent {
  if ("type" in input && input.type === "m.work_task") return input.task;
  if ("type" in input && input.type === "m.work_event") return input.event;
  return input;
}

export type WorkEventCardInput = WorkTimelineRecord | WorkTaskSnapshot | WorkPersistentEvent;

export interface WorkEventCardProps {
  /** A parsed canonical record (not the outer generic chat Event envelope). */
  event: WorkEventCardInput;
  className?: string;
  onReply?: (blockerId: string, event: WorkBlockerEvent) => void;
  /** Current root task resolves renamed headings and powers task-context dialogs. */
  task?: WorkTaskSnapshot;
}

/** One integration entry point for every durable work card. */
export function WorkEventCard({ event: input, className, onReply, task }: WorkEventCardProps) {
  const event = unpackEvent(input);
  if ("todos" in event) return <WorkTaskCard task={taskView(event)} className={className} />;
  const linkedTask = event.task_id && task &&
      task.task_id === event.task_id &&
      task.room_id === event.room_id
    ? taskView(task)
    : undefined;
  if (event.kind === "worker_group") {
    return <WorkWorkerGroupCard group={workerGroupView(event, linkedTask)} className={className} />;
  }
  if (event.kind === "call") return <WorkCallCard call={callView(event, linkedTask)} className={className} />;
  return (
    <WorkStatusCard
      event={statusEventView(event, linkedTask)}
      className={className}
      onReply={event.kind === "blocker" && onReply ? (blockerId) => onReply(blockerId, event) : undefined}
    />
  );
}

function activityKind(frame: ManagerActivityFrame): WorkActivityKind {
  if (frame.kind === "executing") return "tool";
  if (frame.kind === "searching_web") return "other";
  if (frame.kind === "done") return "other";
  return frame.kind;
}

function activityView(group: ManagerActivityGroup): WorkManagerActivity[] {
  const frames = [...group.history];
  if (group.current && !frames.some(
    (frame) => frame.frame_id === group.current?.frame_id && frame.revision === group.current.revision,
  )) {
    frames.push(group.current);
  }
  const meaningfulFrames = frames.filter((frame) => !isTerminalManagerActivityShell(frame));
  return meaningfulFrames.map((frame) => activityForFrame(group, frame));
}

function activityForFrame(
  group: ManagerActivityGroup,
  frame: ManagerActivityFrame,
): WorkManagerActivity {
  return {
    id: `${frame.progress_group_id}:${frame.frame_id}:${frame.revision}`,
    kind: activityKind(frame),
    label: managerActivityLabel(frame),
    state:
      group.display === "active" && group.current?.frame_id === frame.frame_id && frame.kind !== "done"
        ? "active"
        : "completed",
    at: frame.occurred_at,
    description: frame.progress_pct == null ? undefined : `${Math.round(frame.progress_pct)}% complete`,
  };
}

export interface WorkManagerActivityHistoryProps {
  group: ManagerActivityGroup;
  className?: string;
  initiallyExpanded?: boolean;
  avatarSeed?: string;
  avatarSrc?: string | null;
  avatarAsciiSrc?: string | null;
  avatarFamily?: "carbon" | "silicon";
}

/** Canonical ManagerActivityGroup adapter for the transient activity UI. */
export function WorkManagerActivityHistory({
  group,
  className,
  initiallyExpanded,
  avatarSeed,
  avatarSrc,
  avatarAsciiSrc,
  avatarFamily,
}: WorkManagerActivityHistoryProps) {
  const active = group.display === "active" && group.current !== null;
  const activities = activityView(group);
  if (!activities.length) return null;
  const currentActivityId = group.current
    ? `${group.current.progress_group_id}:${group.current.frame_id}:${group.current.revision}`
    : null;
  const summaryActivity = active && currentActivityId
    ? activities.find((activity) => activity.id === currentActivityId) ?? activities.at(-1)
    : activities.at(-1);
  return (
    <WorkManagerActivityList
      key={active ? "active" : "settled"}
      activities={activities}
      summaryActivityId={summaryActivity?.id}
      summaryActivity={summaryActivity}
      className={className}
      initiallyExpanded={initiallyExpanded ?? active}
      avatarSeed={avatarSeed}
      avatarSrc={avatarSrc}
      avatarAsciiSrc={avatarAsciiSrc}
      avatarFamily={avatarFamily}
    />
  );
}
