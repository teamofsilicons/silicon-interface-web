"use client";

import * as React from "react";
import { ChatCircleText, Copy, LinkSimple } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { NotePencil, UserPlus } from "@phosphor-icons/react/dist/ssr";

import { SiliconInviteDialog } from "./silicon-invite-dialog";

import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { compactUrlLabel } from "@/lib/link-display";
import { isGifMedia } from "@/lib/media-meta";
import type { Contact, CarbonPublic, Event, LinkPreview, Room, SiliconPublic } from "@/lib/types";
import { cn } from "@/lib/utils";
import { albumMediaItems } from "@/lib/albums";
import {
  loadCompleteRoomHistory,
  mergeRoomHistoryEvents,
} from "@/lib/room-history-archive";
import { Button } from "@/components/ui/button";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IdAvatar } from "@/components/profile/id-avatar";
import { MediaAttachment } from "./media-attachment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

type SenderRef = { kind: "carbon" | "silicon"; handle: string };

interface Props {
  room: Room;
  events: Event[];
  currentUsername?: string;
  /** Saved-contact record for the room's counterpart, if any. */
  contact?: Contact;
  /** Opens the Save/Edit contact dialog (only for 1-on-1 peers). */
  onEditContact?: () => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Optional override — when set, the drawer shows this specific sender's
   *  profile instead of the room's default counterpart. */
  focusSender?: SenderRef | null;
  /** Direct room whose shared content belongs to the focused mention. */
  contentRoomId?: string | null;
  /** Opens (or creates) the focused person's direct conversation. */
  onMessage?: (target: SenderRef) => Promise<void> | void;
  /** Closes the drawer and reveals an attachment's source message. */
  onSeeInChat?: (eventId: string, roomId: string) => void;
}

type ProfileEvent = Event & { _profileSourceEventId?: string };

type TabId = "images" | "files" | "links" | "voice" | "gifs";

const TABS: { id: TabId; label: string }[] = [
  { id: "images", label: "Media" },
  { id: "files", label: "Files" },
  { id: "links", label: "Links" },
  { id: "voice", label: "Voice" },
  { id: "gifs", label: "GIFs" },
];

interface ProfileLink {
  url: string;
  eventId: string;
  createdAt: string;
  description: string;
  preview: LinkPreview | null;
}

