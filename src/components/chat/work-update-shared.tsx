"use client";

import * as React from "react";
import {
  CaretRight,
  CheckCircle,
  Circle,
  Clock,
  Hourglass,
  Pause,
  SpinnerGap,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react/dist/ssr";

import { MarkdownView } from "@/components/chat/markdown-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type {
  WorkHistoryEntry,
  WorkItemState,
  WorkTaskState,
  WorkTimer,
} from "./work-update-types";

type AnyWorkState = WorkTaskState | WorkItemState | "failed" | "cancelled";

const stateLabels: Record<AnyWorkState, string> = {
  queued: "Queued",
  running: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  yet_to_start: "Yet to start",
  in_progress: "In progress",
};

export function workStateLabel(state: AnyWorkState): string {
  return stateLabels[state];
}

export function WorkStateIcon({
  state,
  className,
}: {
  state: AnyWorkState;
  className?: string;
}) {
  const common = cn("h-4 w-4 shrink-0", className);
  if (state === "completed") {
    return <CheckCircle className={cn(common, "text-success")} weight="fill" aria-hidden />;
  }
  if (state === "blocked") {
    return <Pause className={cn(common, "text-foreground")} weight="fill" aria-hidden />;
  }
  if (state === "failed") {
    return <XCircle className={cn(common, "text-destructive")} weight="fill" aria-hidden />;
  }
  if (state === "cancelled") {
    return <XCircle className={cn(common, "text-muted-foreground")} aria-hidden />;
  }
  if (state === "in_progress" || state === "running") {
    return (
      <SpinnerGap
        className={cn(common, "animate-spin text-foreground motion-reduce:animate-none")}
        weight="bold"
        aria-hidden
      />
    );
  }
  if (state === "queued") {
    return <Hourglass className={cn(common, "text-muted-foreground")} aria-hidden />;
  }
  return <Circle className={cn(common, "text-muted-foreground")} aria-hidden />;
}

function parseInstant(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Advances only a running active-work timer. The explicit elapsed snapshot is
 * rendered during SSR, avoiding a hydration mismatch; wall time is added after
 * mount and then refreshed once per second.
 */
export function useLiveElapsedSeconds(timer?: WorkTimer): number {
  const [now, setNow] = React.useState<number | null>(null);
  const running = timer?.state === "running";
  const updatedAt = parseInstant(timer?.updatedAt);

  React.useEffect(() => {
    if (!running || updatedAt == null) return;
    // Schedule the first client reading rather than synchronously setting
    // state inside the effect. The wire snapshot remains the first paint.
    const firstTick = window.setTimeout(() => setNow(Date.now()), 0);
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearTimeout(firstTick);
      window.clearInterval(interval);
    };
  }, [running, updatedAt]);

  const base = Math.max(0, Math.floor(timer?.activeElapsedSeconds ?? 0));
  if (!running || updatedAt == null || now == null) return base;
  return base + Math.max(0, Math.floor((now - updatedAt) / 1_000));
}

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatEstimate(totalSeconds?: number): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "Not estimated";
  if (totalSeconds < 60) return "<1 min";
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const leftoverMinutes = minutes % 60;
  return leftoverMinutes ? `~${hours}h ${leftoverMinutes}m` : `~${hours}h`;
}

export function WorkTimerFooter({
  timer,
  terminal = false,
  className,
}: {
  timer?: WorkTimer;
  terminal?: boolean;
  className?: string;
}) {
  const elapsed = useLiveElapsedSeconds(timer);
  const paused = timer?.state === "paused";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3.5 py-2 font-mono text-[10px] tracking-wide text-muted-foreground",
        className,
      )}
    >
      {!terminal ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Clock className="h-3 w-3 shrink-0" aria-hidden />
          <span className="sr-only">Estimated active time: </span>
          {formatEstimate(timer?.estimateSeconds)}
        </span>
      ) : (
        <span>{timer?.state === "stopped" ? "ACTUAL TIME" : "ACTIVE TIME"}</span>
      )}
      <span
        className="inline-flex items-center gap-1.5 tabular-nums text-foreground"
        aria-label={`${terminal ? "Actual" : "Active elapsed"} time ${formatElapsed(elapsed)}${paused ? ", paused" : ""}`}
      >
        {paused && <Pause className="h-3 w-3" weight="fill" aria-hidden />}
        {formatElapsed(elapsed)}
      </span>
      {paused && timer?.pausedReason ? (
        <span className="basis-full normal-case tracking-normal text-muted-foreground">
          Paused: {timer.pausedReason}
        </span>
      ) : null}
    </div>
  );
}

