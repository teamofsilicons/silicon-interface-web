"use client";

import * as React from "react";
import { Clock } from "@phosphor-icons/react/dist/ssr";

import type { Cron } from "@/lib/types";

// Render the next fire instant in the *viewer's* own timezone (the browser
// zone). A cron set at "5pm" by a GMT+5:30 carbon shows as 5:00 PM to them and
// 3:00 PM to a GMT+3:30 viewer — same instant, localized.
function formatNext(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function cronRepeatLabel(trigger: string): string {
  const parts = trigger.trim().split(/\s+/);
  if (parts.length !== 5) return "custom repeat";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const every = (value: string) => value === "*";
  const stepped = (value: string, unit: string) => {
    const match = value.match(/^\*\/(\d+)$/);
    return match ? `every ${match[1]} ${unit}${match[1] === "1" ? "" : "s"}` : null;
  };

  if (every(minute) && every(hour) && every(dayOfMonth) && every(month) && every(dayOfWeek)) {
    return "every minute";
  }

  const minuteStep = stepped(minute, "minute");
  if (minuteStep && every(hour) && every(dayOfMonth) && every(month) && every(dayOfWeek)) {
    return minuteStep;
  }

  if (!every(minute) && every(hour) && every(dayOfMonth) && every(month) && every(dayOfWeek)) {
    return "hourly";
  }

  const hourStep = stepped(hour, "hour");
  if (!every(minute) && hourStep && every(dayOfMonth) && every(month) && every(dayOfWeek)) {
    return hourStep;
  }

  if (!every(minute) && !every(hour) && every(dayOfMonth) && every(month) && dayOfWeek === "1-5") {
    return "weekdays";
  }

  if (!every(minute) && !every(hour) && every(dayOfMonth) && every(month) && every(dayOfWeek)) {
    return "daily";
  }

  const weeklyDays = dayNames(dayOfWeek);
  if (!every(minute) && !every(hour) && every(dayOfMonth) && every(month) && weeklyDays.length > 0) {
    return weeklyDays.length === 1 ? `every ${weeklyDays[0]}` : `weekly: ${weeklyDays.join(", ")}`;
  }

  if (!every(minute) && !every(hour) && !every(dayOfMonth) && every(month) && every(dayOfWeek)) {
    return `monthly on day ${dayOfMonth}`;
  }

  if (!every(minute) && !every(hour) && !every(dayOfMonth) && !every(month) && every(dayOfWeek)) {
    return "yearly";
  }

  return "custom repeat";
}

function dayNames(value: string): string[] {
  if (value.includes("-")) {
    const [start, end] = value.split("-", 2).map(dayIndex);
    if (start == null || end == null) return [];
    const days: string[] = [];
    if (start <= end) {
      for (let i = start; i <= end; i += 1) days.push(DOW_LABELS[i]);
    } else {
      for (let i = start; i <= 6; i += 1) days.push(DOW_LABELS[i]);
      for (let i = 0; i <= end; i += 1) days.push(DOW_LABELS[i]);
    }
    return days;
  }
  return value
    .split(",")
    .map(dayIndex)
    .filter((day): day is number => day != null)
    .map((day) => DOW_LABELS[day]);
}

function dayIndex(value: string): number | null {
  const lower = value.toLowerCase();
  if (lower in DOW_ALIASES) return DOW_ALIASES[lower];
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return null;
  if (numeric === 7) return 0;
  return numeric >= 0 && numeric <= 6 ? numeric : null;
}

/**
 * Read-only list of crons, shared by the silicon-chat cron drawer and the team
 * view. Carbons can't create crons, so the list always ends with a hint to ask
 * a silicon.
 */
export function CronList({
  crons,
  loading = false,
  showSilicon = false,
}: {
  crons: Cron[];
  loading?: boolean;
  showSilicon?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {loading ? (
        <div className="text-sm text-muted-foreground">loading crons…</div>
      ) : crons.length === 0 ? (
        <div className="border bg-muted/40 p-4 text-sm text-muted-foreground">
          no crons yet.
        </div>
      ) : (
        crons.map((c) => {
          const next = formatNext(c.next_run);
          const repeat = cronRepeatLabel(c.trigger);
          return (
            <div key={c.cron_id} className="flex items-start gap-3 border p-3">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">{c.task}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {next && <span>next: {next}</span>}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{repeat}</span>
                  {showSilicon && <span>· set by {c.setup_by?.name ?? "a silicon"}</span>}
                </p>
              </div>
            </div>
          );
        })
      )}
      <p className="pt-1 text-center text-xs text-muted-foreground">
        talk with your silicons to add a CRON
      </p>
    </div>
  );
}
