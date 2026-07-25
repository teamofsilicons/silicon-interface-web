"use client";

import * as React from "react";
import { CheckCircle, ChatCenteredText } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { WorkConfettiButton } from "./work-confetti";
import {
  WorkCardHeader,
  WorkHistory,
  WorkNoticeIcon,
  WorkRichContent,
  WorkStateIcon,
  WorkTimerFooter,
  workStateLabel,
} from "./work-update-shared";
import type {
  WorkPersistentEventKind,
  WorkPersistentEventView,
  WorkTaskState,
} from "./work-update-types";

const presentation: Record<
  WorkPersistentEventKind,
  { label: string; state?: WorkTaskState; labelClass: string }
> = {
  milestone: {
    label: "UPDATE",
    labelClass: "bg-foreground text-background",
  },
  blocker: {
    label: "BLOCKER",
    state: "blocked",
    labelClass: "bg-warning text-foreground",
  },
  completion: {
    label: "COMPLETED",
    state: "completed",
    labelClass: "bg-success text-background",
  },
  failure: {
    label: "FAILED",
    state: "failed",
    labelClass: "bg-destructive text-destructive-foreground",
  },
  cancellation: {
    label: "CANCELLED",
    state: "cancelled",
    labelClass: "bg-muted-foreground text-background",
  },
};

export interface WorkStatusCardProps {
  event: WorkPersistentEventView;
  className?: string;
  /** Focus/select the matching blocker in the composer. Resolution remains Silicon-controlled. */
  onReply?: (blockerId: string) => void;
}

/** Persistent milestone, blocker, or terminal-state message card. */
export function WorkStatusCard({ event, className, onReply }: WorkStatusCardProps) {
  const headingId = React.useId();
  const baseConfig = presentation[event.kind];
  const config = event.kind === "blocker" && event.resolved
    // Resolving a blocker says nothing about the parent task's state: it may
    // resume, remain blocked by another blocker, or already be terminal.
    ? { ...baseConfig, label: "BLOCKER · RESOLVED", state: undefined }
    : baseConfig;
  const terminal = event.kind === "completion" || event.kind === "failure" || event.kind === "cancellation";
  const taskState = event.task?.state ?? config.state;

  return (
    <article
      className={cn(
        "w-full max-w-[36rem] overflow-hidden border bg-elevated text-foreground shadow-sm",
        event.kind === "blocker" && "border-foreground/40",
        event.kind === "failure" && "border-destructive/60",
        className,
      )}
      aria-labelledby={headingId}
      data-work-event-id={event.id}
      data-work-event-kind={event.kind}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3.5 py-1.5 font-mono text-[10px] font-semibold tracking-[0.14em]",
          config.labelClass,
        )}
      >
        {(event.kind === "blocker" || event.kind === "failure" || event.kind === "cancellation") && (
          <WorkNoticeIcon kind={event.kind} />
        )}
        <span>{config.label}</span>
      </div>

      <div>
        <WorkCardHeader
          headingId={headingId}
          taskTitle={event.taskTitle}
          taskState={taskState}
          description={event.task?.description ?? event.description}
          currentActivity={event.task?.currentActivity}
          history={event.task?.history ?? event.history}
          dialogTitle={event.task ? event.taskTitle : `${event.taskTitle} · ${config.label.toLocaleLowerCase()}`}
          dialogChildren={event.task ? (
            <div className="space-y-5">
              {event.task.items.length ? (
                <section aria-label="Task todo">
                  <h3 className="label-mono mb-2 text-[10px] tracking-wide text-muted-foreground">
                    TASK TODO
                  </h3>
                  <ul className="border">
                    {event.task.items.map((item) => (
                      <li key={item.id} className="flex min-w-0 items-center gap-2 border-b px-3 py-2 last:border-b-0">
                        <WorkStateIcon state={item.state} />
                        <span className="min-w-0 flex-1 break-words text-sm">{item.title}</span>
                        <span className="text-xs text-muted-foreground">{workStateLabel(item.state)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section aria-label={`${config.label.toLocaleLowerCase()} details`}>
                <h3 className="label-mono mb-2 text-[10px] tracking-wide text-muted-foreground">
                  THIS {config.label}
                </h3>
                <WorkRichContent description={event.description}>{event.content}</WorkRichContent>
                {event.history?.length ? (
                  <div className="mt-4">
                    <WorkHistory entries={event.history} />
                  </div>
                ) : null}
              </section>
            </div>
          ) : event.content}
        />
      </div>

      <div className={cn("px-4 py-4", event.kind === "completion" && "py-5")}>
        {event.kind === "completion" ? (
          <div className="flex min-w-0 items-start gap-3">
            <CheckCircle className="mt-0.5 h-9 w-9 shrink-0 text-success" weight="fill" aria-hidden />
            <div className="min-w-0 flex-1">
              <h4 className="text-base font-semibold">{event.title ?? "Completed"}</h4>
              <WorkRichContent description={event.description} className="mt-1" />
              {event.content ? <div className="mt-3 grid min-w-0 gap-2 [&>*]:max-w-full">{event.content}</div> : null}
            </div>
          </div>
        ) : (
          <>
            {event.title ? <h4 className="mb-1.5 break-words text-sm font-semibold">{event.title}</h4> : null}
            <WorkRichContent description={event.description}>{event.content}</WorkRichContent>
            {!event.title && !event.description && !event.content ? (
              <p className="text-sm text-muted-foreground">No additional details were provided.</p>
            ) : null}
          </>
        )}

        {event.kind === "blocker" && onReply && !event.resolved ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() => onReply(event.blockerId ?? event.id)}
          >
            <ChatCenteredText aria-hidden />
            Reply to blocker
          </Button>
        ) : null}
      </div>

      {event.kind === "completion" ? (
        <div className="flex items-stretch border-t">
          <WorkTimerFooter timer={event.timer} terminal className="min-w-0 flex-1 border-t-0" />
          <WorkConfettiButton />
        </div>
      ) : event.kind !== "milestone" ? (
        <WorkTimerFooter timer={event.timer} terminal={terminal} />
      ) : null}
    </article>
  );
}

export type WorkUpdateCardProps = Omit<WorkStatusCardProps, "event"> & {
  event: WorkPersistentEventView & { kind: "milestone" };
};

export function WorkUpdateCard(props: WorkUpdateCardProps) {
  return <WorkStatusCard {...props} />;
}

export type WorkBlockerCardProps = Omit<WorkStatusCardProps, "event"> & {
  event: WorkPersistentEventView & { kind: "blocker" };
};

export function WorkBlockerCard(props: WorkBlockerCardProps) {
  return <WorkStatusCard {...props} />;
}

export type WorkCompletionCardProps = Omit<WorkStatusCardProps, "event" | "onReply"> & {
  event: WorkPersistentEventView & { kind: "completion" };
};

export function WorkCompletionCard(props: WorkCompletionCardProps) {
  return <WorkStatusCard {...props} />;
}

export type WorkFailureCardProps = Omit<WorkStatusCardProps, "event" | "onReply"> & {
  event: WorkPersistentEventView & { kind: "failure" };
};

export function WorkFailureCard(props: WorkFailureCardProps) {
  return <WorkStatusCard {...props} />;
}

export type WorkCancellationCardProps = Omit<WorkStatusCardProps, "event" | "onReply"> & {
  event: WorkPersistentEventView & { kind: "cancellation" };
};

export function WorkCancellationCard(props: WorkCancellationCardProps) {
  return <WorkStatusCard {...props} />;
}
