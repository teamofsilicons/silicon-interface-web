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
import type { Contact, Event, ProgressState, Room, TeamMembership, WsFrame } from "@/lib/types";
import { clearRoomProgress, setRoomProgress } from "@/lib/progress-cache";
import { useChatSocket } from "@/lib/ws";
import { useTeams } from "@/lib/use-teams";
import { contactKey, useContacts } from "@/lib/use-contacts";
import {
  loadCachedRooms,
  saveCachedRooms,
  loadCachedMemberships,
  saveCachedMemberships,
} from "@/lib/sidebar-cache";
import {
  createPersonalFolder,
  deletePersonalFolder,
  loadGroupStore,
  renamePersonalFolder,
  saveGroupStore,
  setRoomFolder,
  type GroupStore,
} from "@/lib/chat-groups";
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
    // No emojis in previews — the sidebar renders a Phosphor icon per type
    // (see room-list). These strings are the icon-less labels.
    case "m.image": {
      const cap = String(c.caption ?? "").trim();
      return cap || "photo";
    }
    case "m.file": {
      const name = String(c.filename ?? "").trim();
      const cap = String(c.caption ?? "").trim();
      return name || cap || "attachment";
    }
    case "m.voice":
      return "voice note";
    case "m.remote_browser":
      return "Silicon Browser link";
    case "m.tts": {
      const t = String(c.text ?? "").trim();
      return t ? t.slice(0, 80) : "audio";
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

import { RoomList, type DisplayFolder, type GroupSection } from "@/components/chat/room-list";
import { GroupNameDialog } from "@/components/chat/group-name-dialog";
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
// Inter-silicon chats I only observe get their own tab, pulled out of the team
// tabs so the silicon-to-silicon traffic is easy to find and doesn't clutter my
// own conversations.
const OBSERVING_TAB = "__observing__";
// Shared empty set so rooms with no resolved team return a stable reference.
const EMPTY_SLUGS: ReadonlySet<string> = new Set<string>();

/** Small unread-count chip shown on a team / Others / Observing tab. Inverts
 *  its colors on the active tab (which has a dark/foreground background). */
function TabUnreadBadge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none",
        active ? "bg-background text-foreground" : "bg-primary text-primary-foreground",
      )}
      aria-label={`${count} unread message${count === 1 ? "" : "s"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

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
  // Personal folder state (user-created folders + per-room overrides), stored
  // locally per carbon_id. Coexists with the team-defined folders from Glass:
  // an override wins, else a silicon's team-folder assignment is the default.
  const [groupStore, setGroupStore] = React.useState<GroupStore>({ folders: [], overrides: {} });
  // Which group is drilled into (nested view of just its chats), or null.
  const [openGroupId, setOpenGroupId] = React.useState<string | null>(null);
  // Pending create/rename prompt: { mode, groupId?, seedRoomId? }.
  const [groupPrompt, setGroupPrompt] = React.useState<
    | { mode: "create"; seedRoomId?: string }
    | { mode: "rename"; groupId: string; current: string }
    | null
  >(null);

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
  const hasObservedRooms = rooms.some((r) => r.observed);

  // A direct chat started by id carries no team_slug from the backend, so it
  // would land in "Others" even when its peer is on one of my teams. Load each
  // of my teams' rosters and build `${kind}:${handle}` → set-of-team-slugs, so a
  // room can be placed under every team its peers belong to (a person can be on
  // several). `membershipsLoaded` lets the auto-tab effect wait for this rather
  // than stranding a fresh room in Others before the rosters arrive.
  // Hydrate the membership map from cache synchronously so a direct chat is
  // placed in the right team tab on first paint, rather than flashing in
  // "Others" until the rosters refetch.
  const [peerTeams, setPeerTeams] = React.useState<Map<string, Set<string>>>(
    () => loadCachedMemberships(ownerId) ?? new Map(),
  );
  const [membershipsLoaded, setMembershipsLoaded] = React.useState(
    () => loadCachedMemberships(ownerId) != null,
  );
  React.useEffect(() => {
    if (!teams.length) {
      setPeerTeams(new Map());
      setMembershipsLoaded(true);
      return;
    }
    // Re-seed from cache when the owner changes (e.g. account switch) before the
    // fresh fetch lands.
    const cached = loadCachedMemberships(ownerId);
    if (cached) {
      setPeerTeams(cached);
      setMembershipsLoaded(true);
    }
    let alive = true;
    Promise.all(
      teams.map((t) =>
        api
          .teamMembers(t.slug)
          .then((rows) => ({ slug: t.slug, rows }))
          .catch(() => ({ slug: t.slug, rows: [] as TeamMembership[] })),
      ),
    ).then((results) => {
      if (!alive) return;
      const map = new Map<string, Set<string>>();
      for (const { slug, rows } of results) {
        for (const m of rows) {
          if (!m.member_handle) continue;
          const key = `${m.member_kind}:${m.member_handle}`;
          let set = map.get(key);
          if (!set) {
            set = new Set();
            map.set(key, set);
          }
          set.add(slug);
        }
      }
      setPeerTeams(map);
      setMembershipsLoaded(true);
      if (ownerId) saveCachedMemberships(ownerId, map);
    });
    return () => {
      alive = false;
    };
  }, [teams, ownerId]);

  // The set of team slugs each room belongs to: its own team_slug (if any) plus
  // every team its peers are members of. Empty set ⇒ the room lives in "Others".
  const roomTeamsMap = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of rooms) {
      const slugs = new Set<string>();
      if (r.team_slug) slugs.add(r.team_slug);
      for (const p of r.peers) {
        const s = peerTeams.get(`${p.kind}:${p.handle}`);
        if (s) for (const slug of s) slugs.add(slug);
      }
      m.set(r.room_id, slugs);
    }
    return m;
  }, [rooms, peerTeams]);
  const roomTeams = React.useCallback(
    (roomId: string): ReadonlySet<string> => roomTeamsMap.get(roomId) ?? EMPTY_SLUGS,
    [roomTeamsMap],
  );

  // A non-observed room that belongs to no team is an "Other"; observed rooms
  // are routed to their own tab regardless of team.
  const hasOtherRooms = rooms.some((r) => !r.observed && roomTeams(r.room_id).size === 0);
  const activeTeamSlug = teams.some((t) => t.slug === activeTeamTab)
    ? activeTeamTab
    : null;
  const showingOthers = activeTeamTab === OTHERS_TAB && hasOtherRooms;
  const showingObserving = activeTeamTab === OBSERVING_TAB && hasObservedRooms;
  const activeTeam = activeTeamSlug ? teams.find((t) => t.slug === activeTeamSlug) : null;
  const viewedTeam = teamViewSlug ? teams.find((t) => t.slug === teamViewSlug) : null;

  // Unread totals per tab, so the team / Others / Observing tabs show a badge
  // when there's something new in a tab you're not currently looking at. Same
  // count source as the per-room badges in the room list.
  const unreadByTab = React.useMemo(() => {
    const teamsMap: Record<string, number> = {};
    let others = 0;
    let observing = 0;
    for (const r of rooms) {
      const n = r.unread_count ?? (r.unread ? 1 : 0);
      if (n <= 0) continue;
      if (r.observed) {
        observing += n;
        continue;
      }
      const slugs = roomTeams(r.room_id);
      if (slugs.size) {
        for (const slug of slugs) teamsMap[slug] = (teamsMap[slug] ?? 0) + n;
      } else {
        others += n;
      }
    }
    return { teams: teamsMap, others, observing };
  }, [rooms, roomTeams]);

  React.useEffect(() => {
    if (teamViewSlug && teams.some((t) => t.slug === teamViewSlug)) {
      setActiveTeamTab(teamViewSlug);
    }
  }, [teamViewSlug, teams]);

  // When a room is *first* opened, jump the tab to its team so the list shows
  // the room in context. We only do this once per opened room (tracked by id)
  // — after that the user is free to click into other team tabs / Others while
  // the chat stays open, instead of the tab snapping back every render.
  const autoTabbedRoomRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (teamViewSlug && teams.some((t) => t.slug === teamViewSlug)) {
      autoTabbedRoomRef.current = selectedRoom?.room_id ?? null;
      return;
    }
    const roomId = selectedRoom?.room_id ?? null;
    if (roomId && roomId !== autoTabbedRoomRef.current) {
      if (selectedRoom?.observed) {
        autoTabbedRoomRef.current = roomId;
        if (activeTeamTab !== OBSERVING_TAB) setActiveTeamTab(OBSERVING_TAB);
        return;
      }
      const slugs = roomTeams(roomId);
      // If the room resolves to no team but rosters are still loading, wait —
      // jumping to Others now would strand a team chat there until the user
      // re-opens it. Once loaded (or if it already has a team), commit the jump.
      if (slugs.size === 0 && !membershipsLoaded) {
        // leave autoTabbedRoomRef unset so we retry when memberships arrive
      } else {
        autoTabbedRoomRef.current = roomId;
        if (slugs.size > 0) {
          // Keep the current tab if it already shows this room; else jump to one
          // of its teams.
          if (!(activeTeamSlug && slugs.has(activeTeamSlug))) {
            setActiveTeamTab([...slugs][0]);
          }
          return;
        }
        if (hasOtherRooms) {
          if (activeTeamTab !== OTHERS_TAB) setActiveTeamTab(OTHERS_TAB);
          return;
        }
      }
    }
    if (!roomId) autoTabbedRoomRef.current = null;
    // Always keep the active tab pointing at something that exists.
    const activeValid =
      teams.some((t) => t.slug === activeTeamTab) ||
      (activeTeamTab === OTHERS_TAB && hasOtherRooms) ||
      (activeTeamTab === OBSERVING_TAB && hasObservedRooms);
    if (!activeValid) {
      setActiveTeamTab(
        teams[0]?.slug ?? (hasOtherRooms ? OTHERS_TAB : hasObservedRooms ? OBSERVING_TAB : ""),
      );
    }
  }, [
    teamViewSlug,
    teams,
    selectedRoom,
    hasOtherRooms,
    hasObservedRooms,
    activeTeamTab,
    activeTeamSlug,
    roomTeams,
    membershipsLoaded,
  ]);

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
  // Guards group persistence so the initial load for a new owner doesn't echo
  // back an empty array before the stored groups are read in.
  const groupsOwnerRef = React.useRef<string | null>(null);

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

  // Load this user's personal folder store; persist on every change (but only
  // once the current owner's store has been read, mirroring the rooms cache).
  React.useEffect(() => {
    groupsOwnerRef.current = null;
    setGroupStore(ownerId ? loadGroupStore(ownerId) : { folders: [], overrides: {} });
    queueMicrotask(() => {
      groupsOwnerRef.current = ownerId;
    });
  }, [ownerId]);

  React.useEffect(() => {
    if (!ownerId || groupsOwnerRef.current !== ownerId) return;
    saveGroupStore(ownerId, groupStore);
  }, [ownerId, groupStore]);

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
      // Observer rooms (inter-silicon chats I only watch) never raise a
      // notification, browser alert, or toast — read-only visibility shouldn't
      // ping me. The unread indicator below still updates so the Observing tab
      // can show there's new activity.
      if (countableIncoming && ownerId && !room.observed) {
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
    } else if (f.type === "announcement") {
      // a team announcement — desktop push + live bell refresh
      showBrowserNotification(f.announcement.title, {
        body: f.announcement.body,
        tag: `announcement-${f.announcement.id}`,
      });
      window.dispatchEvent(
        new CustomEvent("silicon-interface:announcement", { detail: f.announcement }),
      );
    }
    // §1d — track which rooms have a silicon mid-task so the sidebar can shimmer
    // them even when not open. Progress frames (and m.progress events) drive it.
    // We also stash the full progress entry per room (progress-cache) so a chat
    // reopened or refreshed mid-task can restore its progress line — the room
    // view is unmounted while closed and never sees these frames.
    const progressRoom = "room_id" in f ? f.room_id : null;
    if (f.type === "progress" && progressRoom) {
      if (f.state === "done") {
        markRoomWorking(progressRoom, false);
        clearRoomProgress(progressRoom);
      } else if (f.state && f.progress_group_id) {
        markRoomWorking(progressRoom, true);
        setRoomProgress(progressRoom, {
          roomId: progressRoom,
          groupId: f.progress_group_id,
          state: f.state as ProgressState,
          note: f.note || "",
          updatedAt: Date.now(),
          source: "server",
          pct: typeof f.progress_pct === "number" ? f.progress_pct : null,
          handle: f.member_handle ?? null,
        });
      }
    } else if (f.type === "event" && f.event.type === "m.progress" && progressRoom) {
      const state = String(f.event.content.state || "thinking");
      if (state === "done") {
        markRoomWorking(progressRoom, false);
        clearRoomProgress(progressRoom);
      } else {
        markRoomWorking(progressRoom, true);
        setRoomProgress(progressRoom, {
          roomId: progressRoom,
          groupId: String(f.event.content.progress_group_id || f.event.event_id),
          state: state as ProgressState,
          note: String(f.event.content.note || ""),
          updatedAt: Date.now(),
          source: "server",
          pct:
            typeof f.event.content.progress_pct === "number"
              ? f.event.content.progress_pct
              : null,
          handle: f.event.sender_handle,
        });
      }
    } else if (f.type === "event" && progressRoom && f.event.sender_kind === "silicon") {
      // a real silicon message means it's done working in that room
      markRoomWorking(progressRoom, false);
      clearRoomProgress(progressRoom);
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
      // Observed (inter-silicon) rooms live only in the Observing tab; every
      // other tab excludes them, and the Observing tab excludes everything else.
      if (showingObserving) {
        if (!r.observed) return false;
      } else {
        if (r.observed) return false;
        const slugs = roomTeams(r.room_id);
        // A team tab shows every room that belongs to that team (via its own
        // team or any peer's membership); "Others" shows rooms in no team.
        if (activeTeamSlug && !slugs.has(activeTeamSlug)) return false;
        if (showingOthers && slugs.size > 0) return false;
      }
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
  }, [rooms, filters, sidebarQuery, activeTeamSlug, showingOthers, showingObserving, roomTeams]);

  // Personal grouping applies only inside a real team tab and only when not
  // searching — the Others tab and any search fall back to the flat list.
  const groupingActive = !!activeTeamSlug && sidebarQuery.trim() === "";

  const { groupSections, ungroupedRooms, displayFolders, assignmentByRoom } = React.useMemo(() => {
    if (!groupingActive || !activeTeamSlug) {
      return {
        groupSections: undefined as GroupSection[] | undefined,
        ungroupedRooms: undefined as Room[] | undefined,
        displayFolders: [] as DisplayFolder[],
        assignmentByRoom: {} as Record<string, string>,
      };
    }
    // Team folders + assignments authored in Glass (silicon_id → folderId).
    const teamCfg = activeTeam?.silicon_folders;
    const teamFolders: DisplayFolder[] = (teamCfg?.folders ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      source: "team" as const,
    }));
    const teamAssign = teamCfg?.assignments ?? {};
    const personalFolders: DisplayFolder[] = groupStore.folders
      .filter((f) => f.teamSlug === activeTeamSlug)
      .sort((a, b) => a.order - b.order)
      .map((f) => ({ id: f.id, name: f.name, source: "personal" as const }));
    const folders = [...teamFolders, ...personalFolders]; // team first, then personal
    const folderIds = new Set(folders.map((f) => f.id));

    // Override wins; else a silicon peer's team-folder default; else ungrouped.
    const resolve = (room: Room): string | null => {
      const o = groupStore.overrides[room.room_id];
      if (o !== undefined) return o === "" || !folderIds.has(o) ? null : o;
      const peer = room.kind === "direct" && room.peers.length === 1 ? room.peers[0] : null;
      if (peer && peer.kind === "silicon") {
        const fid = teamAssign[peer.id];
        if (fid && folderIds.has(fid)) return fid;
      }
      return null;
    };

    const byRoom: Record<string, string> = {};
    const byFolder = new Map<string, Room[]>();
    folders.forEach((f) => byFolder.set(f.id, []));
    const ungrouped: Room[] = [];
    for (const r of filtered) {
      const fid = resolve(r);
      if (fid) {
        byFolder.get(fid)!.push(r);
        byRoom[r.room_id] = fid;
      } else {
        ungrouped.push(r);
      }
    }
    const sections: GroupSection[] = folders.map((group) => ({
      group,
      rooms: byFolder.get(group.id) ?? [],
    }));
    return { groupSections: sections, ungroupedRooms: ungrouped, displayFolders: folders, assignmentByRoom: byRoom };
  }, [groupingActive, activeTeamSlug, activeTeam, groupStore, filtered]);

  const groupControls = React.useMemo(() => {
    if (!groupingActive || !activeTeamSlug) return undefined;
    return {
      groups: displayFolders,
      assignmentByRoom,
      openGroupId,
      onOpenGroup: (groupId: string) => setOpenGroupId(groupId),
      onCloseGroup: () => setOpenGroupId(null),
      onRename: (groupId: string) => {
        const f = groupStore.folders.find((x) => x.id === groupId);
        if (f) setGroupPrompt({ mode: "rename", groupId, current: f.name });
      },
      onDelete: (groupId: string) => {
        setGroupStore((prev) => deletePersonalFolder(prev, groupId));
        setOpenGroupId((cur) => (cur === groupId ? null : cur));
      },
      onMoveRoom: (roomId: string, groupId: string | null) =>
        setGroupStore((prev) => setRoomFolder(prev, roomId, groupId)),
      onCreateGroupWithRoom: (roomId: string) =>
        setGroupPrompt({ mode: "create", seedRoomId: roomId }),
    };
  }, [groupingActive, activeTeamSlug, displayFolders, assignmentByRoom, groupStore, openGroupId]);

  // Leaving a team (or its grouping context) closes any drilled-in folder.
  React.useEffect(() => {
    setOpenGroupId(null);
  }, [activeTeamSlug]);

  const confirmGroupPrompt = React.useCallback(
    (name: string) => {
      if (!groupPrompt) return;
      if (groupPrompt.mode === "rename") {
        setGroupStore((prev) => renamePersonalFolder(prev, groupPrompt.groupId, name));
        return;
      }
      // create a personal folder; seed it with the room when opened from a
      // chat's "New group…".
      if (!activeTeamSlug) return;
      const seedRoomId = groupPrompt.seedRoomId;
      setGroupStore((prev) => {
        const { store, id } = createPersonalFolder(prev, activeTeamSlug, name);
        return seedRoomId ? setRoomFolder(store, seedRoomId, id) : store;
      });
    },
    [groupPrompt, activeTeamSlug],
  );

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
          "relative z-10 min-h-0 w-full shrink-0 flex-col border-r bg-sidebar shadow-[1px_0_14px_-3px_rgba(60,50,36,0.12)] md:flex md:w-[var(--sidebar-w)]",
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
        {(teams.length > 0 || hasOtherRooms || hasObservedRooms) && (
          <div className="flex items-stretch border-b bg-background">
            <div className="flex min-h-0 min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden py-2 pl-6 pr-3">
              {teams.map((team) => (
                <button
                  key={team.slug}
                  type="button"
                  onClick={() => {
                    setActiveTeamTab(team.slug);
                    if (viewedTeam) router.push(`/chat?team=${encodeURIComponent(team.slug)}`);
                  }}
                  className={cn(
                    "inline-flex max-w-48 shrink-0 items-center gap-2 overflow-hidden truncate border p-0 pr-3 text-xs font-semibold leading-none transition-colors",
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
                  <TabUnreadBadge
                    count={unreadByTab.teams[team.slug] ?? 0}
                    active={activeTeamSlug === team.slug}
                  />
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
                    "inline-flex max-w-40 shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors",
                    showingOthers
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 truncate">Others</span>
                  <TabUnreadBadge count={unreadByTab.others} active={showingOthers} />
                </button>
              )}
              {hasObservedRooms && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveTeamTab(OBSERVING_TAB);
                    if (viewedTeam) router.push("/chat");
                  }}
                  className={cn(
                    "inline-flex max-w-40 shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors",
                    showingObserving
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 truncate">Observing</span>
                  <TabUnreadBadge count={unreadByTab.observing} active={showingObserving} />
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
          groupSections={groupSections}
          ungroupedRooms={ungroupedRooms}
          groupControls={groupControls}
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

      <GroupNameDialog
        open={!!groupPrompt}
        title={groupPrompt?.mode === "rename" ? "Rename group" : "New group"}
        initialValue={groupPrompt?.mode === "rename" ? groupPrompt.current : ""}
        confirmLabel={groupPrompt?.mode === "rename" ? "Rename" : "Create"}
        onOpenChange={(open) => {
          if (!open) setGroupPrompt(null);
        }}
        onConfirm={confirmGroupPrompt}
      />
    </>
  );
}
