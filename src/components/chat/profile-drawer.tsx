"use client";

import * as React from "react";
import {
  ChatCircleText,
  Copy,
  FileText,
  ImageSquare,
  LinkSimple,
  MicrophoneStage,
  SquaresFour,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { NotePencil, UserPlus } from "@phosphor-icons/react/dist/ssr";

import { SiliconInviteDialog } from "./silicon-invite-dialog";

import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { Contact, CarbonPublic, Event, Room, SiliconPublic } from "@/lib/types";
import { cn } from "@/lib/utils";
import { albumMediaItems } from "@/lib/albums";
import { Button } from "@/components/ui/button";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IdAvatar } from "@/components/profile/id-avatar";
import { MediaAttachment } from "./media-attachment";

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
}

type TabId = "all" | "images" | "files" | "voice" | "links";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "all", label: "all", icon: <SquaresFour className="h-3.5 w-3.5" /> },
  { id: "images", label: "images", icon: <ImageSquare className="h-3.5 w-3.5" /> },
  { id: "files", label: "files", icon: <FileText className="h-3.5 w-3.5" /> },
  { id: "voice", label: "voice", icon: <MicrophoneStage className="h-3.5 w-3.5" /> },
  { id: "links", label: "links", icon: <LinkSimple className="h-3.5 w-3.5" /> },
];

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
  const [tab, setTab] = React.useState<TabId>("all");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [focusedEvents, setFocusedEvents] = React.useState<Event[]>([]);
  const [focusedEventsLoading, setFocusedEventsLoading] = React.useState(false);
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

  // A mention can point outside the room currently on screen. In that case,
  // load media/links from the target's direct conversation instead of leaking
  // the open room's attachments into their profile.
  React.useEffect(() => {
    let alive = true;
    const reset = (loading: boolean) => {
      queueMicrotask(() => {
        if (!alive) return;
        setFocusedEvents([]);
        setFocusedEventsLoading(loading);
      });
    };
    if (!open || !focusSender) {
      reset(false);
      return () => {
        alive = false;
      };
    }
    if (!contentRoomId) {
      reset(false);
      return () => {
        alive = false;
      };
    }
    if (contentRoomId === room.room_id) {
      reset(false);
      return () => {
        alive = false;
      };
    }
    reset(true);
    api
      .events(contentRoomId, undefined, 100)
      .then((next) => {
        if (alive) setFocusedEvents(next);
      })
      .catch(() => {
        if (alive) setFocusedEvents([]);
      })
      .finally(() => {
        if (alive) setFocusedEventsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [contentRoomId, focusSender, open, room.room_id]);

  // Reset to "all" each time the drawer is freshly opened so users land on
  // the most informative tab by default.
  React.useEffect(() => {
    let alive = true;
    if (open) {
      queueMicrotask(() => {
        if (alive) setTab("all");
      });
    }
    return () => {
      alive = false;
    };
  }, [open]);

  const contentEvents = focusSender
    ? contentRoomId === room.room_id
      ? events
      : focusedEvents
    : events;
  const albumEvents = React.useMemo(
    () => contentEvents.flatMap((event) =>
      event.type === "m.album"
        ? albumMediaItems(event).map((item) => ({
            ...event,
            event_id: `${event.event_id}:${item.position}`,
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
            },
          }))
        : [],
    ),
    [contentEvents],
  );
  const images = React.useMemo(
    () => [...contentEvents, ...albumEvents].filter(
      (e) => e.type === "m.image" && e.content.media_id,
    ),
    [albumEvents, contentEvents],
  );
  const files = React.useMemo(
    () => [...contentEvents, ...albumEvents].filter(
      (e) => e.type === "m.file" && e.content.media_id,
    ),
    [albumEvents, contentEvents],
  );
  const voice = React.useMemo(
    () => contentEvents.filter((e) => e.type === "m.voice" && e.content.media_id),
    [contentEvents],
  );
  const links = React.useMemo(() => {
    const out: string[] = [];
    for (const e of contentEvents) {
      if (e.type === "m.text") {
        const found = String(e.content.body ?? "").match(URL_RE);
        if (found) out.push(...found);
      }
    }
    return Array.from(new Set(out));
  }, [contentEvents]);

  const counts: Record<TabId, number> = {
    all: images.length + files.length + voice.length + links.length,
    images: images.length,
    files: files.length,
    voice: voice.length,
    links: links.length,
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
      <DialogContent className="max-h-[88vh] w-full max-w-md overflow-x-hidden overflow-y-auto">
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
          <div className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors",
                  tab === t.id
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card hover:bg-accent",
                )}
              >
                {t.icon}
                <span>{t.label}</span>
                <span
                  className={cn(
                    "label-mono text-[10px]",
                    tab === t.id ? "opacity-70" : "text-muted-foreground",
                  )}
                >
                  {counts[t.id]}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 min-h-32">
            {focusedEventsLoading ? (
              <div className="label-mono border border-dashed bg-card px-4 py-8 text-center text-[10px] text-muted-foreground">
                loading shared content…
              </div>
            ) : tab === "all" ? (
              <AllTab
                images={images}
                files={files}
                voice={voice}
                links={links}
                empty={counts.all === 0}
              />
            ) : tab === "images" ? (
              <ImagesTab events={images} />
            ) : tab === "files" ? (
              <FilesTab events={files} />
            ) : tab === "voice" ? (
              <VoiceTab events={voice} />
            ) : (
              <LinksTab links={links} />
            )}
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

function AllTab({
  images,
  files,
  voice,
  links,
  empty,
}: {
  images: Event[];
  files: Event[];
  voice: Event[];
  links: string[];
  empty: boolean;
}) {
  if (empty) return <Empty />;
  return (
    <div className="min-w-0 space-y-5">
      {images.length > 0 && (
        <Section title="images">
          <ImagesTab events={images} />
        </Section>
      )}
      {files.length > 0 && (
        <Section title="files">
          <FilesTab events={files} />
        </Section>
      )}
      {voice.length > 0 && (
        <Section title="voice">
          <VoiceTab events={voice} />
        </Section>
      )}
      {links.length > 0 && (
        <Section title="links">
          <LinksTab links={links} />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="label-mono text-[10px] opacity-60">{title}</h3>
      {children}
    </div>
  );
}

function ImagesTab({ events }: { events: Event[] }) {
  if (events.length === 0) return <Empty title="no images yet" hint="send an image to see it here." />;
  return (
    <div className="grid grid-cols-2 gap-2">
      {events.map((e) => (
        <MediaAttachment
          key={e.event_id}
          mediaId={String(e.content.media_id)}
          mime={e.content.mime ? String(e.content.mime) : "image/*"}
          replyToEventId={e.event_id}
        />
      ))}
    </div>
  );
}

function FilesTab({ events }: { events: Event[] }) {
  if (events.length === 0) return <Empty title="no files yet" hint="send a file to see it here." />;
  return (
    <div className="space-y-2">
      {events.map((e) => (
        <MediaAttachment
          key={e.event_id}
          mediaId={String(e.content.media_id)}
          mime={e.content.mime ? String(e.content.mime) : undefined}
          filename={e.content.filename ? String(e.content.filename) : undefined}
          caption={e.content.caption ? String(e.content.caption) : undefined}
          replyToEventId={e.event_id}
        />
      ))}
    </div>
  );
}

function VoiceTab({ events }: { events: Event[] }) {
  if (events.length === 0) return <Empty title="no voice notes yet" hint="record a voice note to see it here." />;
  return (
    <div className="space-y-2">
      {events.map((e) => (
        <MediaAttachment
          key={e.event_id}
          mediaId={String(e.content.media_id)}
          mime={e.content.mime ? String(e.content.mime) : "audio/webm"}
        />
      ))}
    </div>
  );
}

function LinksTab({ links }: { links: string[] }) {
  if (links.length === 0) return <Empty title="no links yet" hint="share a link to see it here." />;
  return (
    <ul className="min-w-0 list-disc space-y-1 pl-5 marker:text-muted-foreground">
      {links.map((u) => (
        <li key={u} className="min-w-0">
          <a
            href={u}
            target="_blank"
            rel="noopener noreferrer"
            className="block max-w-full break-all text-sm text-primary hover:underline"
          >
            {u}
          </a>
        </li>
      ))}
    </ul>
  );
}
