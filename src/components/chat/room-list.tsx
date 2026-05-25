"use client";

import * as React from "react";
import { Plus, Users } from "lucide-react";

import type { Room } from "@/lib/types";
import { cn, relativeTime, shortId } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  rooms: Room[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading?: boolean;
}

export function RoomList({ rooms, selectedId, onSelect, onNew, loading }: Props) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          rooms
        </h2>
        <Button size="sm" variant="ghost" onClick={onNew} title="new direct">
          <Plus />
          <span>new</span>
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <ul className="divide-y">
          {loading && (
            <li className="px-4 py-6 text-sm text-muted-foreground">loading…</li>
          )}
          {!loading && rooms.length === 0 && (
            <li className="px-4 py-6 text-sm text-muted-foreground">
              no rooms yet — click <strong>new</strong> to start a direct conversation.
            </li>
          )}
          {rooms.map((r) => (
            <li key={r.room_id}>
              <button
                onClick={() => onSelect(r.room_id)}
                className={cn(
                  "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                  selectedId === r.room_id
                    ? "bg-secondary"
                    : "hover:bg-secondary/60",
                )}
              >
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
                  {r.kind === "group" ? (
                    <Users className="h-4 w-4" />
                  ) : (
                    <span className="text-xs font-medium">
                      {(r.name || r.room_id).slice(0, 2).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {r.name || shortId(r.room_id)}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {relativeTime(r.updated_at)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.kind === "direct" ? "direct" : r.topic || "group"}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </aside>
  );
}
