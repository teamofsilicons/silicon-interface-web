"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Room } from "@/lib/types";
import { useChatSocket } from "@/lib/ws";
import { useTeams } from "@/lib/use-teams";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
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

  // Keep the socket subscribed to every room we know about.
  React.useEffect(() => {
    if (!socket.ready) return;
    for (const r of rooms) socket.send({ type: "subscribe", room_id: r.room_id });
  }, [socket.ready, rooms, socket.send]);

  // When an event arrives in a room we don't have locally yet — OR when
  // Glass tells us a fresh RoomMember was created for us (#2) — refresh the
  // sidebar so the new conversation surfaces without a page reload.
  React.useEffect(() => {
    if (!socket.lastFrame) return;
    const f = socket.lastFrame;
    if (f.type === "event") {
      const rid = f.room_id;
      if (!rooms.some((r) => r.room_id === rid)) void refresh();
    } else if (f.type === "room.added") {
      if (!rooms.some((r) => r.room_id === f.room_id)) void refresh();
    }
  }, [socket.lastFrame, rooms, refresh]);

  const filtered = React.useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    return rooms.filter((r) => {
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
        {/* Search input replaces the "Chats" header. Filters the room list
            by display name, handle, or last-message body. */}
        <div className="flex items-center gap-2 border-b py-1.5 pl-6 pr-2">
          <div className="flex h-9 flex-1 items-center gap-1.5 border border-input bg-transparent px-2 transition-colors focus-within:border-ring">
            <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <input
              value={sidebarQuery}
              onChange={(e) => setSidebarQuery(e.target.value)}
              placeholder="search Carbons + Silicons"
              className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setDialogOpen(true)}
            aria-label="new chat"
            title="new chat"
            className="h-7 w-7 shrink-0"
          >
            <Plus />
          </Button>
        </div>
        <TeamFilterBar
          teams={teams}
          filters={filters}
          onChange={setFilters}
          onOpenTeam={(slug) => setPanelSlug(slug)}
        />
        <RoomList
          rooms={filtered}
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
