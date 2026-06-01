"use client";

import * as React from "react";
import { Check, Checks, Eye, Microphone } from "@phosphor-icons/react/dist/ssr";

import type { Room } from "@/lib/types";
import { roomDisplay } from "@/lib/peers";
import { cn, relativeTime } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IdAvatar } from "@/components/profile/id-avatar";

interface Props {
  rooms: Room[];
  /** My handle, to tell whether the latest message is mine (→ show a tick). */
  myHandle?: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading?: boolean;
  className?: string;
  /** Set when a file is being dragged over a row; we use it to switch into
   *  that room after a brief hold (see chat page). */
  hoverRoomId?: string | null;
  onRoomDragEnter?: (roomId: string) => void;
  onRoomDragLeave?: (roomId: string) => void;
}

export function RoomList({
  rooms,
  myHandle,
  selectedId,
  onSelect,
  onNew,
  loading,
  className,
  hoverRoomId,
  onRoomDragEnter,
  onRoomDragLeave,
}: Props) {
  // Empty state lives outside the ScrollArea so it can flex-center within
  // the remaining sidebar height instead of sitting at the top with manual
  // py-16 padding.
  if (!loading && rooms.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm text-muted-foreground">No conversations yet.</p>
          <Button onClick={onNew}>Start a new chat</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <ScrollArea className="flex-1">
        <ul className="divide-y">
          {loading && (
            <li className="py-6 pl-6 pr-4 text-sm text-muted-foreground">loading…</li>
          )}
          {rooms.map((r) => {
            const d = roomDisplay(r);
            const isHover = hoverRoomId === r.room_id;
            const unread = r.unread_count ?? (r.unread ? 1 : 0);
            // The latest message is mine when its sender handle matches me — in
            // that case the right slot shows a send-status tick instead of a
            // badge (✓✓ once the other side has read it, ✓ until then).
            const mineLast =
              !!myHandle && r.last_event?.sender_handle === myHandle;
            return (
              <li key={r.room_id}>
                <button
                  type="button"
                  onClick={() => onSelect(r.room_id)}
                  onDragEnter={(e) => {
                    // Only the file-drag case matters — text/link drags from
                    // within the page would otherwise also fire this.
                    if (e.dataTransfer?.types?.includes("Files")) {
                      onRoomDragEnter?.(r.room_id);
                    }
                  }}
                  onDragLeave={() => onRoomDragLeave?.(r.room_id)}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 py-3 pl-6 pr-4 text-left transition-colors",
                    selectedId === r.room_id
                      ? "bg-secondary"
                      : isHover
                        ? "bg-accent"
                        : "hover:bg-secondary/60",
                  )}
                >
                  <IdAvatar
                    seed={d.handle}
                    src={d.photoUrl}
                    size={36}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {r.observed && (
                          <Eye
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label="observing (read-only)"
                          />
                        )}
                        <span
                          className={cn(
                            "truncate text-sm",
                            unread > 0 ? "font-semibold" : "font-medium",
                          )}
                        >
                          {d.name}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-[10px]",
                          unread > 0
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {relativeTime(r.last_event?.at ?? r.updated_at)}
                      </span>
                    </div>
                    {/* Last-message preview (one line, type-aware) + unread
                        badge. Preview falls back to the static subtitle when
                        the room has no events. */}
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          "truncate text-xs",
                          unread > 0 ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {r.last_event?.type === "m.voice" ? (
                          <span className="inline-flex items-center gap-1 align-middle">
                            <Microphone className="h-3 w-3 shrink-0" /> voice note
                          </span>
                        ) : (
                          r.last_event?.preview || d.subtitle
                        )}
                      </p>
                      {unread > 0 ? (
                        <span
                          className="inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-none text-primary-foreground"
                          aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
                        >
                          {unread > 99 ? "99+" : unread}
                        </span>
                      ) : mineLast ? (
                        r.last_event?.read ? (
                          <Checks
                            weight="bold"
                            className="h-4 w-4 shrink-0 text-foreground"
                            aria-label="read"
                          />
                        ) : (
                          <Check
                            weight="bold"
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-label="sent"
                          />
                        )
                      ) : null}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}
