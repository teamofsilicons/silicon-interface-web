"use client";

import * as React from "react";
import {
  BookOpenText,
  Brain,
  CaretRight,
  GitBranch,
  MagnifyingGlass,
  PencilSimpleLine,
  Phone,
  SpinnerGap,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import type { Icon } from "@phosphor-icons/react";

import { IdAvatar } from "@/components/profile/id-avatar";
import { cn } from "@/lib/utils";

import type { WorkActivityKind, WorkManagerActivity } from "./work-update-types";

const activityIcons: Record<WorkActivityKind, Icon> = {
  thinking: Brain,
  reading: BookOpenText,
  writing: PencilSimpleLine,
  spawning_worker: GitBranch,
  calling: Phone,
  tool: TerminalWindow,
  other: MagnifyingGlass,
};

function activityTime(value?: string | number): string {
  if (value == null) return "";
  const instant = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(instant)) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(instant);
}

export interface WorkManagerActivityListProps {
  activities: WorkManagerActivity[];
  className?: string;
  initiallyExpanded?: boolean;
  avatarSeed?: string;
  avatarSrc?: string | null;
  avatarAsciiSrc?: string | null;
  avatarFamily?: "carbon" | "silicon";
  summaryActivityId?: string;
  summaryActivity?: WorkManagerActivity;
}

/**
 * Manager activity stays as a quiet, single-line live status until the user
 * chooses to expand its retained, safe history (never raw reasoning).
 */
export function WorkManagerActivityList({
  activities,
  className,
  initiallyExpanded,
  avatarSeed,
  avatarSrc,
  avatarAsciiSrc,
  avatarFamily = "silicon",
  summaryActivityId,
  summaryActivity,
}: WorkManagerActivityListProps) {
  const [expanded, setExpanded] = React.useState(initiallyExpanded ?? false);
  const historyId = React.useId();
  const current = [...activities].reverse().find((entry) => entry.state === "active") ??
    summaryActivity ??
    activities.find((entry) => entry.id === summaryActivityId) ??
    activities.at(-1);
  if (!current) return null;

  return (
    <section
      className={cn("flex w-full max-w-[32rem] items-start gap-2", className)}
      aria-label="Manager activity"
    >
      {avatarSeed ? (
        <IdAvatar
          seed={avatarSeed}
          src={avatarSrc}
          asciiSrc={avatarAsciiSrc}
          size={28}
          family={avatarFamily}
          className="mt-0.5"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="group -ml-1 flex min-h-8 max-w-full items-center gap-1.5 rounded-sm px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-expanded={expanded}
          aria-controls={historyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {current.state === "failed" ? (
            <WarningCircle className="h-4 w-4 shrink-0 text-destructive" weight="fill" aria-hidden />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate text-sm leading-6",
              current.state === "active" && "manager-activity-shimmer",
              current.state === "failed" && "text-destructive",
            )}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {current.label}
          </span>
          <CaretRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-[transform,color] group-hover:text-foreground motion-reduce:transition-none",
              expanded && "rotate-90",
            )}
            weight="bold"
            aria-hidden
          />
        </button>

        {expanded ? (
          <ol
            id={historyId}
            className="mt-1 border-l border-border/80 pl-3"
            aria-label="Manager activity history"
          >
            {activities.map((activity) => {
              const ActivityIcon = activityIcons[activity.kind];
              return (
                <li key={activity.id} className="flex min-w-0 gap-2 py-1.5">
                  {activity.state === "active" ? (
                    <SpinnerGap className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" weight="bold" aria-hidden />
                  ) : activity.state === "failed" ? (
                    <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" weight="fill" aria-hidden />
                  ) : (
                    <ActivityIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline justify-between gap-3">
                      <p className="min-w-0 break-words text-[13px] leading-5">{activity.label}</p>
                      {activity.at ? (
                        <time className="shrink-0 font-mono text-[9px] text-muted-foreground">
                          {activityTime(activity.at)}
                        </time>
                      ) : null}
                    </div>
                    {activity.description ? (
                      <p className="break-words text-xs leading-5 text-muted-foreground">{activity.description}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </section>
  );
}