function readableInstant(value: string | number): string {
  const parsed = parseInstant(value);
  if (parsed == null) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function machineInstant(value: string | number): string | undefined {
  const parsed = parseInstant(value);
  return parsed == null ? undefined : new Date(parsed).toISOString();
}

export function WorkHistory({
  entries,
  emptyLabel = "No earlier updates yet.",
}: {
  entries?: WorkHistoryEntry[];
  emptyLabel?: string;
}) {
  if (!entries?.length) {
    return <p className="py-4 text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ol className="relative border-l pl-4" aria-label="Update history">
      {entries.map((entry) => (
        <li key={entry.id} className="relative pb-5 last:pb-0">
          <span className="absolute -left-[1.18rem] top-1.5 h-1.5 w-1.5 bg-foreground" aria-hidden />
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <p className="min-w-0 break-words text-sm font-medium">
              {entry.title ?? entry.description ?? "Status updated"}
            </p>
            <time
              className="shrink-0 font-mono text-[10px] text-muted-foreground"
              dateTime={machineInstant(entry.at)}
            >
              {readableInstant(entry.at)}
            </time>
          </div>
          {entry.actor ? <p className="mt-0.5 text-xs text-muted-foreground">By {entry.actor}</p> : null}
          {entry.description && entry.title ? (
            <MarkdownView source={entry.description} compact className="mt-1.5" />
          ) : null}
          {entry.content ? <div className="mt-2 min-w-0">{entry.content}</div> : null}
        </li>
      ))}
    </ol>
  );
}

export function WorkDetailsDialog({
  title,
  description,
  currentActivity,
  state,
  history,
  triggerLabel,
  triggerClassName,
  children,
}: {
  title: string;
  description?: string;
  currentActivity?: string;
  state?: AnyWorkState;
  history?: WorkHistoryEntry[];
  triggerLabel: string;
  triggerClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            triggerClassName,
          )}
          aria-label={triggerLabel}
        >
          <CaretRight className="h-4 w-4" weight="bold" aria-hidden />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(86dvh,46rem)] w-[calc(100%-1.5rem)] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <div className="flex min-w-0 items-center gap-2">
            {state ? (
              <>
                <WorkStateIcon state={state} />
                <span className="sr-only">{workStateLabel(state)}.</span>
              </>
            ) : null}
            <DialogTitle className="min-w-0 break-words text-base">{title}</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Details and retained history for {title}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(min(86dvh,46rem)-4.25rem)]">
          <div className="space-y-5 px-5 py-5">
            {description ? <MarkdownView source={description} compact /> : null}
            {currentActivity ? (
              <div className="border-l-2 border-foreground bg-secondary/55 px-3 py-2.5">
                <p className="label-mono text-[10px] tracking-wide text-muted-foreground">HAPPENING NOW</p>
                <p className="mt-1 text-sm">{currentActivity}</p>
              </div>
            ) : null}
            {children}
            <section aria-label="History">
              <h3 className="label-mono mb-3 text-[10px] tracking-wide text-muted-foreground">HISTORY</h3>
              <WorkHistory entries={history} />
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export function WorkCardHeader({
  taskTitle,
  taskState,
  history,
  description,
  currentActivity,
  dialogTitle,
  dialogChildren,
  headingId,
  triggerCoversHeader = false,
  showStateIcon = true,
}: {
  taskTitle: string;
  taskState?: AnyWorkState;
  history?: WorkHistoryEntry[];
  description?: string;
  currentActivity?: string;
  dialogTitle?: string;
  dialogChildren?: React.ReactNode;
  headingId?: string;
  triggerCoversHeader?: boolean;
  showStateIcon?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2 border-b py-2.5 pl-3.5 pr-1.5",
        triggerCoversHeader && "relative pr-12",
      )}
    >
      {taskState && showStateIcon ? (
        <>
          <WorkStateIcon state={taskState} />
          <span className="sr-only">{workStateLabel(taskState)}.</span>
        </>
      ) : null}
      <h3 id={headingId} className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug">{taskTitle}</h3>
      <WorkDetailsDialog
        title={dialogTitle ?? taskTitle}
        description={description}
        currentActivity={currentActivity}
        state={taskState}
        history={history}
        triggerLabel={`Open details for ${taskTitle}`}
        triggerClassName={triggerCoversHeader
          ? "absolute inset-0 z-10 h-full w-full justify-end cursor-pointer bg-transparent px-3.5 hover:bg-foreground/[0.025] hover:text-foreground"
          : undefined}
      >
        {dialogChildren}
      </WorkDetailsDialog>
    </div>
  );
}

export function WorkRichContent({
  description,
  children,
  className,
}: {
  description?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  if (!description && !children) return null;
  return (
    <div className={cn("min-w-0 space-y-3", className)}>
      {description ? <MarkdownView source={description} compact /> : null}
      {children ? <div className="grid min-w-0 gap-2 [&>*]:max-w-full">{children}</div> : null}
    </div>
  );
}

export function WorkNoticeIcon({ kind }: { kind: "blocker" | "failure" | "cancellation" }) {
  if (kind === "blocker") return <WarningCircle className="h-3.5 w-3.5" weight="fill" aria-hidden />;
  if (kind === "failure") return <XCircle className="h-3.5 w-3.5" weight="fill" aria-hidden />;
  return <XCircle className="h-3.5 w-3.5" aria-hidden />;
}
