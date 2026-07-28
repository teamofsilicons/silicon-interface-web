"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

import {
  WorkCardHeader,
  WorkDetailsDialog,
  WorkStateIcon,
  WorkTimerFooter,
  workStateLabel,
} from "./work-update-shared";
import type { WorkChecklistItem, WorkTaskView } from "./work-update-types";

function WorkTodoRow({ item }: { item: WorkChecklistItem }) {
  return (
    <li
      className={cn(
        "relative flex min-w-0 items-center gap-2 border-b py-2.5 pl-3.5 pr-12 last:border-b-0",
        item.state === "in_progress" && "bg-secondary/45",
      )}
    >
      <WorkStateIcon state={item.state} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "break-words text-sm leading-snug",
            item.state === "completed" && "text-muted-foreground",
          )}
        >
          {item.title}
        </p>
        {item.currentActivity ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" aria-live="polite">
            {item.currentActivity}
          </p>
        ) : null}
      </div>
      <span className="sr-only">{workStateLabel(item.state)}</span>
      <WorkDetailsDialog
        title={item.title}
        description={item.description}
        currentActivity={item.currentActivity}
        state={item.state}
        history={item.history}
        triggerLabel={`Open details for todo item ${item.title}`}
        triggerClassName="absolute inset-0 z-10 h-full w-full justify-end cursor-pointer bg-transparent px-3.5 hover:bg-foreground/[0.025] hover:text-foreground"
      />
    </li>
  );
}

export interface WorkTaskCardProps {
  task: WorkTaskView;
  className?: string;
}

/** Durable, live-updating root task card with per-item retained history. */
export function WorkTaskCard({ task, className }: WorkTaskCardProps) {
  const headingId = React.useId();
  const complete = task.items.filter((item) => item.state === "completed").length;

  return (
    <article
      className={cn(
        "w-full max-w-[34rem] overflow-hidden border bg-elevated text-foreground shadow-xs",
        className,
      )}
      aria-labelledby={headingId}
      data-work-task-id={task.id}
      data-work-revision={task.revision}
    >
      <div>
        <WorkCardHeader
          headingId={headingId}
          taskTitle={task.title}
          taskState={task.state}
          description={task.description}
          currentActivity={task.currentActivity}
          history={task.history}
          triggerCoversHeader
          showStateIcon={false}
          dialogChildren={
            task.items.length ? (
              <section aria-label="Todo summary">
                <h3 className="label-mono mb-2 text-[10px] tracking-wide text-muted-foreground">
                  TODO · {complete}/{task.items.length}
                </h3>
                <ul className="border">
                  {task.items.map((item) => (
                    <li key={item.id} className="flex min-w-0 items-center gap-2 border-b px-3 py-2 last:border-b-0">
                      <WorkStateIcon state={item.state} />
                      <span className="min-w-0 flex-1 break-words text-sm">{item.title}</span>
                      <span className="text-xs text-muted-foreground">{workStateLabel(item.state)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : undefined
          }
        />
      </div>

      {task.items.length ? (
        <>
          <p className="sr-only" aria-live="polite">
            {complete} of {task.items.length} todo items completed
          </p>
          <ul aria-label={`${task.title} todo`}>
            {task.items.map((item) => (
              <WorkTodoRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      ) : (
        <div className="px-3.5 py-4 text-sm text-muted-foreground">No todo items yet.</div>
      )}

      <WorkTimerFooter timer={task.timer} terminal={task.state === "completed" || task.state === "failed" || task.state === "cancelled"} />
    </article>
  );
}
