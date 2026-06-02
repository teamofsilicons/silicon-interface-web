"use client";

import * as React from "react";
import { Clock } from "@phosphor-icons/react/dist/ssr";

import type { Cron } from "@/lib/types";

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
        crons.map((c) => (
          <div key={c.cron_id} className="flex items-start gap-3 border p-3">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm">{c.task}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{c.trigger}</code>
                {showSilicon && <span>· set by {c.setup_by?.name ?? "a silicon"}</span>}
              </p>
            </div>
          </div>
        ))
      )}
      <p className="pt-1 text-center text-xs text-muted-foreground">
        talk with your silicons to add a CRON
      </p>
    </div>
  );
}
