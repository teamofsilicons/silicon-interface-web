"use client";

import * as React from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { roomDisplay } from "@/lib/peers";
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
  /** The message being forwarded — needed for forward_from metadata. */
  event: Event | null;
  /** Rooms the user can forward into (excludes the source). */
  rooms: Room[];
  /** The current room id, excluded from the picker. */
  sourceRoomId: string;
}

/**
 * Forward picker. Users multi-select rooms to forward into; the same source
 * content is re-posted to each target with a forward_from chip rendered on
 * the receiving bubble (Telegram-style).
 */
export function ForwardDialog({ open, onOpenChange, event, rooms, sourceRoomId }: Props) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected(new Set());
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
    if (!event || selected.size === 0) return;
    setSending(true);
    try {
      const forwardFrom = {
        room_id: sourceRoomId,
        event_id: event.event_id,
        sender_kind: event.sender_kind,
        sender_handle: event.sender_handle,
      };
      // Re-post into each selected room. The original event type/content is
      // preserved; we just stash forward_from for the receiver to render.
      const content = { ...(event.content as object), forward_from: forwardFrom };
      // QA §7.7: the old code `.catch`'d each send and used Promise.all, so the
      // aggregate always resolved and "forwarded to N chats" fired even when
      // every send failed (the user saw N error toasts AND a success toast).
      // Use allSettled and report the real success/failure split.
      const targets = Array.from(selected);
      const results = await Promise.allSettled(
        targets.map((rid) => api.sendEvent(rid, { type: event.type, content })),
      );
      const failures = results.filter((r) => r.status === "rejected");
      const ok = results.length - failures.length;

      if (ok > 0) {
        toast.success(`forwarded to ${ok} ${ok === 1 ? "chat" : "chats"}`);
      }
      if (failures.length > 0) {
        // Surface the first real error message; the rest are almost always the
        // same transient cause, and N stacked toasts is noise.
        const first = failures[0] as PromiseRejectedResult;
        const reason = first.reason;
        const detail = reason instanceof ApiError ? reason.message : "forward failed";
        toast.error(
          `couldn't forward to ${failures.length} ${failures.length === 1 ? "chat" : "chats"} — ${detail}`,
        );
      }

      // Only dismiss when everything went through; on partial/total failure
      // keep the picker open so the user can retry the rest.
      if (failures.length === 0) onOpenChange(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-md overflow-hidden p-0">
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
        <ul className="max-h-[40vh] overflow-y-auto py-1">
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
