"use client";

import * as React from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { roomDisplay } from "@/lib/peers";
import { maintenanceQueueAcknowledgement } from "@/lib/silicon-maintenance";
import type { Event, Room } from "@/lib/types";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IdAvatar } from "@/components/profile/id-avatar";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source message. Server-side forwarding resolves bundled attachments. */
  event: Event | null;
  /**
   * Multi-select source messages. When provided (and non-empty) this takes
   * precedence over `event`; otherwise the single-`event` path is used. Each
   * message is forwarded to each target room server-side.
   */
  events?: Event[];
  /** Rooms the user can forward into (excludes the source). */
  rooms: Room[];
  /** The current room id, excluded from the picker. */
  sourceRoomId: string;
  /** Called after a FULL-success forward so the caller can exit select-mode. */
  onComplete?: () => void;
}

/**
 * Forward picker. Users multi-select rooms to forward into; the same source
 * event(s) are forwarded server-side so bundled attachments stay with the
 * visible message and the client never sends raw attachment URLs.
 */
export function ForwardDialog({ open, onOpenChange, event, events, rooms, sourceRoomId, onComplete }: Props) {
  const [query, setQuery] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sending, setSending] = React.useState(false);

  // Working set of source messages: prefer the multi-select list, fall back to
  // the single `event`. ULID `event_id`s sort lexicographically in send order,
  // so a plain sort lands them chronologically in every target room.
  const items = React.useMemo(() => {
    const list = events?.length ? events : event ? [event] : [];
    return [...list].sort((a, b) =>
      a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0,
    );
  }, [events, event]);

  React.useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setQuery("");
        setComment("");
        setSelected(new Set());
      });
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const candidates = rooms.filter((r) => r.room_id !== sourceRoomId);
    if (!q) return candidates;
    return candidates.filter((r) => {
      const d = roomDisplay(r);
      return (
        d.name.toLowerCase().includes(q) ||
        d.handle.toLowerCase().includes(q)
      );
    });
  }, [rooms, query, sourceRoomId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const out = new Set(prev);
      if (out.has(id)) out.delete(id);
      else out.add(id);
      return out;
    });
  };

  const submit = async () => {
    if (items.length === 0 || selected.size === 0) return;
    setSending(true);
    try {
      // QA §7.7: the old code `.catch`'d each send and used Promise.all, so the
      // aggregate always resolved and "forwarded to N chats" fired even when
      // every send failed. Promise.allSettled reports the real per-room split.
      const targets = Array.from(selected);
      const sourceEventIds = items.map((ev) => ev.event_id);
      const trimmedComment = comment.trim();
      const results = await Promise.allSettled(
        targets.map((rid) =>
          api.forwardEvents(
            rid,
            sourceRoomId,
            sourceEventIds,
            trimmedComment || undefined,
          ),
        ),
      );
      const failures = results.filter((r) => r.status === "rejected");
      const okRooms = results.length - failures.length;
      const msgN = items.length;
      const roomN = targets.length;
      const maintenanceAck = maintenanceQueueAcknowledgement(
        results.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        ),
      );

      if (failures.length === 0) {
        // Full success. Preserve the terse single-message wording; report both
        // counts once more than one message is forwarded.
        toast.success(
          msgN === 1
            ? `forwarded to ${roomN} ${roomN === 1 ? "chat" : "chats"}`
            : `forwarded ${msgN} messages to ${roomN} ${roomN === 1 ? "chat" : "chats"}`,
        );
        // Only dismiss + exit select-mode when everything went through.
        onOpenChange(false);
        onComplete?.();
      } else {
        if (okRooms > 0) {
          toast.success(
            `forwarded to ${okRooms} of ${roomN} ${roomN === 1 ? "chat" : "chats"}`,
          );
        }
        // Surface the first real error message; the rest are almost always the
        // same transient cause, and N stacked toasts is noise.
        const first = failures[0] as PromiseRejectedResult;
        const reason = first.reason;
        const detail = reason instanceof ApiError ? reason.message : "forward failed";
        toast.error(
          `couldn't forward to ${failures.length} ${failures.length === 1 ? "chat" : "chats"} - ${detail}`,
        );
        // On partial/total failure keep the picker open so the user can retry.
      }
      if (maintenanceAck) {
        const names = maintenanceAck.recipientNames;
        toast.info("Forwarded message safely queued", {
          id: `forward-maintenance-queued:${sourceRoomId}:${targets.join(",")}`,
          description:
            names.length === 1
              ? `${names[0]} is updating. ${maintenanceAck.message}`
              : maintenanceAck.message,
        });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-md flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Forward to…</DialogTitle>
          <DialogDescription>
            Pick the conversations to forward this message into. The original
            sender will be shown.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search conversations"
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              no conversations
            </li>
          )}
          {filtered.map((r) => {
            const d = roomDisplay(r);
            const peerKind = r.peers[0]?.kind ?? "carbon";
            const isSelected = selected.has(r.room_id);
            return (
              <li key={r.room_id}>
                <button
                  type="button"
                  // QA a11y: selection was conveyed by background color only.
                  // aria-pressed exposes the toggle state to screen readers.
                  aria-pressed={isSelected}
                  onClick={() => toggle(r.room_id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                    isSelected ? "bg-secondary" : "hover:bg-accent",
                  )}
                >
                  <IdAvatar seed={d.handle} src={d.photoUrl} asciiSrc={d.asciiUrl} size={32} family={peerKind} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{d.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {d.subtitle}
                    </div>
                  </div>
                  {isSelected && (
                    <span className="label-mono text-[10px] text-foreground">
                      selected
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t px-3 py-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="add a comment (optional)"
            maxLength={4000}
            rows={3}
            className="max-h-28 min-h-16 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center justify-between border-t px-4 py-3">
          <span className="label-mono text-[10px] text-muted-foreground">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
              cancel
            </Button>
            <Button onClick={submit} disabled={selected.size === 0 || sending}>
              forward
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
