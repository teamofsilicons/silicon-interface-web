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

import { ObservedChatTimeline } from "@/components/chat/observed-chat-timeline";
import { RoomList } from "@/components/chat/room-list";
import { IdAvatar } from "@/components/profile/id-avatar";
import { TeamFilterBar, TeamSlider, type ChatFilters } from "@/components/teams/team-filter-bar";
import { TeamPanel } from "@/components/teams/team-panel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLordSocket } from "@/lib/lords-ws";
import { roomDisplay } from "@/lib/peers";
import type { Event, LordIdentity, LordTeam, Room, RoomPeer } from "@/lib/types";
import { cn } from "@/lib/utils";

const NORMAL_INTERFACE = "https://interface.teamofsilicons.com";
const INITIAL_FILTERS: ChatFilters = { unread: false, kinds: [], teams: [] };

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
  onSelect,
}: {
  identities: LordIdentity[];
  identity: LordIdentity | null;
  loading: boolean;
  teamName: string;
  connected: boolean;
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
            <Eye className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {identity ? `${identity.kind} · ${teamName} · read-only` : teamName}
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
                    {candidate.kind} · @{candidate.handle}
                  </span>
                </span>
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
  const [identity, setIdentity] = React.useState<LordIdentity | null>(null);
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [room, setRoom] = React.useState<Room | null>(null);
  const [viewedTeamSlug, setViewedTeamSlug] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<Event[]>([]);
  const [sidebarQuery, setSidebarQuery] = React.useState("");
  const [loadingIdentities, setLoadingIdentities] = React.useState(true);
  const [loadingRooms, setLoadingRooms] = React.useState(false);
  const [loadingEvents, setLoadingEvents] = React.useState(false);
  const [error, setError] = React.useState("");

  const team = filters.teams[0] ?? "all";

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

  React.useEffect(() => {
    if (!carbon?.is_lord) return;
    let alive = true;
    api.lordIdentities(team)
      .then((value) => {
        if (!alive) return;
        setIdentities(value.identities);
        setLoadingRooms(value.identities.length > 0);
        setIdentity((current) =>
          current && value.identities.some(
            (candidate) => candidate.kind === current.kind && candidate.id === current.id,
          )
            ? current
            : (value.identities[0] ?? null),
        );
        setError("");
      })
      .catch((reason: Error) => alive && setError(reason.message))
      .finally(() => alive && setLoadingIdentities(false));
    return () => { alive = false; };
  }, [carbon?.is_lord, team]);

  const refreshRooms = React.useCallback(async (target = identity) => {
    if (!target) return;
    const value = await api.lordIdentityRooms(target.kind, target.id);
    const observed = value.rooms.map((candidate) => projectRoomForIdentity(candidate, target));
    setRooms(observed);
    setRoom((current) => {
      const retained = current
        ? observed.find((candidate) => candidate.room_id === current.room_id)
        : null;
      return retained ?? observed.find((candidate) => candidate.last_event !== null) ?? observed[0] ?? null;
    });
  }, [identity]);

  React.useEffect(() => {
    if (!identity) return;
    let alive = true;
    api.lordIdentityRooms(identity.kind, identity.id)
      .then((value) => {
        if (!alive) return;
        const observed = value.rooms.map((candidate) => projectRoomForIdentity(candidate, identity));
        const initialRoom = observed.find((candidate) => candidate.last_event !== null) ?? observed[0] ?? null;
        setRooms(observed);
        setRoom(initialRoom);
        setLoadingEvents(initialRoom !== null);
        setError("");
      })
      .catch((reason: Error) => alive && setError(reason.message))
      .finally(() => alive && setLoadingRooms(false));
    return () => { alive = false; };
  }, [identity]);

  const refreshEvents = React.useCallback(async (target = room) => {
    if (!target) return;
    const value = await api.lordRoomEvents(target.room_id, { limit: 200 });
    setEvents(value.events);
  }, [room]);

  React.useEffect(() => {
    if (!room) return;
    let alive = true;
    api.lordRoomEvents(room.room_id, { limit: 200 })
      .then((value) => {
        if (alive) setEvents(value.events);
      })
      .catch((reason: Error) => alive && setError(reason.message))
      .finally(() => alive && setLoadingEvents(false));
    return () => { alive = false; };
  }, [room]);

  const onWake = React.useCallback((wake: { room_id: string }) => {
    void refreshRooms().catch((reason: Error) => setError(reason.message));
    if (room && wake.room_id === room.room_id) {
      void refreshEvents(room).catch((reason: Error) => setError(reason.message));
    }
  }, [refreshEvents, refreshRooms, room]);
  const connected = useLordSocket(Boolean(carbon?.is_lord), onWake);

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

  const selectedTeam = teams.find((candidate) => candidate.slug === team);
  const selectedTeamName = selectedTeam?.name ?? "All teams";
  const normalizedQuery = sidebarQuery.trim().toLowerCase();
  const filteredRooms = rooms.filter((candidate) => {
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
  const conversationRooms = filteredRooms.filter((candidate) => candidate.last_event !== null);
  const noConnectionRooms = filteredRooms.filter((candidate) => candidate.last_event === null);

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
    setIdentity(candidate);
    setRooms([]);
    setRoom(null);
    setViewedTeamSlug(null);
    setEvents([]);
    setLoadingRooms(true);
    setLoadingEvents(false);
    setSidebarQuery("");
  };

  const changeTeam = (next: ChatFilters) => {
    const currentTeam = team === "all" ? null : team;
    const nextTeam = next.teams.find((slug) => slug !== currentTeam) ?? next.teams[0] ?? null;
    setFilters((current) => ({
      ...current,
      teams: nextTeam ? [nextTeam] : [],
    }));
    setLoadingIdentities(true);
    setLoadingRooms(false);
    setLoadingEvents(false);
    setIdentities([]);
    setIdentity(null);
    setRooms([]);
    setRoom(null);
    setViewedTeamSlug(null);
    setEvents([]);
    setSidebarQuery("");
  };

  const selectRoom = (roomId: string) => {
    const candidate = rooms.find((entry) => entry.room_id === roomId);
    if (!candidate || candidate.room_id === room?.room_id) return;
    setViewedTeamSlug(null);
    setRoom(candidate);
    setEvents([]);
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
        className={cn(
          "relative z-10 min-h-0 w-full shrink-0 flex-col border-r bg-sidebar shadow-[1px_0_14px_-3px_rgba(60,50,36,0.12)] md:flex md:w-[360px]",
          room || viewedTeamSlug ? "hidden" : "flex",
        )}
      >
        <TeamSlider
          filters={filters}
          onChange={changeTeam}
          teams={teams.map((candidate) => ({
            slug: candidate.slug,
            name: candidate.name,
            logo_url: candidate.logo_url,
          }))}
          hasOthers={false}
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
          connected={connected}
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
          ]}
          myHandle={identity?.handle}
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
                observing as {identity.name} · read-only
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
          />

          <div className="flex items-center justify-center gap-2 border-t bg-muted/40 px-6 py-4 text-xs text-muted-foreground">
            <Eye className="h-3.5 w-3.5" />
            Oversight mode is read-only. No messages, receipts, or presence are emitted.
          </div>
        </section>
      ) : (
        <section className="hidden flex-1 items-center justify-center bg-muted/20 md:flex">
          <div className="max-w-md space-y-3 text-center">
            <Crown className="mx-auto h-7 w-7" />
            <h2 className="text-2xl font-bold tracking-tight">Lords oversight</h2>
            <p className="text-sm text-muted-foreground">
              Pick an identity and a conversation to view Interface from their perspective.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
