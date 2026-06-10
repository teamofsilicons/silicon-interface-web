"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GearSix, MagnifyingGlass, Plus } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  addNotification,
  markRoomNotificationsRead,
  showBrowserNotification,
} from "@/lib/notifications";
import { roomDisplay } from "@/lib/peers";
import { playReceived, playReceivedSilicon } from "@/lib/sounds";
import type { Contact, Event, Room, WsFrame } from "@/lib/types";
import { useChatSocket } from "@/lib/ws";
import { useTeams } from "@/lib/use-teams";
import { contactKey, useContacts } from "@/lib/use-contacts";
import { loadCachedRooms, saveCachedRooms } from "@/lib/sidebar-cache";
import { cn } from "@/lib/utils";

// Message types that count toward the unread badge + drive the sidebar
// preview. Mirrors the backend projection (reactions / system / markers /
// progress never count).
const COUNTABLE_TYPES = new Set([
  "m.text",
  "m.image",
  "m.file",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);

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
    case "m.remote_browser":
      return "🌐 Remote Browser link";
    case "m.tts": {
      const t = String(c.text ?? "").trim();
      return t ? `🔊 ${t.slice(0, 80)}` : "🔊 audio";
    }
    default:
      return null;
  }
}

function notificationBody(ev: Event): string {
  const preview = eventPreview(ev) ?? "New message";
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

function notificationDisplay(room: Room, contacts: Map<string, Contact>) {
  const display = roomDisplay(room);
  const peer = display.peer;
  const saved = peer ? contacts.get(contactKey(peer.kind, peer.id)) : undefined;
  return {
    title: saved?.name?.trim() || display.name || "New message",
    avatarUrl: saved?.photo_url ?? display.photoUrl ?? null,
    avatarSeed: peer?.id ?? display.handle ?? room.room_id,
  };
}

import { RoomList } from "@/components/chat/room-list";
import { NewDirectDialog } from "@/components/chat/new-direct-dialog";
import { RoomView } from "@/components/chat/room-view";
import { CommandMenu } from "@/components/chat/command-menu";
import { KeymapCheatsheet } from "@/components/chat/keymap-cheatsheet";
import { TeamFilterBar, EMPTY_FILTERS, type ChatFilters } from "@/components/teams/team-filter-bar";
import { TeamPanel } from "@/components/teams/team-panel";
import { IdAvatar } from "@/components/profile/id-avatar";

// Resizable sidebar bounds + storage. Width persists across reloads.
const SB_DEFAULT = 320;
const SB_MIN = 240;
const SB_MAX = 560;
const SB_STORAGE = "silicon-interface:sidebar-width";
const OTHERS_TAB = "__others__";

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
  const teamViewSlug = search.get("team");
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [loading, setLoading] = React.useState(true);
  // §1d — roomId → expiry timestamp for rooms with a silicon mid-task. Drives a
  // faint sidebar "working…" shimmer even when the room isn't open.
  const [workingRooms, setWorkingRooms] = React.useState<Record<string, number>>({});
  const markRoomWorking = React.useCallback((roomId: string, working: boolean) => {
    setWorkingRooms((prev) => {
      if (working) return { ...prev, [roomId]: Date.now() + 45_000 };
      if (!(roomId in prev)) return prev;
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
  }, []);
  // Sweep expired entries so a silicon that died without a `done` stops shimmering.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      setWorkingRooms((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v > now) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => window.clearInterval(id);
  }, []);
  const workingRoomIds = React.useMemo(() => new Set(Object.keys(workingRooms)), [workingRooms]);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<ChatFilters>(EMPTY_FILTERS);
  const [activeTeamTab, setActiveTeamTab] = React.useState<string>("");
  const [sidebarW, setSidebarW] = React.useState<number>(loadSidebarWidth);
  // Sidebar search — filters the conversation list by display name, handle,
  // or last message body.
  const [sidebarQuery, setSidebarQuery] = React.useState("");
  // Hover-to-switch while dragging a file over a sidebar row.
  const [hoverRoomId, setHoverRoomId] = React.useState<string | null>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- WS frame fan-out (QA §2.1) ----
  // Every consumer — this page's sidebar / sound / notification logic AND the
  // open RoomView — must observe EVERY frame. The previous design had both read
  // a single `lastFrame` STATE value, so when two frames landed in one React
  // tick (a stream burst, a reconnect replay) only the last was seen and the
  // intermediate one (a delta, a read receipt, a take-back) was silently lost.
  // We now drive everything off the socket's `onFrame` callback and fan it out
  // to a set of listeners, so no frame is ever coalesced away.
  const frameListenersRef = React.useRef<Set<(f: WsFrame) => void>>(new Set());
  const subscribeFrames = React.useCallback((fn: (f: WsFrame) => void) => {
    frameListenersRef.current.add(fn);
    return () => {
      frameListenersRef.current.delete(fn);
    };
  }, []);
  // This page's own per-frame handler, reassigned every render (below) so it
  // always closes over the latest state without re-subscribing the socket.
  const pageFrameRef = React.useRef<(f: WsFrame) => void>(() => {});
  const dispatchFrame = React.useCallback((f: WsFrame) => {
    pageFrameRef.current(f);
    for (const fn of frameListenersRef.current) fn(f);
  }, []);
  const socket = useChatSocket({ onFrame: dispatchFrame });
  const { teams } = useTeams();
  const { carbon } = useAuth();
  const ownerId = carbon?.carbon_id ?? null;
  const contacts = useContacts(ownerId);
  const myUsername = carbon?.username ?? null;
  const selectedRoom = rooms.find((r) => r.room_id === selected);
  const hasOtherRooms = rooms.some((r) => !r.team_slug);
  const activeTeamSlug = teams.some((t) => t.slug === activeTeamTab)
    ? activeTeamTab
    : null;
  const showingOthers = activeTeamTab === OTHERS_TAB && hasOtherRooms;
  const activeTeam = activeTeamSlug ? teams.find((t) => t.slug === activeTeamSlug) : null;
  const viewedTeam = teamViewSlug ? teams.find((t) => t.slug === teamViewSlug) : null;

  React.useEffect(() => {
    if (teamViewSlug && teams.some((t) => t.slug === teamViewSlug)) {
      setActiveTeamTab(teamViewSlug);
    }
  }, [teamViewSlug, teams]);

  React.useEffect(() => {
    if (teamViewSlug && teams.some((t) => t.slug === teamViewSlug)) return;
    if (selectedRoom?.team_slug && teams.some((t) => t.slug === selectedRoom.team_slug)) {
      if (activeTeamTab !== selectedRoom.team_slug) setActiveTeamTab(selectedRoom.team_slug);
      return;
    }
    if (selectedRoom && !selectedRoom.team_slug && hasOtherRooms) {
      if (activeTeamTab !== OTHERS_TAB) setActiveTeamTab(OTHERS_TAB);
      return;
    }
    const activeValid =
      teams.some((t) => t.slug === activeTeamTab) ||
      (activeTeamTab === OTHERS_TAB && hasOtherRooms);
    if (!activeValid) {
      setActiveTeamTab(teams[0]?.slug ?? (hasOtherRooms ? OTHERS_TAB : ""));
    }
  }, [teamViewSlug, teams, selectedRoom, hasOtherRooms, activeTeamTab]);

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
  const roomsCacheOwnerRef = React.useRef<string | null>(null);

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

  // §9b — true while a background rooms refetch is in flight (the list is
  // served from cache instantly, then reconciled); drives a 1px top hairline.
  const [refreshing, setRefreshing] = React.useState(false);
  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.rooms();
      setRooms(next);
      if (ownerId) saveCachedRooms(ownerId, next);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      roomsCacheOwnerRef.current = ownerId;
      setLoading(false);
      setRefreshing(false);
    }
  }, [ownerId]);

  React.useEffect(() => {
    roomsCacheOwnerRef.current = null;
    const cached = ownerId ? loadCachedRooms(ownerId) : null;
    if (cached) {
      setRooms(cached);
      setLoading(false);
    } else {
      setRooms([]);
      setLoading(true);
    }
    queueMicrotask(() => {
      roomsCacheOwnerRef.current = ownerId;
    });
    void refresh();
  }, [ownerId, refresh]);

  React.useEffect(() => {
    if (!ownerId || roomsCacheOwnerRef.current !== ownerId) return;
    saveCachedRooms(ownerId, rooms);
  }, [ownerId, rooms]);

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
  // Kept current via a deps-less effect so it always sees the latest closures;
  // invoked by `dispatchFrame` for every WS frame (QA §2.1). Because `onFrame`
  // delivers each frame exactly once we no longer need the unbounded
  // `processedRef` dedup set the old `lastFrame` effect carried (QA §2.9).
  React.useEffect(() => {
    pageFrameRef.current = (f: WsFrame) => {
    if (f.type === "event") {
      const ev = f.event;
      const mine = !!ev.sender_handle && ev.sender_handle === myUsername;
      // Received-message sound — global (any room), once per event.
      // §3a — hear who's talking: silicons get a synthetic timbre, carbons a sine.
      if (!mine && isCountableEvent(ev)) {
        if (ev.sender_kind === "silicon") playReceivedSilicon();
        else playReceived();
      }
      const rid = f.room_id;
      const room = roomsRef.current.find((r) => r.room_id === rid);
      if (!room) {
        void refresh();
        return;
      }
      const isOpen = selectedRef.current === rid;
      const preview = eventPreview(ev);
      const countableIncoming = isCountableEvent(ev) && !mine && !isOpen;
      if (countableIncoming && ownerId) {
        const body = notificationBody(ev);
        const display = notificationDisplay(room, contacts.byPeer);
        addNotification(ownerId, {
          id: ev.event_id,
          roomId: rid,
          eventId: ev.event_id,
          title: display.title,
          body,
          at: ev.created_at,
          avatarUrl: display.avatarUrl,
          avatarSeed: display.avatarSeed,
        });
        showBrowserNotification(display.title, {
          body,
          tag: rid,
          roomId: rid,
        });
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          toast.message(display.title, {
            description: body,
            action: {
              label: "open",
              onClick: () => router.push(`/chat?room=${encodeURIComponent(rid)}`),
            },
          });
        }
      }
      setRooms((prev) =>
        prev.map((r) => {
          if (r.room_id !== rid) return r;
          // Counts toward unread only if it's a real message from someone
          // else and I'm not already looking at this room.
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
            unread: countableIncoming ? true : r.unread,
            unread_count: countableIncoming
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
    // §1d — track which rooms have a silicon mid-task so the sidebar can shimmer
    // them even when not open. Progress frames (and m.progress events) drive it.
    const progressRoom = "room_id" in f ? f.room_id : null;
    if (f.type === "progress" && progressRoom) {
      if (f.state === "done") markRoomWorking(progressRoom, false);
      else if (f.state) markRoomWorking(progressRoom, true);
    } else if (f.type === "event" && f.event.type === "m.progress" && progressRoom) {
      markRoomWorking(progressRoom, String(f.event.content.state) !== "done");
    } else if (f.type === "event" && progressRoom && f.event.sender_kind === "silicon") {
      // a real silicon message means it's done working in that room
      markRoomWorking(progressRoom, false);
    }
    };
  });

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
    if (ownerId) markRoomNotificationsRead(ownerId, selected);
    queueMicrotask(() => {
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
    });
  }, [selected, ownerId]);

  const filtered = React.useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    const list = rooms.filter((r) => {
      // #8 — Unread filter hides any room that has nothing new for me.
      if (activeTeamSlug && r.team_slug !== activeTeamSlug) return false;
      if (showingOthers && r.team_slug) return false;
      if (filters.unread && !r.unread) return false;
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
  }, [rooms, filters, sidebarQuery, activeTeamSlug, showingOthers]);

  // §7c — vim-style room navigation: j/k move through the visible list (and
  // open the room), when focus isn't in a text field. Enter is handled by the
  // list/composer; this is the quick keyboard sweep.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (!filtered.length) return;
      e.preventDefault();
      const idx = filtered.findIndex((r) => r.room_id === selected);
      const next =
        idx < 0
          ? 0
          : e.key === "j"
            ? Math.min(idx + 1, filtered.length - 1)
            : Math.max(idx - 1, 0);
      const target = filtered[next];
      if (target && target.room_id !== selected) {
        router.push(`/chat?room=${encodeURIComponent(target.room_id)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selected, router]);

  return (
    <>
      {/* §7b — Cmd+K jump menu (rooms / people / dev). */}
      <CommandMenu rooms={rooms} isStaff={carbon?.is_staff} />
      {/* §7d — Shift+? keyboard cheatsheet. */}
      <KeymapCheatsheet />
      {/* Left column — filter bar + conversation list. Hidden on mobile when a
          conversation is open (Telegram-style single-pane on small screens). */}
      <aside
        style={{ ["--sidebar-w" as string]: `${sidebarW}px` }}
        className={cn(
          // `min-h-0` so the room list scrolls *inside* the aside instead of
          // pushing the page taller than the viewport.
          "relative min-h-0 w-full shrink-0 flex-col border-r md:flex md:w-[var(--sidebar-w)]",
          selected || viewedTeam ? "hidden" : "flex",
        )}
      >
        {/* §9b — a 1px top hairline pulses while the cached list reconciles in
            the background, so power users know it's warming. */}
        {refreshing ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px animate-pulse bg-foreground/30 motion-reduce:animate-none" />
        ) : null}
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
        {(teams.length > 0 || hasOtherRooms) && (
          <div className="flex items-stretch border-b bg-background">
            <div className="flex min-h-0 min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden py-6 pl-6 pr-3">
              {teams.map((team) => (
                <button
                  key={team.slug}
                  type="button"
                  onClick={() => {
                    setActiveTeamTab(team.slug);
                    if (viewedTeam) router.push(`/chat?team=${encodeURIComponent(team.slug)}`);
                  }}
                  className={cn(
                    "inline-flex h-8 max-w-48 shrink-0 items-center gap-2 overflow-hidden truncate border p-0 pr-3 text-xs font-semibold leading-none transition-colors",
                    activeTeamSlug === team.slug
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  <IdAvatar
                    seed={`team:${team.slug}`}
                    src={team.logo_url}
                    size={28}
                    family="team"
                    className={cn(
                      "m-0.5 border-0",
                      activeTeamSlug === team.slug ? "bg-background" : "bg-muted",
                    )}
                  />
                  <span className="min-w-0 truncate">{team.name}</span>
                </button>
              ))}
              {hasOtherRooms && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTeamTab(OTHERS_TAB);
                    if (viewedTeam) router.push("/chat");
                  }}
                  className={cn(
                    "max-w-40 shrink-0 truncate border px-3 py-1.5 text-xs font-semibold transition-colors",
                    showingOthers
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  Others
                </button>
              )}
            </div>
            {activeTeam ? (
              <button
                type="button"
                aria-label={`${activeTeam.name} team workspace`}
                title={`${activeTeam.name} team workspace`}
                onClick={() => router.push(`/chat?team=${encodeURIComponent(activeTeam.slug)}`)}
                className={cn(
                  "grid w-12 shrink-0 place-items-center border-l text-foreground transition-colors hover:bg-accent",
                  viewedTeam?.slug === activeTeam.slug && "bg-secondary",
                )}
              >
                <GearSix className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        )}
        <TeamFilterBar
          filters={filters}
          onChange={setFilters}
        />
        <RoomList
          rooms={filtered}
          myHandle={myUsername}
          contacts={contacts.byPeer}
          selectedId={selected}
          onSelect={(id) => router.push(`/chat?room=${id}`)}
          onNew={() => setDialogOpen(true)}
          loading={loading}
          hoverRoomId={hoverRoomId}
          workingRoomIds={workingRoomIds}
          onRoomDragEnter={onRoomDragEnter}
          onRoomDragLeave={onRoomDragLeave}
        />
      </aside>

      {selectedRoom ? (
        <RoomView
          key={selectedRoom.room_id}
          room={selectedRoom}
          allRooms={rooms}
          socket={{ ready: socket.ready, send: socket.send, subscribe: subscribeFrames }}
          contacts={contacts.byPeer}
          onContactsChanged={contacts.refresh}
        />
      ) : viewedTeam ? (
        <TeamPanel slug={viewedTeam.slug} onClose={() => router.push("/chat")} />
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
    </>
  );
}
