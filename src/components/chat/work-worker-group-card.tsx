"use client";

import * as React from "react";
import { UsersThree } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

import {
  WorkDetailsDialog,
  WorkStateIcon,
  workStateLabel,
} from "./work-update-shared";
import type { WorkWorkerGroupView, WorkWorkerView } from "./work-update-types";

function WorkerRow({ worker }: { worker: WorkWorkerView }) {
  return (
    <li
      className={cn(
        "relative flex min-w-0 items-center gap-2 py-2 pl-1 pr-10",
        worker.state === "in_progress" && "text-foreground",
      )}
    >
      <WorkStateIcon state={worker.state} />
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-sm font-medium">{worker.name}</p>
      </div>
      <span className="sr-only">{workStateLabel(worker.state)}</span>
      <WorkDetailsDialog
        title={worker.name}
        description={worker.description}
        currentActivity={worker.currentActivity}
        state={worker.state}
        history={worker.history}
        triggerLabel={`Open activity for worker ${worker.name}`}
        triggerClassName="absolute inset-0 z-10 h-full w-full justify-end cursor-pointer bg-transparent px-2 hover:bg-foreground/[0.025] hover:text-foreground"
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
    <section
      className={cn("w-full max-w-[34rem]", className)}
      aria-labelledby={headingId}
      data-work-event-id={group.id}
      data-work-event-kind="worker_group"
    >
      <div className="relative flex min-h-10 min-w-0 items-center gap-2.5 pr-10">
        <UsersThree className="h-5 w-5 shrink-0" weight="regular" aria-hidden />
        <h3 id={headingId} className="min-w-0 flex-1 break-words text-sm font-medium">
          Started {group.workers.length} {group.workers.length === 1 ? "worker" : "workers"}
        </h3>
        <WorkDetailsDialog
          title={`${group.taskTitle} · workers`}
          description={group.description}
          history={group.history}
          triggerLabel={`Open worker details for ${group.taskTitle}`}
          triggerClassName="absolute inset-0 z-10 h-full w-full justify-end cursor-pointer bg-transparent px-2 hover:bg-foreground/[0.025] hover:text-foreground"
        >
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {completed} completed, {active} active, {group.workers.length} total.
            </p>
            {group.content}
          </div>
        </WorkDetailsDialog>
      </div>

      {group.workers.length ? (
        <ul
          aria-label="Workers"
          className="ml-2.5 border-l border-border/90 pl-3.5"
        >
          {group.workers.map((worker) => (
            <WorkerRow key={worker.id} worker={worker} />
          ))}
        </ul>
      ) : (
        <p className="ml-7 py-2 text-sm text-muted-foreground">No workers were included.</p>
      )}
      <span className="sr-only">
        {completed} completed, {active} active, {group.workers.length} total.
      </span>
    </section>
  );
}
