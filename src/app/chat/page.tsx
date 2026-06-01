"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playReceived } from "@/lib/sounds";
import type { Event, Room } from "@/lib/types";
import { useChatSocket } from "@/lib/ws";
import { useTeams } from "@/lib/use-teams";
import { cn } from "@/lib/utils";

// Message types that count toward the unread badge + drive the sidebar
// preview. Mirrors the backend projection (reactions / system / markers /
// progress never count).
const COUNTABLE_TYPES = new Set(["m.text", "m.image", "m.file", "m.voice", "m.tts"]);

function isCountableEvent(ev: Event): boolean {
  return COUNTABLE_TYPES.has(ev.type) && !ev.redacted_at;
}

/** Client-side one-line preview for a live event frame — mirrors Glass's
 *  `_event_preview` so an instantly-patched row reads the same as a refetch.
 *  Returns null for events that shouldn't replace the existing preview. */
function eventPreview(ev: Event): string | null {
  if (ev.redacted_at) return null;
  const c = ev.content as Record<string, unknown>;
  switch (ev.type) {
    case "m.text": {
      const body = String(c.body ?? "").trim();
      return body.length > 120 ? `${body.slice(0, 120)}…` : body;
    }
    case "m.image": {
      const cap = String(c.caption ?? "").trim();
      return cap ? `📷 ${cap}` : "📷 photo";
    }
    case "m.file": {
      const cap = String(c.caption ?? "").trim();
      return cap ? `📎 ${cap}` : "📎 attachment";
    }
    case "m.voice":
      return "🎙 voice note";
    case "m.tts": {
      const t = String(c.text ?? "").trim();
      return t ? `🔊 ${t.slice(0, 80)}` : "🔊 audio";
    }
    default:
      return null;
  }
}

import { RoomList } from "@/components/chat/room-list";
import { NewDirectDialog } from "@/components/chat/new-direct-dialog";
import { RoomView } from "@/components/chat/room-view";
import { TeamFilterBar, EMPTY_FILTERS, type ChatFilters } from "@/components/teams/team-filter-bar";
import { TeamPanel } from "@/components/teams/team-panel";

// Resizable sidebar bounds + storage. Width persists across reloads.
const SB_DEFAULT = 320;
const SB_MIN = 240;
const SB_MAX = 560;
const SB_STORAGE = "silicon-interface:sidebar-width";

function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SB_DEFAULT;
  const v = Number(window.localStorage.getItem(SB_STORAGE));
  return Number.isFinite(v) && v >= SB_MIN && v <= SB_MAX ? v : SB_DEFAULT;
}

// Suspense wrapper so `useSearchParams()` (reads ?room=…) doesn't bail
// static prerender.
export default function ChatPage() {
  return (
    <React.Suspense fallback={null}>
      <ChatPageInner />
    </React.Suspense>
  );
}