export function ProfileDrawer({
  room,
  events,
  currentUsername,
  contact,
  onEditContact,
  open,
  onOpenChange,
  focusSender,
  contentRoomId,
  onMessage,
  onSeeInChat,
}: Props) {
  // Sender priority: explicit focus → first non-me sender → first room peer.
  const counterpart: SenderRef | null = (() => {
    if (focusSender) return focusSender;
    for (const e of events) {
      if (
        (e.sender_kind === "carbon" || e.sender_kind === "silicon") &&
        e.sender_handle &&
        e.sender_handle !== currentUsername
      ) {
        return { kind: e.sender_kind, handle: e.sender_handle };
      }
    }
    if (room.peers.length > 0) {
      return { kind: room.peers[0].kind, handle: room.peers[0].handle };
    }
    return null;
  })();

  const [profile, setProfile] = React.useState<CarbonPublic | SiliconPublic | null>(null);
  const [profileLoading, setProfileLoading] = React.useState(false);
  const [tab, setTab] = React.useState<TabId>("images");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [archivedEvents, setArchivedEvents] = React.useState<Event[]>([]);
  const [contentEventsLoading, setContentEventsLoading] = React.useState(false);
  const [contentEventsError, setContentEventsError] = React.useState(false);
  const [historyLoadAttempt, setHistoryLoadAttempt] = React.useState(0);
  const [messageOpening, setMessageOpening] = React.useState(false);

  // For a silicon profile we can offer "invite people to this silicon" when we
  // know its owner team (the invite API is scoped to that team).
  const siliconProfile =
    counterpart?.kind === "silicon" ? (profile as SiliconPublic | null) : null;
  const canInviteToSilicon = !!siliconProfile?.owner_team_slug && !!siliconProfile?.silicon_id;

  const counterpartKind = counterpart?.kind;
  const counterpartHandle = counterpart?.handle;

  React.useEffect(() => {
    if (!open || !counterpartKind || !counterpartHandle) return;
    let alive = true;
    // Drop the previous profile up front: keeping it while the new fetch is in
    // flight flashed the *last viewed* person's photo, and rendering the
    // seed-glyph placeholder flashed a wrong-looking mark before the real
    // photo arrived. Show an explicit loading state instead of either.
    queueMicrotask(() => {
      if (!alive) return;
      setProfile(null);
      setProfileLoading(true);
    });
    (async () => {
      try {
        const p =
          counterpartKind === "carbon"
            ? await api.carbonByHandle(counterpartHandle)
            : await api.siliconByHandle(counterpartHandle);
        if (alive) setProfile(p);
      } catch {
        /* ignore — drawer falls back to handle-only display */
      } finally {
        if (alive) setProfileLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, counterpartHandle, counterpartKind]);

  const targetContentRoomId = focusSender ? contentRoomId : room.room_id;

  // The timeline intentionally holds only a window of a large conversation.
  // The profile is an archive browser, so walk the signed history cursor to its
  // real beginning instead of treating the mounted window as "all files".
  React.useEffect(() => {
    let alive = true;
    if (!open || !targetContentRoomId) {
      queueMicrotask(() => {
        if (!alive) return;
        setArchivedEvents([]);
        setContentEventsLoading(false);
        setContentEventsError(false);
      });
      return () => {
        alive = false;
      };
    }
    queueMicrotask(() => {
      if (!alive) return;
      setArchivedEvents([]);
      setContentEventsLoading(true);
      setContentEventsError(false);
    });
    loadCompleteRoomHistory(
      targetContentRoomId,
      (roomId, cursor, limit) => api.historyPage(roomId, cursor, limit, "backward"),
      (loaded) => {
        if (alive) setArchivedEvents(loaded);
      },
    )
      .catch(() => {
        if (alive) setContentEventsError(true);
      })
      .finally(() => {
        if (alive) setContentEventsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [historyLoadAttempt, open, targetContentRoomId]);

  // Telegram-style shared content opens directly on media; the horizontal
  // category rail replaces the mixed "All" feed.
  React.useEffect(() => {
    let alive = true;
    if (open) {
      queueMicrotask(() => {
        if (alive) setTab("images");
      });
    }
    return () => {
      alive = false;
    };
  }, [open]);

  const contentEvents = React.useMemo(
    () => mergeRoomHistoryEvents(
      archivedEvents,
      targetContentRoomId === room.room_id ? events : [],
    ),
    [archivedEvents, events, room.room_id, targetContentRoomId],
  );
  const albumEvents = React.useMemo(
    () => contentEvents.flatMap((event) =>
      event.type === "m.album"
        ? albumMediaItems(event).map((item) => ({
            ...event,
            event_id: `${event.event_id}:${item.position}`,
            _profileSourceEventId: event.event_id,
            type: (item.kind === "image" || item.mime?.startsWith("image/")
              ? "m.image"
              : "m.file") as Event["type"],
            content: {
              media_id: item.media_id,
              mime: item.mime ?? "",
              filename: item.filename,
            },
            media_meta: {
              width: item.width ?? null,
              height: item.height ?? null,
              duration_ms: item.duration_ms ?? null,
              kind: item.kind ?? "file",
              mime: item.mime ?? "",
              status: item.status,
            },
          }))
        : [],
    ) as ProfileEvent[],
    [contentEvents],
  );
  const sharedMedia = React.useMemo<ProfileEvent[]>(
    () => [...contentEvents, ...albumEvents].filter((event) => Boolean(event.content.media_id)),
    [albumEvents, contentEvents],
  );
  const images = React.useMemo<ProfileEvent[]>(
    () => sharedMedia.filter((event) => {
      const mime = String(event.content.mime ?? event.media_meta?.mime ?? "");
      const filename = String(event.content.filename ?? "");
      return !isGifMedia(mime, filename) && (
        event.type === "m.image" || mime.startsWith("image/") || mime.startsWith("video/")
      );
    }),
    [sharedMedia],
  );
  const gifs = React.useMemo<ProfileEvent[]>(
    () => sharedMedia.filter((event) =>
      isGifMedia(
        event.content.mime ?? event.media_meta?.mime,
        event.content.filename,
      ),
    ),
    [sharedMedia],
  );
  const files = React.useMemo<ProfileEvent[]>(
    () => sharedMedia.filter((event) => {
      const mime = String(event.content.mime ?? event.media_meta?.mime ?? "");
      return event.type === "m.file" &&
        !isGifMedia(mime, event.content.filename) &&
        !mime.startsWith("image/") &&
        !mime.startsWith("video/") &&
        !mime.startsWith("audio/");
    }),
    [sharedMedia],
  );
  const voice = React.useMemo<ProfileEvent[]>(
    () => contentEvents.filter((e) => e.type === "m.voice" && e.content.media_id),
    [contentEvents],
  );
  const links = React.useMemo<ProfileLink[]>(() => {
    const out: ProfileLink[] = [];
    for (const e of contentEvents) {
      if (e.type === "m.text") {
        const body = String(e.content.body ?? "");
        const found = body.match(URL_RE);
        if (found) {
          for (const url of found) {
            out.push({
              url,
              eventId: e.event_id,
              createdAt: e.created_at,
              description: body.replace(url, "").trim(),
              preview: e.link_preview?.url === url ? e.link_preview : null,
            });
          }
        }
      }
    }
    return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [contentEvents]);

  const counts: Record<TabId, number> = {
    images: images.length,
    files: files.length,
    links: links.length,
    voice: voice.length,
    gifs: gifs.length,
  };

  // Derived display strings — never bare "@" anywhere.
  const handle = profile
    ? "carbon_id" in profile
      ? profile.carbon_id
      : profile.silicon_id
    : counterpart?.handle ?? room.peers[0]?.handle ?? "";
  // A saved contact's custom name/photo win over the target's defaults.
  const displayName = contact?.name?.trim() || profile?.name?.trim() || handle;
  const photoUrl = contact?.photo_url ?? profile?.profile_photo_url ?? null;
  // §0a — prefer the ASCII treatment unless the user set a custom contact photo.
  const asciiUrl = contact?.photo_url ? null : (profile?.profile_ascii_url ?? null);
  const bio = profile?.tagline ?? "";
  const username = profile && "username" in profile ? profile.username : "";
  const identityLabel = counterpart?.kind === "silicon" ? "silicon id" : "carbon id";
  const identityCopyLabel = counterpart?.kind === "silicon" ? "Silicon ID" : "Carbon ID";

  // QA §7.1: only toast success on a real copy (insecure-context safe).
  const copy = async (label: string, value: string) => {
    if (await copyText(value)) toast.success(`${label} copied`);
    else toast.error("couldn't copy - copy it manually");
  };

  const message = async () => {
    if (!counterpart || !onMessage || messageOpening) return;
    setMessageOpening(true);
    try {
      await onMessage(counterpart);
    } catch {
      toast.error("couldn't open this conversation");
    } finally {
      setMessageOpening(false);
    }
  };

  return (
    <>
    {/* Hide the drawer while the invite dialog is up so the two don't stack
        (the drawer's avatar + close button were bleeding through). Closing the
        invite dialog brings the drawer back. */}
    <Dialog open={open && !inviteOpen} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[88vh] w-full max-w-md overflow-x-hidden overflow-y-auto"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{displayName}</DialogTitle>
        </DialogHeader>

        {/* Avatar centered — the IdAvatar already carries its own hairline
            border. Stacking another bordered card around it was the "two
            bounding boxes" the user noticed. Single box now. */}
        <div className="flex flex-col items-center gap-3">
          {profileLoading && !contact?.photo_url ? (
            // While the profile (and its photo URL) is in flight, say so —
            // don't render the seed glyph only to swap it for the photo.
            <div
              style={{ width: 132, height: 132 }}
              className="grid shrink-0 animate-pulse place-items-center border bg-muted"
              role="status"
              aria-label="loading profile"
            >
              <span className="label-mono text-[10px] text-muted-foreground">loading…</span>
            </div>
          ) : (
            <IdAvatar seed={handle || "?"} src={photoUrl} asciiSrc={asciiUrl} size={132} family={counterpart?.kind ?? "carbon"} />
          )}
          <div className="text-center">
            <h2 className="text-lg font-semibold tracking-tight">{displayName}</h2>
            {profile && (
              <p className="text-xs text-muted-foreground">
                {counterpart?.kind === "silicon" ? "Silicon" : "Carbon"}
              </p>
            )}
            {contact?.custom_photo && (
              <p className="label-mono mt-1 text-center text-[10px] text-muted-foreground">
                Picture set by you
              </p>
            )}
          </div>
        </div>

        {/* Copyable identity chips. Each chip is a click-to-copy button. */}
        <div className="mt-3 space-y-1.5">
          {handle && (
            <CopyChip
              label={identityLabel}
              value={handle}
              onCopy={() => copy(identityCopyLabel, handle)}
            />
          )}
          {username && username !== handle && (
            <CopyChip
              label="username"
              value={`@${username}`}
              onCopy={() => copy("Username", username)}
            />
          )}
        </div>

        {bio && (
          <p className="mt-4 px-1 text-center text-sm text-muted-foreground">{bio}</p>
        )}

        {counterpart && onMessage && (
          <div className="mt-4 flex justify-center">
            <Button size="sm" onClick={() => void message()} disabled={messageOpening} className="gap-1.5">
              <ChatCircleText className="h-3.5 w-3.5" />
              {messageOpening ? "opening…" : "Message"}
            </Button>
          </div>
        )}

        {/* Saved-contact note (private to you) + edit. */}
        {contact && (
          <div className="mt-4 space-y-1.5 border-t pt-3">
            <div className="flex items-center justify-between">
              <h3 className="label-mono text-[10px] opacity-60">your note</h3>
              {onEditContact && (
                <button
                  type="button"
                  onClick={onEditContact}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <NotePencil className="h-3 w-3" /> edit
                </button>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground/90">
              {contact.note || <span className="text-muted-foreground">-</span>}
            </p>
          </div>
        )}
        {(onEditContact || canInviteToSilicon) && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 border-t pt-3">
            {!contact && onEditContact && (
              <Button size="sm" onClick={onEditContact} className="gap-1.5">
                <NotePencil className="h-3.5 w-3.5" /> Save contact
              </Button>
            )}
            {canInviteToSilicon && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setInviteOpen(true)}
                className="gap-1.5"
              >
                <UserPlus className="h-3.5 w-3.5" /> Invite people
              </Button>
            )}
          </div>
        )}

        {/* Attachment tabs */}
        <div className="mt-5 border-t pt-4">
          <div
            role="tablist"
            aria-label="Shared content"
            className="no-scrollbar -mx-6 flex h-11 items-stretch overflow-x-auto border-b px-6"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls="profile-shared-content-panel"
                aria-label={`${t.label}, ${counts[t.id]} item${counts[t.id] === 1 ? "" : "s"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTab(t.id)}
                className={cn(
                  "profile-shared-tab relative h-full min-w-0 flex-1 px-3 text-sm font-medium transition-colors",
                  tab === t.id
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{t.label}</span>
                {tab === t.id ? (
                  <span
                    aria-hidden
                    className="absolute bottom-0 h-[3px] bg-foreground"
                    style={{ left: 12, right: 12 }}
                  />
                ) : null}
              </button>
            ))}
          </div>

          <div
            id="profile-shared-content-panel"
            role="tabpanel"
            className="mt-4 min-h-32"
          >
            {contentEventsLoading && contentEvents.length === 0 ? (
              <div className="label-mono border border-dashed bg-card px-4 py-8 text-center text-[10px] text-muted-foreground">
                loading shared content…
              </div>
            ) : tab === "images" ? (
              <ImagesTab
                events={images}
                roomId={targetContentRoomId}
                onSeeInChat={onSeeInChat}
              />
            ) : tab === "files" ? (
              <FilesTab
                events={files}
                roomId={targetContentRoomId}
                onSeeInChat={onSeeInChat}
              />
            ) : tab === "links" ? (
              <LinksTab links={links} />
            ) : tab === "voice" ? (
              <VoiceTab
                events={voice}
                roomId={targetContentRoomId}
                onSeeInChat={onSeeInChat}
              />
            ) : (
              <ImagesTab
                events={gifs}
                roomId={targetContentRoomId}
                onSeeInChat={onSeeInChat}
                emptyTitle="no GIFs yet"
                emptyHint="send a GIF to see it here."
              />
            )}
            {contentEventsLoading && contentEvents.length > 0 ? (
              <p className="label-mono mt-3 text-center text-[10px] text-muted-foreground">
                loading older shared content…
              </p>
            ) : null}
            {contentEventsError ? (
              <div className="mt-3 flex items-center justify-center gap-2 border border-dashed px-3 py-2 text-xs text-muted-foreground">
                <span>Couldn&apos;t load the complete chat history.</span>
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={() => setHistoryLoadAttempt((attempt) => attempt + 1)}
                >
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {canInviteToSilicon && siliconProfile && (
      <SiliconInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        teamSlug={siliconProfile.owner_team_slug!}
        siliconId={siliconProfile.silicon_id}
        siliconName={siliconProfile.name}
      />
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bits & pieces
// ---------------------------------------------------------------------------

function CopyChip({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title={`copy ${label}`}
      className="flex w-full items-center justify-between gap-2 border bg-card px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex min-w-0 flex-col">
        <span className="label-mono text-[10px] opacity-60">{label}</span>
        <span className="truncate font-mono text-xs">{value}</span>
      </span>
      <Copy className="h-3.5 w-3.5 shrink-0 opacity-60" />
    </button>
  );
}

function Empty({
  title = "all attachments would be displayed here",
  hint = "send an attachment to see them here.",
}: {
  title?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1 border border-dashed bg-card px-4 py-8 text-center text-xs text-muted-foreground">
      <p className="text-sm text-foreground">{title}</p>
      <p>{hint}</p>
    </div>
  );
}

function ImagesTab({
  events,
  roomId,
  onSeeInChat,
  emptyTitle = "no media yet",
  emptyHint = "send a photo or video to see it here.",
}: {
  events: ProfileEvent[];
  roomId?: string | null;
  onSeeInChat?: (eventId: string, roomId: string) => void;
  emptyTitle?: string;
  emptyHint?: string;
}) {
  if (events.length === 0) return <Empty title={emptyTitle} hint={emptyHint} />;
  return (
    <div className="grid grid-cols-2 gap-2">
      {events.map((e) => (
        <AttachmentChatMenu
          key={e.event_id}
          eventId={sourceEventId(e)}
          roomId={roomId}
          onSeeInChat={onSeeInChat}
        >
          <MediaAttachment
            mediaId={String(e.content.media_id)}
            mime={e.content.mime ? String(e.content.mime) : "image/*"}
            filename={e.content.filename ? String(e.content.filename) : undefined}
            initialStatus={e.media_meta?.status}
            width={e.media_meta?.width}
            height={e.media_meta?.height}
            replyToEventId={sourceEventId(e)}
            presentation="profile-media"
          />
        </AttachmentChatMenu>
      ))}
    </div>
  );
}

function FilesTab({
  events,
  roomId,
  onSeeInChat,
}: {
  events: ProfileEvent[];
  roomId?: string | null;
  onSeeInChat?: (eventId: string, roomId: string) => void;
}) {
  if (events.length === 0) return <Empty title="no files yet" hint="send a file to see it here." />;
  return (
    <div className="grid grid-cols-2 gap-2">
      {events.map((e) => (
        <AttachmentChatMenu
          key={e.event_id}
          eventId={sourceEventId(e)}
          roomId={roomId}
          onSeeInChat={onSeeInChat}
        >
          <MediaAttachment
            mediaId={String(e.content.media_id)}
            mime={e.content.mime ? String(e.content.mime) : undefined}
            filename={e.content.filename ? String(e.content.filename) : undefined}
            caption={e.content.caption ? String(e.content.caption) : undefined}
            initialStatus={e.media_meta?.status}
            replyToEventId={sourceEventId(e)}
            presentation="profile-file"
          />
        </AttachmentChatMenu>
      ))}
    </div>
  );
}

function VoiceTab({
  events,
  roomId,
  onSeeInChat,
}: {
  events: ProfileEvent[];
  roomId?: string | null;
  onSeeInChat?: (eventId: string, roomId: string) => void;
}) {
  if (events.length === 0) return <Empty title="no voice notes yet" hint="record a voice note to see it here." />;
  return (
    <div className="space-y-2">
      {events.map((e) => (
        <AttachmentChatMenu
          key={e.event_id}
          eventId={sourceEventId(e)}
          roomId={roomId}
          onSeeInChat={onSeeInChat}
        >
          <div className="w-full border bg-card px-3 py-2">
            <MediaAttachment
              mediaId={String(e.content.media_id)}
              mime={e.content.mime ? String(e.content.mime) : "audio/webm"}
              initialStatus={e.media_meta?.status}
              presentation="profile-voice"
            />
          </div>
        </AttachmentChatMenu>
      ))}
    </div>
  );
}

function sourceEventId(event: ProfileEvent): string {
  return event._profileSourceEventId ?? event.event_id;
}

function AttachmentChatMenu({
  children,
  eventId,
  roomId,
  onSeeInChat,
}: {
  children: React.ReactNode;
  eventId: string;
  roomId?: string | null;
  onSeeInChat?: (eventId: string, roomId: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState({ x: 0, y: 0 });
  const enabled = Boolean(roomId && onSeeInChat);

  return (
    <div
      className="min-w-0"
      onContextMenu={enabled ? (event) => {
        event.preventDefault();
        setAnchor({ x: event.clientX, y: event.clientY });
        setOpen(true);
      } : undefined}
    >
      {children}
      {enabled ? (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              className="pointer-events-none fixed h-0 w-0"
              style={{ left: anchor.x, top: anchor.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" sideOffset={2}>
            <DropdownMenuItem onSelect={() => onSeeInChat?.(eventId, roomId!)}>
              <ChatCircleText className="mr-2 h-4 w-4" />
              See in Chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function LinksTab({ links }: { links: ProfileLink[] }) {
  if (links.length === 0) return <Empty title="no links yet" hint="share a link to see it here." />;
  const groups = links.reduce<Array<{ label: string; items: ProfileLink[] }>>((result, link) => {
    const date = new Date(link.createdAt);
    const label = Number.isNaN(date.getTime())
      ? "Shared links"
      : new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
    const current = result[result.length - 1];
    if (current?.label === label) current.items.push(link);
    else result.push({ label, items: [link] });
    return result;
  }, []);
  return (
    <div className="min-w-0 space-y-5">
      {groups.map((group) => (
        <section key={group.label} className="min-w-0 space-y-2">
          <h4 className="label-mono text-[10px] uppercase text-muted-foreground">
            {group.label}
          </h4>
          <ul className="min-w-0 divide-y border bg-card">
            {group.items.map((link) => {
              const preview = link.preview;
              const host = preview?.host || safeLinkHost(link.url);
              const image = preview?.image || "";
              return (
                <li key={`${link.eventId}:${link.url}`} className="min-w-0">
                  <a
                    href={link.url}
                    title={link.url}
                    aria-label={`Open ${link.url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 gap-3 px-3 py-3 transition-colors hover:bg-accent"
                  >
                    <span className="grid size-11 shrink-0 place-items-center overflow-hidden border bg-muted">
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element -- arbitrary OG thumbnail
                        <img src={image} alt="" className="sdr-media h-full w-full object-cover" />
                      ) : (
                        <LinkSimple className="h-5 w-5 text-muted-foreground" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {preview?.title || host || compactUrlLabel(link.url)}
                      </span>
                      {(preview?.description || link.description) ? (
                        <span className="line-clamp-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                          {preview?.description || link.description}
                        </span>
                      ) : null}
                      <span className="block truncate text-xs text-primary">
                        {compactUrlLabel(link.url)}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function safeLinkHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return "";
  }
}
