"use client";

import * as React from "react";
import {
  CaretDown,
  CaretLeft,
  CircleNotch,
  Crown,
  Eye,
  MagnifyingGlass,
} from "@phosphor-icons/react/dist/ssr";

import ChatPage from "@/app/chat/page";
import { ObservedChatTimeline } from "@/components/chat/observed-chat-timeline";
import { LordsSidebarAddonProvider } from "@/components/chat/lords-sidebar-addon";
import { RoomList } from "@/components/chat/room-list";
import { IdAvatar } from "@/components/profile/id-avatar";
import {
  OTHERS_TAB,
  TeamFilterBar,
  TeamSlider,
  type ChatFilters,
} from "@/components/teams/team-filter-bar";
import { TeamPanel } from "@/components/teams/team-panel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLordSocket } from "@/lib/lords-ws";
import { roomDisplay } from "@/lib/peers";
import { normalizeRooms } from "@/lib/room-shape";
import {
  loadCachedMemberships,
  saveCachedMemberships,
} from "@/lib/sidebar-cache";
import type {
  Carbon,
  Event,
  LordIdentity,
  LordTeam,
  Room,
  RoomPeer,
  TeamMembership,
} from "@/lib/types";
import { useContacts } from "@/lib/use-contacts";
import { cn } from "@/lib/utils";

const NORMAL_INTERFACE = "https://interface.teamofsilicons.com";
const INITIAL_FILTERS: ChatFilters = { unread: false, kinds: [], teams: [] };
const LORD_EVENT_BATCH = 200;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 560;
const SIDEBAR_STORAGE = "silicon-interface:sidebar-width";

function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT;
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_STORAGE));
    return Number.isFinite(value) && value >= SIDEBAR_MIN && value <= SIDEBAR_MAX
      ? value
      : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function isLoggedInIdentity(
  identity: LordIdentity | null | undefined,
  carbon: Carbon | null | undefined,
): boolean {
  return Boolean(
    identity &&
    carbon &&
    identity.kind === "carbon" &&
    identity.id === carbon.carbon_id,
  );
}

function selfIdentity(carbon: Carbon): LordIdentity {
  return {
    kind: "carbon",
    id: carbon.carbon_id,
    handle: carbon.username,
    name: carbon.name || carbon.username,
    profile_photo_url: carbon.profile_photo_url,
    profile_ascii_url: carbon.profile_ascii_url ?? null,
    is_lord: carbon.is_lord,
    team_slugs: [],
  };
}

function mergeObservedEvents(current: readonly Event[], incoming: readonly Event[]): Event[] {
  const byId = new Map(current.map((event) => [event.event_id, event]));
  for (const event of incoming) byId.set(event.event_id, event);
  return [...byId.values()].sort((left, right) =>
    left.event_id.localeCompare(right.event_id),
  );
}

function IdentityAvatar({ identity, size = 34 }: { identity: LordIdentity; size?: number }) {
  return (
    <IdAvatar
      seed={identity.id}
      src={identity.profile_photo_url}
      asciiSrc={identity.profile_ascii_url ?? null}
      family={identity.kind}
      size={size}
    />
  );
}

function isIdentityPeer(peer: RoomPeer, identity: LordIdentity): boolean {
  return peer.kind === identity.kind && (
    peer.id === identity.id || peer.handle === identity.handle
  );
}

/** The Lords API is requested by the supervising Carbon, so its raw peer list
 * can contain every member. Remove the selected identity from that projection
 * to make the room read exactly as it does in that identity's normal sidebar. */
function projectRoomForIdentity(room: Room, identity: LordIdentity): Room {
  const peers = (room.peers ?? []).filter((peer) => !isIdentityPeer(peer, identity));
  return {
    ...room,
    peers,
    peer_kinds: peers.map((peer) => peer.kind),
    observed: true,
    unread: false,
    unread_count: 0,
    list_preferences: null,
  };
}