function ChatPageInner() {
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get("room");
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<ChatFilters>(EMPTY_FILTERS);
  const [panelSlug, setPanelSlug] = React.useState<string | null>(null);
  const [sidebarW, setSidebarW] = React.useState<number>(loadSidebarWidth);
  // Sidebar search — filters the conversation list by display name, handle,
  // or last message body.
  const [sidebarQuery, setSidebarQuery] = React.useState("");
  // Hover-to-switch while dragging a file over a sidebar row.
  const [hoverRoomId, setHoverRoomId] = React.useState<string | null>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const socket = useChatSocket();
  const { teams } = useTeams();
  const { carbon } = useAuth();
  const myUsername = carbon?.username ?? null;

  // Refs so the WS frame handler can read the latest rooms/selection without
  // re-subscribing the effect (which would risk re-processing the same frame).
  const roomsRef = React.useRef<Room[]>(rooms);
  React.useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);
  const selectedRef = React.useRef<string | null>(selected);
  React.useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  // Event ids already folded into the sidebar — guards against double-counting
  // if the effect re-runs for the same frame.
  const processedRef = React.useRef<Set<string>>(new Set());

  const clearHover = React.useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverRoomId(null);
  }, []);

  // Drop / dragend anywhere cleans the in-flight hover-switch timer so we
  // don't accidentally swap rooms after the drag is over.
  React.useEffect(() => {
    const reset = () => clearHover();
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [clearHover]);

  const onRoomDragEnter = React.useCallback(
    (roomId: string) => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      setHoverRoomId(roomId);
      // 1.2s threshold matches the user's mental model: long enough to avoid
      // accidental switches while gliding through the list, short enough to
      // feel responsive once they hold deliberately.
      hoverTimerRef.current = setTimeout(() => {
        if (roomId !== selected) router.push(`/chat?room=${roomId}`);
        hoverTimerRef.current = null;
      }, 1200);
    },
    [router, selected],
  );
  const onRoomDragLeave = React.useCallback(
    (roomId: string) => {
      if (hoverRoomId === roomId) clearHover();
    },
    [hoverRoomId, clearHover],
  );

  // Drag the right edge of the sidebar to resize. Uses pointer events so it
  // works for mouse, pen, and touch on resizable screens.
  const startResize = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let lastW = startW;
    const onMove = (ev: PointerEvent) => {
      lastW = Math.max(SB_MIN, Math.min(SB_MAX, startW + (ev.clientX - startX)));
      setSidebarW(lastW);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem(SB_STORAGE, String(lastW));
      } catch {
        /* storage may be unavailable; the width is still in state */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [sidebarW]);

  const refresh = React.useCallback(async () => {
    try {
      setRooms(await api.rooms());
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tick every 15s so the sidebar's relative timestamps keep advancing
  // ("just now" → "1m" → "2m") without a network fetch — purely a re-render.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Keep the socket subscribed to every room we know about.
  React.useEffect(() => {
    if (!socket.ready) return;
    for (const r of rooms) socket.send({ type: "subscribe", room_id: r.room_id });
  }, [socket.ready, rooms, socket.send]);

  // On (re)connect, resync the sidebar — frames sent while the socket was down
  // (e.g. a backend restart or a backgrounded tab) are never replayed, so a
  // plain refetch catches anything we missed.
  const prevReadyRef = React.useRef(false);
  React.useEffect(() => {
    if (socket.ready && !prevReadyRef.current) void refresh();
    prevReadyRef.current = socket.ready;
  }, [socket.ready, refresh]);

  // Live sidebar streaming. On every event frame, patch the matching room's
  // last-message preview and unread count in place so a new message shows
  // instantly — even when that chat isn't open. Unknown rooms (and #2's
  // room.added) trigger a refetch so brand-new conversations surface too.
  React.useEffect(() => {
    const f = socket.lastFrame;
    if (!f) return;
    if (f.type === "event") {
      const ev = f.event;
      if (processedRef.current.has(ev.event_id)) return;
      processedRef.current.add(ev.event_id);
      const mine = !!ev.sender_handle && ev.sender_handle === myUsername;
      // Received-message sound — global (any room), once per event.
      if (!mine && isCountableEvent(ev)) playReceived();
      const rid = f.room_id;
      if (!roomsRef.current.some((r) => r.room_id === rid)) {
        void refresh();
        return;
      }
      const isOpen = selectedRef.current === rid;
      const preview = eventPreview(ev);
      setRooms((prev) =>
        prev.map((r) => {
          if (r.room_id !== rid) return r;
          // Counts toward unread only if it's a real message from someone
          // else and I'm not already looking at this room.
          const countable = isCountableEvent(ev) && !mine && !isOpen;
          return {
            ...r,
            last_event:
              preview !== null
                ? {
                    event_id: ev.event_id,
                    preview,
                    at: ev.created_at,
                    sender_handle: ev.sender_handle,
                    type: ev.type,
                    read: false,
                  }
                : r.last_event,
            unread: countable ? true : r.unread,
            unread_count: countable
              ? (r.unread_count ?? 0) + 1
              : r.unread_count,
          };
        }),
      );
    } else if (f.type === "read_receipt") {
      // Someone read up to f.event_id. If that reaches my own latest message,
      // flip its sidebar tick to "read". (My own auto-read only ever advances
      // to the last *received* message, never my own send — so a receipt at/
      // past my latest message must be from someone else.)
      setRooms((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (r.room_id !== f.room_id) return r;
          const le = r.last_event;
          if (!le || le.read || le.sender_handle !== myUsername || !le.event_id) {
            return r;
          }
          if (f.event_id >= le.event_id) {
            changed = true;
            return { ...r, last_event: { ...le, read: true } };
          }
          return r;
        });
        return changed ? next : prev;
      });
    } else if (f.type === "room.added") {
      if (!roomsRef.current.some((r) => r.room_id === f.room_id)) void refresh();
    }
  }, [socket.lastFrame, refresh, myUsername]);

  // Esc closes the open conversation (back to the list / welcome pane). We
  // bail when the event was already handled — an open dialog, popover, emoji
  // picker, or in-chat search dismisses itself first (those call
  // preventDefault / stopPropagation), so Esc only closes the chat as a
  // last resort.
  React.useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) router.push("/chat");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, router]);

  // Opening a room clears its unread badge locally — RoomView marks it read
  // server-side, but we zero the count immediately so the sidebar matches.
  React.useEffect(() => {
    if (!selected) return;
    setRooms((prev) => {
      // Bail out (return the same array) when there's nothing to clear so we
      // don't trigger a needless re-render on every room switch.
      const needsClear = prev.some(
        (r) => r.room_id === selected && (r.unread || (r.unread_count ?? 0) > 0),
      );
      if (!needsClear) return prev;
      return prev.map((r) =>
        r.room_id === selected ? { ...r, unread: false, unread_count: 0 } : r,
      );
    });
  }, [selected]);

  const filtered = React.useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    const list = rooms.filter((r) => {
      // #8 — Unread filter hides any room that has nothing new for me.
      if (filters.unread && !r.unread) return false;
      if (filters.teams.length && !(r.team_slug && filters.teams.includes(r.team_slug))) return false;
      if (filters.kinds.length && !filters.kinds.some((k) => r.peer_kinds.includes(k))) return false;
      if (q) {
        const hayName = (r.name || "").toLowerCase();
        const hayPeer = r.peers
          .map((p) => `${p.name} ${p.handle}`)
          .join(" ")
          .toLowerCase();
        const hayLast = (r.last_event?.preview ?? "").toLowerCase();
        if (
          !hayName.includes(q) &&
          !hayPeer.includes(q) &&
          !hayLast.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
    // Most-recent activity first, so a room that just received a message
    // bumps to the top of the list. ISO timestamps sort lexicographically.
    list.sort((a, b) => {
      const ta = a.last_event?.at ?? a.updated_at ?? "";
      const tb = b.last_event?.at ?? b.updated_at ?? "";
      return tb.localeCompare(ta);
    });
    return list;
  }, [rooms, filters, sidebarQuery]);

  const selectedRoom = rooms.find((r) => r.room_id === selected);

  return (
    <>
      {/* Left column — filter bar + conversation list. Hidden on mobile when a
          conversation is open (Telegram-style single-pane on small screens). */}
      <aside
        style={{ ["--sidebar-w" as string]: `${sidebarW}px` }}
        className={cn(
          // `min-h-0` so the room list scrolls *inside* the aside instead of
          // pushing the page taller than the viewport.
          "relative min-h-0 w-full shrink-0 flex-col border-r md:flex md:w-[var(--sidebar-w)]",
          selected ? "hidden" : "flex",
        )}
      >
        {/* Drag handle — right edge, desktop only. */}
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="resize sidebar"
          className="absolute right-0 top-0 z-10 hidden h-full w-1.5 cursor-col-resize transition-colors hover:bg-border md:block"
        />
        {/* Sidebar header — single border-b row. Search field fills the
            left flex-1 and reaches the row's full height; a 1px vertical
            divider separates it from the new-chat (+) button on the right,
            matching the composer's attach | input | send pattern. */}
        <div className="flex h-[52px] items-stretch border-b">
          <div className="flex flex-1 items-center gap-2 pl-6 pr-3 transition-colors focus-within:bg-accent/30">
            <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <input
              value={sidebarQuery}
              onChange={(e) => setSidebarQuery(e.target.value)}
              placeholder="search Carbons + Silicons"
              className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            aria-label="new chat"
            title="new chat"
            className="flex w-12 shrink-0 items-center justify-center border-l border-border text-foreground transition-colors hover:bg-accent"
          >
            <Plus />
          </button>
        </div>
        <TeamFilterBar
          teams={teams}
          filters={filters}
          onChange={setFilters}
          onOpenTeam={(slug) => setPanelSlug(slug)}
        />
        <RoomList
          rooms={filtered}
          myHandle={myUsername}
          selectedId={selected}
          onSelect={(id) => router.push(`/chat?room=${id}`)}
          onNew={() => setDialogOpen(true)}
          loading={loading}
          hoverRoomId={hoverRoomId}
          onRoomDragEnter={onRoomDragEnter}
          onRoomDragLeave={onRoomDragLeave}
        />
      </aside>

      {selectedRoom ? (
        <RoomView room={selectedRoom} allRooms={rooms} socket={socket} />
      ) : (
        <section className="hidden flex-1 items-center justify-center bg-muted/20 md:flex">
          <div className="max-w-md space-y-3 text-center">
            <h2 className="text-2xl font-bold tracking-tight">welcome</h2>
            <p className="text-sm text-muted-foreground">
              Pick a conversation, or click <strong>new</strong> to start a direct conversation
              with a Carbon or a Silicon.
            </p>
          </div>
        </section>
      )}

      <NewDirectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(room) => {
          setRooms((prev) => (prev.some((r) => r.room_id === room.room_id) ? prev : [...prev, room]));
          router.push(`/chat?room=${room.room_id}`);
        }}
      />
      <TeamPanel
        slug={panelSlug}
        open={panelSlug !== null}
        onOpenChange={(v) => !v && setPanelSlug(null)}
      />
    </>
  );
}
