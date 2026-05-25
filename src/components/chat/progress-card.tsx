"use client";

import * as React from "react";
import { Activity, Sparkles } from "lucide-react";

import type { ProgressState } from "@/lib/types";

export interface ProgressEntry {
  groupId: string;
  state: ProgressState;
  note: string;
  updatedAt: number;
}

interface Props {
  entries: ProgressEntry[];
}

export function ProgressCard({ entries }: Props) {
  if (entries.length === 0) return null;
  return (
    <div className="my-2 space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        live progress
      </div>
      {entries.map((e) => (
        <div key={e.groupId} className="flex items-center gap-2 text-xs">
          <Sparkles className="h-3 w-3 text-primary" />
          <span className="font-medium">{e.state.replaceAll("_", " ")}</span>
          {e.note ? <span className="text-muted-foreground">— {e.note}</span> : null}
          <span className="ml-auto text-[10px] text-muted-foreground">{e.groupId}</span>
        </div>
      ))}
    </div>
  );
}
