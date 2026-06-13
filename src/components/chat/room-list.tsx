"use client";

import * as React from "react";
import {
  CaretDown,
  CaretRight,
  Check,
  Checks,
  DotsThree,
  Eye,
  FolderSimplePlus,
  Microphone,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react/dist/ssr";

import type { ChatGroup } from "@/lib/chat-groups";
import type { Contact, Room } from "@/lib/types";
import { roomDisplay } from "@/lib/peers";
import { contactKey } from "@/lib/use-contacts";
import { cn, relativeTime } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IdAvatar } from "@/components/profile/id-avatar";
import { GlyphSkeleton } from "@/components/ui/glyph-skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One group plus the rooms (already filtered + sorted) that belong to it. */
export interface GroupSection {
  group: ChatGroup;
  rooms: Room[];
}

/** Callbacks for editing personal chat groups; only supplied when grouping is
 *  active (a team tab is selected). */
export interface GroupControls {
  /** all groups for the active team — drives the per-row "Move to group" menu */
  groups: ChatGroup[];
  onToggleCollapse: (groupId: string) => void;
  onRename: (groupId: string) => void;
  onDelete: (groupId: string) => void;
  /** move a room into a group, or out of every group when groupId is null */
  onMoveRoom: (roomId: string, groupId: string | null) => void;
  /** create a brand-new group seeded with this room */
  onCreateGroupWithRoom: (roomId: string) => void;
}

interface Props {
  rooms: Room[];
  /** My handle, to tell whether the latest message is mine (→ show a tick). */
  myHandle?: string | null;
  /** Saved contacts keyed by `${kind}:${id}` (drives @id vs name display). */
  contacts?: Map<string, Contact>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading?: boolean;
  className?: string;
  /** Set when a file is being dragged over a row; we use it to switch into
   *  that room after a brief hold (see chat page). */
  hoverRoomId?: string | null;
  /** §1d — rooms with a silicon mid-task; rendered with a faint shimmer. */
  workingRoomIds?: Set<string>;
  onRoomDragEnter?: (roomId: string) => void;
  onRoomDragLeave?: (roomId: string) => void;
  /** When set, render `groupSections` (collapsible) + `ungroupedRooms` instead
   *  of the flat `rooms` list. Used inside a team tab. */
  groupSections?: GroupSection[];
  ungroupedRooms?: Room[];
  groupControls?: GroupControls;
}

