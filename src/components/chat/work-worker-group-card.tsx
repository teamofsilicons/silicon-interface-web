"use client";

import * as React from "react";
import { UsersThree } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

import {
  WorkCardHeader,
  WorkDetailsDialog,
  WorkStateIcon,
  WorkTimerFooter,
  workStateLabel,
} from "./work-update-shared";
import type { WorkWorkerGroupView, WorkWorkerView } from "./work-update-types";

function WorkerRow({ worker }: { worker: WorkWorkerView }) {
  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2 border-b px-3.5 py-2.5 last:border-b-0",
        worker.state === "in_progress" && "bg-secondary/45",
      )}
    >
      <WorkStateIcon state={worker.state} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="min-w-0 break-words text-sm font-medium">{worker.name}</p>
          {worker.task ? <p className="min-w-0 truncate text-xs text-muted-foreground">{worker.task}</p> : null}
        </div>
        {worker.currentActivity ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" aria-live="polite">
            {worker.currentActivity}
          </p>
        ) : null}
      </div>
      <span className="sr-only">{workStateLabel(worker.state)}</span>
      <WorkDetailsDialog
        title={worker.name}
        description={worker.description}
        currentActivity={worker.currentActivity}
        state={worker.state}
        history={worker.history}
        triggerLabel={`Open activity for worker ${worker.name}`}
      />
    </li>
  );
}

export interface WorkWorkerGroupCardProps {
  group: WorkWorkerGroupView;
  className?: string;
}

/** Persistent worker group with independently updating worker rows. */
export function WorkWorkerGroupCard({ group, className }: WorkWorkerGroupCardProps) {
  const headingId = React.useId();
  const active = group.workers.filter((worker) => worker.state === "in_progress").length;
  const completed = group.workers.filter((worker) => worker.state === "completed").length;

  return (
    <article
      className={cn("w-full max-w-[36rem] overflow-hidden border bg-elevated shadow-sm", className)}
      aria-labelledby={headingId}
      data-work-event-id={group.id}
      data-work-event-kind="worker_group"
    >
      <div>
        <WorkCardHeader
          headingId={headingId}
          taskTitle={group.taskTitle}
          history={group.history}
          description={group.description}
          dialogTitle={`${group.taskTitle} · workers`}
          dialogChildren={
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {completed} completed, {active} active, {group.workers.length} total.
              </p>
              {group.content}
            </div>
          }
        />
      </div>
      {group.description ? <p className="border-b px-3.5 py-2.5 text-sm text-muted-foreground">{group.description}</p> : null}
      <div className="flex items-center gap-2 border-b bg-secondary/35 px-3.5 py-2.5">
        <UsersThree className="h-5 w-5" weight="fill" aria-hidden />
        <h4 className="text-sm font-semibold">
          Started {group.workers.length} {group.workers.length === 1 ? "worker" : "workers"}
        </h4>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {completed}/{group.workers.length} DONE
        </span>
      </div>
      {group.workers.length ? (
        <ul aria-label="Workers">
          {group.workers.map((worker) => (
            <WorkerRow key={worker.id} worker={worker} />
          ))}
        </ul>
      ) : (
        <p className="px-3.5 py-4 text-sm text-muted-foreground">No workers were included.</p>
      )}
      <WorkTimerFooter timer={group.timer} />
    </article>
  );
}