function IdentityPicker({
  identities,
  identity,
  loading,
  teamName,
  connected,
  selfId,
  onSelect,
}: {
  identities: LordIdentity[];
  identity: LordIdentity | null;
  loading: boolean;
  teamName: string;
  connected: boolean;
  selfId: string | null;
  onSelect: (identity: LordIdentity) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const normalized = query.trim().toLowerCase();
  const filtered = identities.filter((candidate) =>
    !normalized || [candidate.name, candidate.handle, candidate.id, candidate.kind]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
  const viewingSelf = identity?.kind === "carbon" && identity.id === selfId;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        type="button"
        className="flex h-[60px] w-full items-center gap-3 border-b pl-6 pr-4 text-left transition-colors hover:bg-accent/50"
        aria-label="choose identity to observe"
      >
        {identity ? (
          <IdentityAvatar identity={identity} size={36} />
        ) : loading ? (
          <span className="grid h-9 w-9 place-items-center border bg-muted">
            <CircleNotch className="h-4 w-4 animate-spin" />
          </span>
        ) : (
          <span className="grid h-9 w-9 place-items-center border bg-muted">
            <Crown className="h-4 w-4" weight="fill" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {identity?.name ?? "No identities"}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
            {viewingSelf ? null : <Eye className="h-3 w-3 shrink-0" />}
            <span className="truncate">
              {identity
                ? viewingSelf
                  ? `you · ${teamName}`
                  : `${identity.kind} · ${teamName} · read-only`
                : teamName}
            </span>
          </span>
        </span>
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            connected ? "bg-success" : "bg-muted-foreground",
          )}
          title={connected ? "live" : "reconnecting"}
        />
        <CaretDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-72">
        <div className="flex h-10 items-center gap-2 border-b px-3">
          <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="search identities"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.map((candidate) => {
            const active = identity?.kind === candidate.kind && identity.id === candidate.id;
            const candidateIsSelf = candidate.kind === "carbon" && candidate.id === selfId;
            return (
              <button
                key={`${candidate.kind}:${candidate.id}`}
                type="button"
                onClick={() => {
                  onSelect(candidate);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent",
                  active && "bg-secondary",
                )}
              >
                <IdentityAvatar identity={candidate} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{candidate.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {candidateIsSelf ? "you · " : `${candidate.kind} · `}@{candidate.handle}
                  </span>
                </span>
                {candidateIsSelf ? (
                  <span className="label-mono border px-1.5 py-0.5 text-[9px]">you</span>
                ) : null}
                {candidate.kind === "silicon" ? (
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      candidate.connection_state === "online" ? "bg-success" : "bg-muted-foreground",
                    )}
                  />
                ) : null}
              </button>
            );
          })}
          {!loading && filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matching identities.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function LordsPage() {
  const { carbon } = useAuth();
  const [teams, setTeams] = React.useState<LordTeam[]>([]);
  const [filters, setFilters] = React.useState<ChatFilters>(INITIAL_FILTERS);
  const [identities, setIdentities] = React.useState<LordIdentity[]>([]);
  const [identity, setIdentity] = React.useState<LordIdentity | null>(
    () => carbon ? selfIdentity(carbon) : null,
  );
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [room, setRoom] = React.useState<Room | null>(null);
  const [viewedTeamSlug, setViewedTeamSlug] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<Event[]>([]);
  const [sidebarQuery, setSidebarQuery] = React.useState("");
  const [loadingIdentities, setLoadingIdentities] = React.useState(true);
  const [loadingRooms, setLoadingRooms] = React.useState(false);
  const [loadingEvents, setLoadingEvents] = React.useState(false);
  const [hasOlderEvents, setHasOlderEvents] = React.useState(false);
  const [loadingOlderEvents, setLoadingOlderEvents] = React.useState(false);
  const [sidebarW, setSidebarW] = React.useState(loadSidebarWidth);
  const [error, setError] = React.useState("");

  const viewingSelf = isLoggedInIdentity(identity, carbon);
  const ownerId = carbon?.carbon_id ?? null;
  const contacts = useContacts(ownerId);
  const [peerTeams, setPeerTeams] = React.useState<Map<string, Set<string>>>(
    () => loadCachedMemberships(ownerId) ?? new Map(),
  );
  const activeRoomIdRef = React.useRef<string | null>(room?.room_id ?? null);
  const loadingOlderEventsRef = React.useRef(false);
  const filtersRef = React.useRef(filters);
  React.useLayoutEffect(() => {
    activeRoomIdRef.current = room?.room_id ?? null;
  }, [room?.room_id]);
  React.useLayoutEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  React.useEffect(() => {
    if (!carbon?.is_lord) return;
    let alive = true;
    api.lordTeams()
      .then((value) => {
        if (alive) setTeams(value.teams);
      })
      .catch((reason: Error) => alive && setError(reason.message));
    return () => { alive = false; };
  }, [carbon?.is_lord]);

  // Match normal Interface team filtering: direct rooms often have no
  // `team_slug`, so infer every room's teams from the public ids of its peers.
  // Seed from the shared sidebar cache to avoid flashing unrelated rooms while
  // fresh rosters load.
  React.useEffect(() => {
    let alive = true;
    const cached = loadCachedMemberships(ownerId);
    if (cached) {
      queueMicrotask(() => {
        if (alive) setPeerTeams(cached);
      });
    }
    if (teams.length === 0) {
      if (!cached) {
        queueMicrotask(() => {
          if (alive) setPeerTeams(new Map());
        });
      }
      return () => {
        alive = false;
      };
    }
    Promise.all(
      teams.map((candidate) =>
        api.teamMembers(candidate.slug)
          .then((rows) => ({ slug: candidate.slug, rows }))
          .catch(() => ({ slug: candidate.slug, rows: [] as TeamMembership[] })),
      ),
    ).then((results) => {
      if (!alive) return;
      const next = new Map<string, Set<string>>();
      for (const { slug, rows } of results) {
        for (const membership of rows) {
          if (!membership.member_public_id) continue;
          const key = `${membership.member_kind}:${membership.member_public_id}`;
          const slugs = next.get(key) ?? new Set<string>();
          slugs.add(slug);
          next.set(key, slugs);
        }
      }
      setPeerTeams(next);
      saveCachedMemberships(ownerId, next);
    });
    return () => {
      alive = false;
    };
  }, [ownerId, teams]);

  // Lords identities carry the owning-team projection directly. Keep it as a
  // fallback for Silicons whose public membership row is absent or stale, and
  // for observed rooms where the selected Silicon is intentionally removed
  // from `peers` to render the chat from that Silicon's perspective.
  const identityTeams = React.useMemo(() => {
    const next = new Map<string, Set<string>>();
    for (const candidate of identities) {
      next.set(`${candidate.kind}:${candidate.id}`, new Set(candidate.team_slugs));
    }
    return next;
  }, [identities]);

  const roomTeamSlugs = React.useCallback((candidate: Room): Set<string> => {
    const slugs = new Set<string>();
    if (candidate.team_slug) slugs.add(candidate.team_slug);
    for (const peer of candidate.peers ?? []) {
      for (const slug of peerTeams.get(`${peer.kind}:${peer.id}`) ?? []) slugs.add(slug);
      for (const slug of identityTeams.get(`${peer.kind}:${peer.id}`) ?? []) slugs.add(slug);
    }
    // The selected Silicon is removed from observed room peers. Its owner-team
    // projection is therefore the only authoritative team for some direct
    // rooms; Carbon identities continue to match Interface by the other peer.
    if (identity?.kind === "silicon") {
      for (const slug of identity.team_slugs) slugs.add(slug);
    }
    return slugs;
  }, [identity, identityTeams, peerTeams]);

  const roomMatchesFilters = React.useCallback((
    candidate: Room,
    selectedFilters: ChatFilters,
  ): boolean => {
    const selectedTeams = selectedFilters.teams.filter((slug) =>
      teams.some((candidateTeam) => candidateTeam.slug === slug),
    );
    const wantOthers = selectedFilters.teams.includes(OTHERS_TAB);
    if (selectedTeams.length === 0 && !wantOthers) return true;
    const slugs = roomTeamSlugs(candidate);
    return selectedTeams.some((slug) => slugs.has(slug)) || (wantOthers && slugs.size === 0);
  }, [roomTeamSlugs, teams]);

  const roomMatchesSelectedTeam = React.useCallback(
    (candidate: Room): boolean => roomMatchesFilters(candidate, filters),
    [filters, roomMatchesFilters],
  );

  React.useEffect(() => {
    if (!carbon?.is_lord) return;
    let alive = true;
    api.lordIdentities("all")
      .then((value) => {
        if (!alive) return;
        const projectedSelf =
          value.identities.find((candidate) => isLoggedInIdentity(candidate, carbon)) ??
          selfIdentity(carbon);
        const ordered = [
          projectedSelf,
          ...value.identities.filter((candidate) => !isLoggedInIdentity(candidate, carbon)),
        ];
        setIdentities(ordered);
        setLoadingRooms(ordered.length > 0);
        setIdentity((current) =>
          current && ordered.some(
            (candidate) => candidate.kind === current.kind && candidate.id === current.id,
          )
            ? current
            : projectedSelf,
        );
        setError("");
      })
      .catch((reason: Error) => alive && setError(reason.message))
      .finally(() => alive && setLoadingIdentities(false));
    return () => { alive = false; };
  }, [carbon]);

  const loadRoomsForIdentity = React.useCallback(async (target: LordIdentity) => {
    const value = await api.lordIdentityRooms(target.kind, target.id);
    return normalizeRooms(value.rooms)
      .map((candidate) => projectRoomForIdentity(candidate, target));
  }, []);

  const refreshRooms = React.useCallback(async (target = identity) => {
    if (!target || isLoggedInIdentity(target, carbon)) return;
    const nextRooms = await loadRoomsForIdentity(target);
    const visibleRooms = nextRooms.filter(roomMatchesSelectedTeam);
    setRooms(nextRooms);
    setRoom((current) => {
      const retained = current
        ? nextRooms.find((candidate) => candidate.room_id === current.room_id)
        : null;
      const activeRooms = visibleRooms.filter(
        (candidate) => candidate.lord_access_state !== "revoked",
      );
      return retained
        ?? activeRooms.find((candidate) => candidate.last_event !== null)
        ?? activeRooms[0]
        ?? visibleRooms.find((candidate) => candidate.last_event !== null)
        ?? visibleRooms[0]
        ?? null;
    });
  }, [carbon, identity, loadRoomsForIdentity, roomMatchesSelectedTeam]);

  React.useEffect(() => {
    if (!identity || isLoggedInIdentity(identity, carbon)) return;
    let alive = true;
    loadRoomsForIdentity(identity)
      .then((nextRooms) => {
        if (!alive) return;
        const visibleRooms = nextRooms.filter((candidate) =>
          roomMatchesFilters(candidate, filtersRef.current),
        );
        const activeRooms = visibleRooms.filter(
          (candidate) => candidate.lord_access_state !== "revoked",
        );
        const initialRoom =
          activeRooms.find((candidate) => candidate.last_event !== null)
          ?? activeRooms[0]
          ?? visibleRooms.find((candidate) => candidate.last_event !== null)
          ?? visibleRooms[0]
          ?? null;
        setRooms(nextRooms);
        setRoom(initialRoom);
        setEvents([]);
        setHasOlderEvents(false);
        setLoadingOlderEvents(false);
        setLoadingEvents(initialRoom !== null);
        setError("");
      })
      .catch((reason: Error) => alive && setError(reason.message))
      .finally(() => alive && setLoadingRooms(false));
    return () => { alive = false; };
  }, [carbon, identity, loadRoomsForIdentity, roomMatchesFilters]);

  const refreshEvents = React.useCallback(async (target = room) => {
    if (!target || viewingSelf) return;
    const value = await api.lordRoomEvents(target.room_id, { limit: LORD_EVENT_BATCH });
    if (activeRoomIdRef.current !== target.room_id) return;
    setEvents((current) => mergeObservedEvents(current, value.events));
  }, [room, viewingSelf]);

  React.useEffect(() => {
    if (!room || viewingSelf) return;
    let alive = true;
    api.lordRoomEvents(room.room_id, { limit: LORD_EVENT_BATCH })
      .then((value) => {
        if (!alive) return;
        setEvents(value.events);
        setHasOlderEvents(value.events.length === LORD_EVENT_BATCH);
      })
      .catch((reason: Error) => alive && setError(reason.message))
      .finally(() => alive && setLoadingEvents(false));
    return () => { alive = false; };
  }, [room, viewingSelf]);

  const loadOlderEvents = React.useCallback(async (): Promise<number> => {
    const targetRoomId = room?.room_id;
    const before = events[0]?.event_id;
    if (
      viewingSelf ||
      !targetRoomId ||
      !before ||
      !hasOlderEvents ||
      loadingOlderEventsRef.current
    ) return 0;
    loadingOlderEventsRef.current = true;
    setLoadingOlderEvents(true);
    try {
      const value = await api.lordRoomEvents(targetRoomId, {
        before,
        limit: LORD_EVENT_BATCH,
      });
      if (activeRoomIdRef.current !== targetRoomId) return 0;
      const known = new Set(events.map((event) => event.event_id));
      const added = value.events.filter((event) => !known.has(event.event_id)).length;
      setEvents((current) => mergeObservedEvents(current, value.events));
      setHasOlderEvents(value.events.length === LORD_EVENT_BATCH);
      return added;
    } catch (reason) {
      if (activeRoomIdRef.current === targetRoomId) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      return 0;
    } finally {
      loadingOlderEventsRef.current = false;
      if (activeRoomIdRef.current === targetRoomId) setLoadingOlderEvents(false);
    }
  }, [events, hasOlderEvents, room?.room_id, viewingSelf]);

  const onWake = React.useCallback((wake: { room_id: string }) => {
    void refreshRooms().catch((reason: Error) => setError(reason.message));
    if (!viewingSelf && room && wake.room_id === room.room_id) {
      void refreshEvents(room).catch((reason: Error) => setError(reason.message));
    }
  }, [refreshEvents, refreshRooms, room, viewingSelf]);
  const lordConnected = useLordSocket(Boolean(carbon?.is_lord), onWake);
  const startResize = React.useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = sidebarW;
    let lastW = startW;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (moveEvent: PointerEvent) => {
      lastW = Math.max(
        SIDEBAR_MIN,
        Math.min(SIDEBAR_MAX, startW + (moveEvent.clientX - startX)),
      );
      setSidebarW(lastW);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE, String(lastW));
      } catch {
        /* storage may be unavailable; the width remains in React state */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [sidebarW]);

  if (!carbon?.is_lord) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-muted/20 p-6">
        <div className="w-full max-w-md border border-border bg-elevated p-8 text-center">
          <Crown className="mx-auto mb-4 size-9" />
          <h1 className="text-xl font-semibold">Lords only</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This account does not have Lord access. Team chats remain available in the normal Interface.
          </p>
          <Button asChild className="mt-6"><a href={NORMAL_INTERFACE}>Open Interface</a></Button>
        </div>
      </main>
    );
  }

  const selectedTeams = teams.filter((candidate) => filters.teams.includes(candidate.slug));
  const selectedTeamName = selectedTeams.length === 1
    ? selectedTeams[0].name
    : selectedTeams.length > 1
      ? `${selectedTeams.length} teams`
      : filters.teams.includes(OTHERS_TAB)
        ? "Others"
        : "All teams";
  const hasOtherRooms = rooms.some((candidate) => roomTeamSlugs(candidate).size === 0);
  const normalizedQuery = sidebarQuery.trim().toLowerCase();
  const filteredRooms = rooms.filter((candidate) => {
    if (!roomMatchesSelectedTeam(candidate)) return false;
    if (filters.unread && !candidate.unread) return false;
    if (
      filters.kinds.length > 0 &&
      !filters.kinds.some((kind) => candidate.peer_kinds.includes(kind))
    ) return false;
    if (!normalizedQuery) return true;
    const display = roomDisplay(candidate);
    return [
      display.name,
      display.subtitle,
      candidate.name,
      candidate.topic,
      candidate.last_event?.preview ?? "",
      ...candidate.peers.flatMap((peer) => [peer.name, peer.handle, peer.id]),
    ].join(" ").toLowerCase().includes(normalizedQuery);
  });
  const activeRooms = filteredRooms.filter(
    (candidate) => candidate.lord_access_state !== "revoked",
  );
  const revokedRooms = filteredRooms.filter(
    (candidate) => candidate.lord_access_state === "revoked",
  );
  const conversationRooms = activeRooms.filter((candidate) => candidate.last_event !== null);
  const noConnectionRooms = activeRooms.filter((candidate) => candidate.last_event === null);

  const identityBySender = new Map<string, LordIdentity>();
  for (const candidate of identities) {
    identityBySender.set(`${candidate.kind}:${candidate.id}`, candidate);
    identityBySender.set(`${candidate.kind}:${candidate.handle}`, candidate);
  }
  if (identity) {
    identityBySender.set(`${identity.kind}:${identity.id}`, identity);
    identityBySender.set(`${identity.kind}:${identity.handle}`, identity);
  }
  for (const peer of room?.peers ?? []) {
    const candidate: LordIdentity = {
      kind: peer.kind,
      id: peer.id,
      handle: peer.handle,
      name: peer.name,
      profile_photo_url: peer.profile_photo_url,
      profile_ascii_url: peer.profile_ascii_url ?? null,
      team_slugs: room?.team_slug ? [room.team_slug] : [],
      connection_state: peer.connection_state,
    };
    identityBySender.set(`${peer.kind}:${peer.id}`, candidate);
    identityBySender.set(`${peer.kind}:${peer.handle}`, candidate);
  }
  const roomTitle = room ? roomDisplay(room) : null;

  const chooseIdentity = (candidate: LordIdentity) => {
    if (identity?.kind === candidate.kind && identity.id === candidate.id) return;
    if (!isLoggedInIdentity(candidate, carbon)) {
      setFilters((current) => ({ ...current, unread: false }));
    }
    setIdentity(candidate);
    setRooms([]);
    setRoom(null);
    setViewedTeamSlug(null);
    setEvents([]);
    setLoadingRooms(true);
    setLoadingEvents(false);
    setHasOlderEvents(false);
    setLoadingOlderEvents(false);
    setSidebarQuery("");
  };

  if (viewingSelf && identity) {
    return (
      <LordsSidebarAddonProvider
        addon={(
          <IdentityPicker
            identities={identities}
            identity={identity}
            loading={loadingIdentities}
            teamName="Lord oversight"
            connected={lordConnected}
            selfId={carbon.carbon_id}
            onSelect={chooseIdentity}
          />
        )}
        initialFilters={filters}
        onFiltersChange={setFilters}
      >
        <ChatPage />
      </LordsSidebarAddonProvider>
    );
  }

  const selectRoom = (roomId: string) => {
    const candidate = rooms.find((entry) => entry.room_id === roomId);
    if (!candidate || candidate.room_id === room?.room_id) return;
    setViewedTeamSlug(null);
    setRoom(candidate);
    setEvents([]);
    setHasOlderEvents(false);
    setLoadingOlderEvents(false);
    setLoadingEvents(true);
  };

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {error ? (
        <div className="absolute inset-x-0 top-0 z-30 border-b border-destructive bg-background px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <aside
        style={{ ["--sidebar-w" as string]: `${sidebarW}px` }}
        className={cn(
          "relative z-10 min-h-0 w-full shrink-0 flex-col border-r bg-sidebar shadow-[1px_0_14px_-3px_rgba(60,50,36,0.12)] md:flex md:w-[var(--sidebar-w)]",
          room || viewedTeamSlug ? "hidden" : "flex",
        )}
      >
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="resize sidebar"
          className="absolute right-0 top-0 z-10 hidden h-full w-1.5 cursor-col-resize transition-colors hover:bg-border md:block"
        />
        <TeamSlider
          filters={filters}
          onChange={setFilters}
          teams={teams.map((candidate) => ({
            slug: candidate.slug,
            name: candidate.name,
            logo_url: candidate.logo_url,
          }))}
          hasOthers={hasOtherRooms}
          hasObserving={false}
          onOpenTeamSettings={(slug) => {
            setRoom(null);
            setEvents([]);
            setLoadingEvents(false);
            setViewedTeamSlug(slug);
          }}
        />
        <IdentityPicker
          identities={identities}
          identity={identity}
          loading={loadingIdentities}
          teamName={selectedTeamName}
          connected={lordConnected}
          selfId={carbon.carbon_id}
          onSelect={chooseIdentity}
        />
        <div className="flex h-[52px] items-stretch border-b">
          <div className="flex flex-1 items-center gap-2 pl-6 pr-3 transition-colors focus-within:bg-accent/30">
            <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <input
              value={sidebarQuery}
              onChange={(event) => setSidebarQuery(event.target.value)}
              placeholder="search Carbons + Silicons"
              className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <TeamFilterBar filters={filters} onChange={setFilters} showUnread={false} />
        <RoomList
          rooms={filteredRooms}
          flatSections={[
            { id: "conversations", label: "Conversations", rooms: conversationRooms },
            { id: "no-connection", label: "No connection", rooms: noConnectionRooms },
            { id: "revoked-access", label: "Revoked access", rooms: revokedRooms },
          ]}
          myHandle={identity?.handle}
          contacts={contacts.byPeer}
          selectedId={room?.room_id ?? null}
          onSelect={selectRoom}
          loading={loadingIdentities || loadingRooms}
          emptyMessage={
            sidebarQuery || filters.kinds.length > 0
              ? "No matching conversations."
              : identity
                ? `No connections for ${identity.name} yet.`
                : "Select an identity to view conversations."
          }
        />
      </aside>

      {viewedTeamSlug ? (
        <TeamPanel
          slug={viewedTeamSlug}
          initialTab="settings"
          readOnly
          onClose={() => setViewedTeamSlug(null)}
        />
      ) : room && roomTitle && identity ? (
        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <header className="relative z-10 flex h-[68px] items-center gap-3 border-b bg-elevated pl-3 pr-6 shadow-[0_2px_12px_-6px_rgba(60,50,36,0.14)] md:pl-6">
            <button
              type="button"
              onClick={() => {
                setRoom(null);
                setEvents([]);
                setLoadingEvents(false);
              }}
              className="grid h-9 w-9 shrink-0 place-items-center transition-colors hover:bg-accent md:hidden"
              aria-label="back to conversations"
            >
              <CaretLeft className="h-4 w-4" weight="bold" />
            </button>
            <IdAvatar
              seed={roomTitle.peer?.id ?? roomTitle.handle}
              src={roomTitle.photoUrl}
              asciiSrc={roomTitle.asciiUrl}
              size={36}
              family={roomTitle.peer?.kind ?? "carbon"}
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold tracking-tight">{roomTitle.name}</h2>
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <Eye className="h-3 w-3 shrink-0" />
                observing as {identity.name}
                {room.lord_access_state === "revoked" ? " · revoked access" : ""}
                {" · read-only"}
              </p>
            </div>
          </header>

          <ObservedChatTimeline
            key={room.room_id}
            room={room}
            events={events}
            identity={identity}
            identityBySender={identityBySender}
            loading={loadingEvents}
            hasMore={hasOlderEvents}
            loadingOlder={loadingOlderEvents}
            onLoadOlder={loadOlderEvents}
          />

          <div className="flex items-center justify-center gap-2 border-t bg-muted/40 px-6 py-4 text-xs text-muted-foreground">
            <Eye className="h-3.5 w-3.5" />
            {room.lord_access_state === "revoked"
              ? "Access was revoked. The retained history remains available only in Lords."
              : "Oversight mode is read-only. No messages, receipts, or presence are emitted."}
          </div>
        </section>
      ) : (
        <section className="hidden flex-1 items-center justify-center bg-muted/20 md:flex">
          <div className="max-w-md space-y-3 text-center">
            <Crown className="mx-auto h-7 w-7" />
            <h2 className="text-2xl font-bold tracking-tight">Lords oversight</h2>
            <p className="text-sm text-muted-foreground">
              Use your own identity to message normally, or pick another identity to observe
              Interface from their perspective.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