export function RoomList({
  rooms,
  myHandle,
  contacts,
  selectedId,
  onSelect,
  onNew,
  loading,
  className,
  hoverRoomId,
  workingRoomIds,
  onRoomDragEnter,
  onRoomDragLeave,
  groupSections,
  ungroupedRooms,
  groupControls,
}: Props) {
  const grouped = !!groupControls && !!groupSections;
  const visibleCount = grouped
    ? groupSections!.reduce((n, s) => n + s.rooms.length, 0) + (ungroupedRooms?.length ?? 0)
    : rooms.length;

  // Empty state lives outside the ScrollArea so it can flex-center within
  // the remaining sidebar height instead of sitting at the top with manual
  // py-16 padding.
  if (!loading && visibleCount === 0 && (!grouped || groupSections!.length === 0)) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 pb-28 text-center">
          <p className="text-sm text-muted-foreground">No conversations yet.</p>
          <Button onClick={onNew}>Start a new chat</Button>
        </div>
      </div>
    );
  }

  const rowProps = {
    myHandle,
    contacts,
    selectedId,
    onSelect,
    hoverRoomId,
    workingRoomIds,
    onRoomDragEnter,
    onRoomDragLeave,
    groupControls,
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <ScrollArea className="flex-1">
        {grouped ? (
          <div>
            {groupSections!.map(({ group, rooms: groupRooms }) => (
              <section key={group.id}>
                <GroupHeader
                  group={group}
                  count={groupRooms.length}
                  controls={groupControls!}
                />
                {!group.collapsed && (
                  // 2px bottom border marks where the group ends, distinct from
                  // the 1px dividers between individual chats.
                  <div className="border-b-2 border-foreground/15">
                    <ul className="divide-y">
                      {groupRooms.map((r) => (
                        <RoomRow key={r.room_id} room={r} {...rowProps} />
                      ))}
                      {groupRooms.length === 0 && (
                        <li className="px-6 py-2 text-xs text-muted-foreground">
                          No chats in this group yet.
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </section>
            ))}
            <ul className="divide-y">
              {loading && (
                <li>
                  <GlyphSkeleton />
                </li>
              )}
              {(ungroupedRooms ?? []).map((r) => (
                <RoomRow key={r.room_id} room={r} {...rowProps} />
              ))}
            </ul>
          </div>
        ) : (
          <ul className="divide-y">
            {loading && (
              <li>
                <GlyphSkeleton />
              </li>
            )}
            {rooms.map((r) => (
              <RoomRow key={r.room_id} room={r} {...rowProps} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function GroupHeader({
  group,
  count,
  controls,
}: {
  group: ChatGroup;
  count: number;
  controls: GroupControls;
}) {
  return (
    <div className="flex items-stretch border-b bg-secondary/40">
      <button
        type="button"
        onClick={() => controls.onToggleCollapse(group.id)}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-4 pr-2 text-left transition-colors hover:bg-secondary/70"
      >
        {group.collapsed ? (
          <CaretRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
        ) : (
          <CaretDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        )}
        <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide">
          {group.name}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${group.name} group options`}
          className="grid w-9 shrink-0 place-items-center text-muted-foreground outline-none transition-colors hover:bg-secondary/70 hover:text-foreground"
        >
          <DotsThree className="h-4 w-4" weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => controls.onRename(group.id)}>
            <PencilSimple className="mr-2 h-4 w-4" /> Rename group
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => controls.onDelete(group.id)}
            className="text-destructive hover:text-destructive focus:text-destructive"
          >
            <Trash className="mr-2 h-4 w-4" /> Delete group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface RowProps {
  room: Room;
  myHandle?: string | null;
  contacts?: Map<string, Contact>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hoverRoomId?: string | null;
  workingRoomIds?: Set<string>;
  onRoomDragEnter?: (roomId: string) => void;
  onRoomDragLeave?: (roomId: string) => void;
  groupControls?: GroupControls;
}

function RoomRow({
  room: r,
  myHandle,
  contacts,
  selectedId,
  onSelect,
  hoverRoomId,
  workingRoomIds,
  onRoomDragEnter,
  onRoomDragLeave,
  groupControls,
}: RowProps) {
  const d = roomDisplay(r);
  const isHover = hoverRoomId === r.room_id;
  const isWorking = workingRoomIds?.has(r.room_id) ?? false;
  const unread = r.unread_count ?? (r.unread ? 1 : 0);
  // The latest message is mine when its sender handle matches me — in
  // that case the right slot shows a send-status tick instead of a
  // badge (✓✓ once the other side has read it, ✓ until then).
  const mineLast = !!myHandle && r.last_event?.sender_handle === myHandle;
  // Direct 1-on-1 peer (for @id / saved-contact display).
  const peer = r.kind === "direct" && r.peers.length === 1 ? r.peers[0] : null;
  const contact = peer ? contacts?.get(contactKey(peer.kind, peer.id)) : undefined;
  const avatarSrc = contact?.photo_url ?? d.photoUrl;
  // §0a — prefer the peer's ASCII treatment, but a custom saved-contact
  // photo wins (the user chose it).
  const avatarAscii = contact?.photo_url ? null : d.asciiUrl;
  const avatarSeed = peer?.id ?? d.handle;
  const nameClass = cn(
    "block min-w-0 truncate text-sm",
    unread > 0 ? "font-semibold" : "font-medium",
  );
  const preview = roomPreview(r, d.subtitle);
  const currentGroup = groupControls?.groups.find(
    (g) => g.roomIds.includes(r.room_id),
  );

  // Double-tap opens the chat's options menu (group actions). A single tap
  // still opens the chat — we disambiguate with a short timer so the first of
  // the two taps doesn't navigate away before the double-tap registers.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const clickTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    },
    [],
  );
  const handleClick = () => {
    if (!groupControls) {
      onSelect(r.room_id);
      return;
    }
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      onSelect(r.room_id);
      clickTimerRef.current = null;
    }, 220);
  };
  const handleDoubleClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setMenuOpen(true);
  };

  return (
    <li className="relative">
      <button
        type="button"
        onClick={handleClick}
        onDoubleClick={groupControls ? handleDoubleClick : undefined}
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
          "grid w-full grid-cols-[36px_minmax(0,1fr)] items-center gap-3 py-3 pl-6 pr-4 text-left transition-colors",
          selectedId === r.room_id
            ? "bg-secondary"
            : isHover
              ? "bg-accent"
              : "hover:bg-secondary/60",
        )}
      >
        <div className="relative mt-0.5 h-9 w-9 shrink-0">
          <IdAvatar
            seed={avatarSeed}
            src={avatarSrc}
            asciiSrc={avatarAscii}
            size={36}
            family={peer?.kind ?? "carbon"}
          />
          {/* §1d — a silicon is working in this room (even unopened). */}
          {isWorking ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse border border-background bg-foreground motion-reduce:animate-none"
              title="a silicon is working here"
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_3.75rem] items-center gap-2">
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              {r.observed && (
                <Eye
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label="observing (read-only)"
                />
              )}
              {peer ? (
                contact ? (
                  <span className={nameClass}>{contact.name}</span>
                ) : (
                  // Unsaved chat → show the public id with a faint @.
                  <span className={nameClass}>
                    <span className="opacity-60">@</span>
                    {peer.id}
                  </span>
                )
              ) : (
                <span className={nameClass}>{d.name}</span>
              )}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-right text-[10px]",
                unread > 0 ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {relativeTime(r.last_event?.at ?? r.updated_at)}
            </span>
          </div>
          {/* Last-message preview (one line, type-aware) + unread
              badge. Preview falls back to the static subtitle when
              the room has no events. */}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <p
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                unread > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {r.last_event?.type === "m.voice" ? (
                <span className="inline-flex items-center gap-1 align-middle">
                  <Microphone className="h-3 w-3 shrink-0" /> voice note
                </span>
              ) : r.last_event?.type === "m.file" ? (
                // Long filenames: ellipsis in the MIDDLE so the
                // extension stays visible (the <p> still end-truncates
                // as a width fallback).
                fileNamePreview(r.last_event.preview)
              ) : (
                preview
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
      {/* Chat options — opened by double-tapping the row (no hover affordance).
          The trigger is an invisible anchor at the row's bottom edge so the
          menu drops below the row; open state is driven by handleDoubleClick. */}
      {groupControls ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            <DropdownMenuLabel>Add to group</DropdownMenuLabel>
            {groupControls.groups.map((g) => (
              <DropdownMenuItem
                key={g.id}
                disabled={currentGroup?.id === g.id}
                onSelect={() => groupControls.onMoveRoom(r.room_id, g.id)}
              >
                <span className="min-w-0 truncate">{g.name}</span>
                {currentGroup?.id === g.id && (
                  <Check className="ml-auto h-3.5 w-3.5" weight="bold" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => groupControls.onCreateGroupWithRoom(r.room_id)}>
              <FolderSimplePlus className="mr-2 h-4 w-4" /> New group…
            </DropdownMenuItem>
            {currentGroup ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => groupControls.onMoveRoom(r.room_id, null)}>
                  Remove from “{currentGroup.name}”
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/** Collapse a long string in the middle, keeping a file extension visible. */
function middleEllipsis(s: string, max = 30): string {
  if (s.length <= max) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : "";
  const base = ext ? s.slice(0, s.length - ext.length) : s;
  const keep = Math.max(6, max - ext.length - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${base.slice(0, head)}…${base.slice(base.length - tail)}${ext}`;
}

/** A file last-event preview ("📎 name") with the filename middle-truncated. */
function fileNamePreview(preview: string): string {
  const m = preview.match(/^(📎\s*)(.*)$/);
  return m ? `${m[1]}${middleEllipsis(m[2])}` : middleEllipsis(preview);
}

function roomPreview(room: Room, fallback: string): string {
  const raw = room.last_event?.preview || fallback;
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > 34 ? `${compact.slice(0, 34).trimEnd()}...` : compact;
}
