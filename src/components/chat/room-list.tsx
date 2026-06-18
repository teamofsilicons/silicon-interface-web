"use client";

import * as React from "react";
import {
  Camera,
  CaretLeft,
  Check,
  Checks,
  Clock,
  Eye,
  File,
  FolderSimple,
  FolderSimplePlus,
  Microphone,
  PencilSimple,
  SpeakerHigh,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";

import type { Contact, Room } from "@/lib/types";
import { roomDisplay } from "@/lib/peers";
import { contactKey } from "@/lib/use-contacts";
import { useDraft } from "@/lib/drafts";
import { usePendingPreview } from "@/lib/pending-preview";
import { cn, relativeTime } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IdAvatar } from "@/components/profile/id-avatar";
import { SiliconBrowserMark } from "@/components/chat/remote-browser-card";
import { GlyphSkeleton } from "@/components/ui/glyph-skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A folder shown in the sidebar — either authored in Glass ("team") or created
 *  personally by this user ("personal"). Only personal folders can be renamed
 *  or deleted from the interface. */
export interface DisplayFolder {
  id: string;
  name: string;
  source: "team" | "personal";
}

/** One folder plus the rooms (already filtered + sorted) that belong to it. */
export interface GroupSection {
  group: DisplayFolder;
  rooms: Room[];
}

/** Callbacks for the sidebar's folder grouping; only supplied when grouping is
 *  active (a team tab is selected). */
