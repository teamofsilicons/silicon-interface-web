import type {
  WorkTimerPauseReason,
  WorkTimerState,
  WorkTimingSnapshot,
} from "./work-update-types";

export type WorkTimerCondition =
  | "active"
  | "queued"
  | "awaiting_silicon"
  | "blocker"
  | "rate_limited"
  | "offline"
  | "infrastructure";

/** Queuing and another Silicon's work still consume the estimate. */
export function shouldPauseWorkTimer(condition: WorkTimerCondition): boolean {
  return ["blocker", "rate_limited", "offline", "infrastructure"].includes(condition);
}

/** The manager supplies the realistic parallelized estimate; the contract adds 5%. */
export function addWorkEstimateBuffer(realisticSeconds: number): number {
  if (!Number.isFinite(realisticSeconds) || realisticSeconds < 0) {
    throw new Error("realistic work estimate must be a non-negative number");
  }
  return Math.ceil(realisticSeconds * 1.05);
}

function milliseconds(at: number | Date): number {
  const value = at instanceof Date ? at.getTime() : at;
  if (!Number.isFinite(value)) throw new Error("work timer instant must be finite");
  return value;
}

/** Project the authoritative accumulator to a display instant. */
export function workElapsedSecondsAt(
  timing: WorkTimingSnapshot,
  at: number | Date,
): number {
  if (timing.timer_state !== "running") return timing.active_elapsed_seconds;
  const updatedAt = Date.parse(timing.timer_updated_at);
  if (!Number.isFinite(updatedAt)) return timing.active_elapsed_seconds;
  const delta = Math.max(0, Math.floor((milliseconds(at) - updatedAt) / 1_000));
  return timing.active_elapsed_seconds + delta;
}

export interface WorkTimerTransition {
  state: WorkTimerState;
  at: string;
  pause_reason?: WorkTimerPauseReason | null;
}

/** Checkpoint elapsed time before pausing, resuming, or stopping a timer. */
export function transitionWorkTimer(
  timing: WorkTimingSnapshot,
  transition: WorkTimerTransition,
): WorkTimingSnapshot {
  const at = Date.parse(transition.at);
  if (!Number.isFinite(at)) throw new Error("work timer transition needs an ISO instant");
  if (transition.state !== "paused" && transition.pause_reason != null) {
    throw new Error("only a paused work timer can have a pause reason");
  }
  if (transition.state === "paused" && transition.pause_reason == null) {
    throw new Error("a paused work timer needs a pause reason");
  }
  return {
    estimate_seconds: timing.estimate_seconds,
    active_elapsed_seconds: workElapsedSecondsAt(timing, at),
    timer_state: transition.state,
    timer_updated_at: transition.at,
    ...(transition.state === "paused"
      ? { timer_pause_reason: transition.pause_reason }
      : { timer_pause_reason: null }),
  };
}

export function formatWorkElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function formatWorkEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
}

export interface WorkTimingView {
  estimate_seconds: number;
  estimate_label: string;
  elapsed_seconds: number;
  elapsed_label: string;
  remaining_seconds: number;
  overdue: boolean;
  progress: number;
  timer_state: WorkTimerState;
  timer_pause_reason: WorkTimerPauseReason | null;
}

export function workTimingViewAt(
  timing: WorkTimingSnapshot,
  at: number | Date,
): WorkTimingView {
  const elapsed = workElapsedSecondsAt(timing, at);
  const estimate = timing.estimate_seconds;
  return {
    estimate_seconds: estimate,
    estimate_label: formatWorkEstimate(estimate),
    elapsed_seconds: elapsed,
    elapsed_label: formatWorkElapsed(elapsed),
    remaining_seconds: Math.max(0, estimate - elapsed),
    overdue: estimate > 0 && elapsed > estimate,
    progress: estimate > 0 ? Math.min(1, elapsed / estimate) : 0,
    timer_state: timing.timer_state,
    timer_pause_reason: timing.timer_pause_reason ?? null,
  };
}