export interface GroupControls {
  /** all folders for the active team (team + personal) — drives the per-row menu */
  groups: DisplayFolder[];
  /** resolved folder id per room (override wins, else team default) */
  assignmentByRoom: Record<string, string>;
  /** the folder currently drilled into (its chats fill the list), or null */
  openGroupId: string | null;
  /** drill into a folder's chats */
  onOpenGroup: (groupId: string) => void;
  /** leave the drilled-in folder, back to the folder list */
  onCloseGroup: () => void;
  /** rename a personal folder (no-op for team folders) */
  onRename: (groupId: string) => void;
  /** delete a personal folder (no-op for team folders) */
  onDelete: (groupId: string) => void;
  /** move a room into a folder, or out of every folder when folderId is null */
  onMoveRoom: (roomId: string, groupId: string | null) => void;
  /** create a brand-new personal folder seeded with this room */
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
  /** roomId → latest progress note for a working room, shown live in the
   *  row's message-preview line with a blinking dot. */
  workingNotes?: Record<string, string>;
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
  workingNotes,
  onRoomDragEnter,
  onRoomDragLeave,
  groupSections,
  ungroupedRooms,
  groupControls,
}: Props) {
  const grouped = !!groupControls && !!groupSections;
  // The group currently drilled into (nested view of just its chats), if any.
  const openSection =
    grouped && groupControls!.openGroupId
      ? groupSections!.find((s) => s.group.id === groupControls!.openGroupId) ?? null
      : null;

  // Empty state lives outside the ScrollArea so it can flex-center within
  // the remaining sidebar height instead of sitting at the top with manual
  // py-16 padding. Only the top level (no groups + no chats) shows it — a
  // drilled-in empty group keeps its back header.
  const topLevelEmpty = grouped
    ? !openSection &&
      groupSections!.length === 0 &&
      (ungroupedRooms?.length ?? 0) === 0
    : rooms.length === 0;
  if (!loading && topLevelEmpty) {
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
    workingNotes,
    onRoomDragEnter,
    onRoomDragLeave,
    groupControls,
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <ScrollArea className="flex-1">
        {grouped ? (
          openSection ? (
            // Nested view: just the chats of the drilled-in group, with a
            // back header to return to the group list.
            <div>
              <GroupBackHeader group={openSection.group} controls={groupControls!} />
              <ul className="divide-y">
                {openSection.rooms.map((r) => (
                  <RoomRow key={r.room_id} room={r} {...rowProps} />
                ))}
                {openSection.rooms.length === 0 && (
                  <li className="px-6 py-3 text-xs text-muted-foreground">
                    No chats in this group yet. Right-click a chat to add one.
                  </li>
                )}
              </ul>
            </div>
          ) : (
            // Top level: group rows (open into their own view) then ungrouped chats.
            <div>
              {groupSections!.length > 0 && (
                <ul className="divide-y border-b">
                  {groupSections!.map(({ group, rooms: groupRooms }) => (
                    <GroupRow
                      key={group.id}
                      group={group}
                      rooms={groupRooms}
                      controls={groupControls!}
                    />
                  ))}
                </ul>
              )}
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
          )
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

/** Right-click rename/delete menu for a personal folder, at the click point. */
function GroupOptionsMenu({
  group,
  controls,
  open,
  onOpenChange,
  anchor,
}: {
  group: DisplayFolder;
  controls: GroupControls;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: { x: number; y: number };
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed h-0 w-0"
          style={{ left: anchor.x, top: anchor.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={2}>
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
  );
}

/** A group entry in the top-level list — a taller row that opens the group's
 *  own chat view on click, with an unread badge pinned to the right. */
function GroupRow({
  group,
  rooms,
  controls,
}: {
  group: DisplayFolder;
  rooms: Room[];
  controls: GroupControls;
}) {
  const unread = rooms.reduce((n, r) => n + (r.unread_count ?? (r.unread ? 1 : 0)), 0);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState({ x: 0, y: 0 });
  // Only personal folders can be renamed/deleted; team folders are read-only.
  const editable = group.source === "personal";
  const openMenu = editable
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        setAnchor({ x: e.clientX, y: e.clientY });
        setMenuOpen(true);
      }
    : undefined;
  return (
    <li
      className="relative"
      onContextMenu={openMenu}
      onDoubleClick={openMenu}
    >
      <button
        type="button"
        onClick={() => controls.onOpenGroup(group.id)}
        className="grid w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 py-4 pl-6 pr-4 text-left transition-colors hover:bg-secondary/60"
      >
        {/* Dark container block — echoes the silicon logo squares and the
            terminal "inverted block" motif, distinct from the light chat
            avatars while keeping the 36px footprint so names line up. */}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-foreground text-background">
          <FolderSimple className="h-[18px] w-[18px]" weight="fill" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold">{group.name}</span>
          <span className="label-mono mt-0.5 block truncate" style={{ fontSize: "10px" }}>
            {rooms.length} chat{rooms.length === 1 ? "" : "s"}
          </span>
        </span>
        {/* Rightmost: unread badge (only when the group has unread chats). */}
        {unread > 0 ? (
          <span
            className="inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-none text-primary-foreground"
            aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : (
          <span />
        )}
      </button>
      {editable ? (
        <GroupOptionsMenu
          group={group}
          controls={controls}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchor={anchor}
        />
      ) : null}
    </li>
  );
}

/** Header shown atop a drilled-in folder's chats; clicking it goes back. */
function GroupBackHeader({ group, controls }: { group: DisplayFolder; controls: GroupControls }) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState({ x: 0, y: 0 });
  const editable = group.source === "personal";
  const openMenu = editable
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        setAnchor({ x: e.clientX, y: e.clientY });
        setMenuOpen(true);
      }
    : undefined;
  return (
    <div
      className="relative border-b bg-secondary/40"
      onContextMenu={openMenu}
      onDoubleClick={openMenu}
    >
      <button
        type="button"
        onClick={controls.onCloseGroup}
        className="flex w-full items-center gap-2.5 py-3 pl-4 pr-4 text-left transition-colors hover:bg-secondary/70"
      >
        <CaretLeft className="h-4 w-4 shrink-0" />
        <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-foreground text-background">
          <FolderSimple className="h-3.5 w-3.5" weight="fill" />
        </span>
        <span className="min-w-0 truncate text-sm font-semibold">{group.name}</span>
        <span className="label-mono ml-auto shrink-0" style={{ fontSize: "10px" }}>
          back
        </span>
      </button>
      {editable ? (
        <GroupOptionsMenu
          group={group}
          controls={controls}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchor={anchor}
        />
      ) : null}
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
  workingNotes?: Record<string, string>;
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
  workingNotes,
  onRoomDragEnter,
  onRoomDragLeave,
  groupControls,
}: RowProps) {
  const d = roomDisplay(r);
  const isHover = hoverRoomId === r.room_id;
  const isWorking = workingRoomIds?.has(r.room_id) ?? false;
  const workingNote = workingNotes?.[r.room_id]?.trim() || "";
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
  // An unsent draft takes over the preview line (italic "draft: …"), like
  // Telegram. Updates live as the composer writes to the shared draft store.
  const draft = useDraft(r.room_id);
  // An outgoing message still waiting to send / in flight (e.g. the silicon 5s
  // hold) shows in the preview with a clock until it lands in last_event.
  const pending = usePendingPreview(r.room_id);
  const currentGroupId = groupControls?.assignmentByRoom[r.room_id];
  const currentGroup = currentGroupId
    ? groupControls?.groups.find((g) => g.id === currentGroupId)
    : undefined;

  // Right-click or double-click a chat to open its options menu (move-to-group
  // actions) at the pointer. A normal tap still just opens the chat. We pin an
  // invisible anchor to the click point and let Radix flip the menu left/up when
  // it would overflow the viewport.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState({ x: 0, y: 0 });
  const openMenu = groupControls
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        setAnchor({ x: e.clientX, y: e.clientY });
        setMenuOpen(true);
      }
    : undefined;

  return (
    <li
      className="relative"
      onContextMenu={openMenu}
      onDoubleClick={openMenu}
    >
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
          {/* §1d — "a silicon is working here" is now shown in the message
              preview line below (blinking dot + live note), not as an avatar
              badge. */}
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
                isWorking
                  ? "text-foreground"
                  : unread > 0
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {isWorking ? (
                // Live silicon activity — a blinking dot + the latest progress
                // note, so the work in progress is visible from the sidebar
                // without opening the chat.
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-foreground motion-reduce:animate-none"
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{workingNote || "working…"}</span>
                </span>
              ) : pending ? (
                // Status (stopwatch / warning) rides in the receipt slot on the
                // right, like the ticks — here we just show the text.
                <span className={cn("min-w-0 truncate", pending.status === "failed" && "text-destructive")}>
                  {pending.text}
                </span>
              ) : draft ? (
                <span className="italic">
                  <span className="text-foreground/70">draft:</span> {draft}
                </span>
              ) : (
                <LastEventPreview room={r} fallback={preview} />
              )}
            </p>
            {unread > 0 ? (
              <span
                className="inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-none text-primary-foreground"
                aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
              >
                {unread > 99 ? "99+" : unread}
              </span>
            ) : pending ? (
              // Outgoing message still waiting / in flight — show the stopwatch
              // (or a warning if it failed) where the read-receipt tick goes.
              pending.status === "failed" ? (
                <WarningCircle
                  weight="bold"
                  className="h-4 w-4 shrink-0 text-destructive"
                  aria-label="failed to send"
                />
              ) : (
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="sending" />
              )
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
      {/* Chat options — opened by right-click / two-finger tap (contextmenu),
          no hover affordance. The trigger is an invisible anchor pinned to the
          click point (fixed → viewport coords); Radix positions the menu there
          and flips it left/up via avoidCollisions when near an edge. */}
      {groupControls ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              className="pointer-events-none fixed h-0 w-0"
              style={{ left: anchor.x, top: anchor.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" sideOffset={2} className="min-w-[12rem]">
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

// Legacy previews (and some backend ones) prefix a type emoji; strip it so the
// label is clean text and we render a Phosphor icon instead.
function stripPreviewEmoji(s: string): string {
  return s.replace(/^(?:📷|📎|🎙|🔊|🌐|🖼|📹|📁)\s*/u, "");
}

/** A file last-event preview with the filename middle-truncated. */
function fileNamePreview(preview: string): string {
  return middleEllipsis(stripPreviewEmoji(preview));
}

/** One-line, type-aware last-message preview: a Phosphor icon (no emojis) plus
 *  a short label. Falls back to the plain text preview for text / no events. */
function LastEventPreview({ room, fallback }: { room: Room; fallback: string }) {
  const t = room.last_event?.type;
  const iconCls = "h-3 w-3 shrink-0";
  const wrap = (icon: React.ReactNode, label: React.ReactNode) => (
    <span className="flex min-w-0 items-center gap-1 align-middle">
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
  switch (t) {
    case "m.voice":
      return wrap(<Microphone className={iconCls} />, "voice note");
    case "m.tts":
      return wrap(<SpeakerHigh className={iconCls} />, stripPreviewEmoji(fallback) || "audio");
    case "m.image":
      return wrap(<Camera className={iconCls} />, stripPreviewEmoji(fallback) || "photo");
    case "m.remote_browser":
      return wrap(<SiliconBrowserMark className={iconCls} />, "Silicon Browser link");
    case "m.file":
      return wrap(<File className={iconCls} />, fileNamePreview(room.last_event?.preview ?? ""));
    default:
      return <>{fallback}</>;
  }
}

function roomPreview(room: Room, fallback: string): string {
  const raw = room.last_event?.preview || fallback;
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > 34 ? `${compact.slice(0, 34).trimEnd()}...` : compact;
}
