"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock, Eye, MagnifyingGlass, Microphone, WarningCircle, X } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { cn, dayLabel } from "@/lib/utils";
import { authStore, useAuth } from "@/lib/auth";
import { roomDisplay } from "@/lib/peers";
import { playSent, playAckTick, vibrate } from "@/lib/sounds";
import {
  shouldPromptNotifications,
  markNotificationsAsked,
  requestBrowserNotifications,
  usePresence,
} from "@/lib/notifications";
import type { AnnotationDraft, Event, EventType, HeldSend, ProgressState, Room, TeamMembership, WsFrame } from "@/lib/types";
import { clearRoomProgress, getRoomProgress } from "@/lib/progress-cache";
import {
  appendRoomEventSnippet,
  readRoomEventSnippet,
  saveRoomEventSnippet,
} from "@/lib/room-snippet";
import {
  setPendingPreview,
  updatePendingPreview,
  clearPendingPreview,
  failPendingPreview,
} from "@/lib/pending-preview";
import { advanceEventCursor } from "@/lib/event-cursor";
import { track } from "@/lib/analytics";
import { ackOutbox, enqueueOutbox } from "@/lib/outbox";
import { editableTextForEvent, withEditedText } from "@/lib/event-edit";
import { useDraftReply } from "@/lib/drafts";
import { useVoiceRecordingSession } from "@/lib/voice-recording-session";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IdAvatar } from "@/components/profile/id-avatar";
import {
  Composer,
  type ComposerRestoreDraft,
  type MentionCandidate,
  type OptimisticPayload,
} from "@/components/chat/composer";
import { VoiceRecorder } from "@/components/chat/voice-recorder";
import { AnnotationStudio } from "@/components/chat/annotation-studio/annotation-studio";
import { ForwardDialog } from "@/components/chat/forward-dialog";
import { RoomSendProvider } from "@/components/chat/room-send-context";
import { MessageBubble, type MessageStatus } from "@/components/chat/message-bubble";
import type { AnnotationOpenRequest } from "@/components/chat/media-previewer";
import { ProfileDrawer } from "@/components/chat/profile-drawer";
import { CronDrawer } from "@/components/chat/cron-drawer";
import { SaveContactDialog } from "@/components/chat/save-contact-dialog";
import type { Contact } from "@/lib/types";
import { contactKey } from "@/lib/use-contacts";
import { NotePencil, UserPlus } from "@phosphor-icons/react/dist/ssr";

interface Props {
  room: Room;
  /** Full room list passed down so forward picker has its choices. */
  allRooms: Room[];
  socket: {
    ready: boolean;
    send: (frame: object) => void;
    // QA §2.1: subscribe to EVERY frame (no coalescing). Returns an unsubscribe.
    subscribe: (fn: (f: WsFrame) => void) => () => void;
  };
  /** Saved contacts keyed by `${kind}:${id}`. */
  contacts?: Map<string, Contact>;
  /** Called after a contact is saved/edited so the parent can refetch. */
  onContactsChanged?: () => void;
  /** The parent is confirming fresh room metadata; avoid showing stale offline state. */
  connectionStatePending?: boolean;
}

type LocalEvent = Event & {
  _status?: MessageStatus;
  _clientId?: string;
};

interface PendingUnsend {
  event: Event;
  attachments: Event[];
}

interface ProgressEntry {
  roomId: string;
  groupId: string;
  state: ProgressState;
  note: string;
  updatedAt: number;
  source: "local" | "server";
  /** §1.2 — determinate progress (0..100) when the silicon reports it. */
  pct?: number | null;
  /** §1.6 — public handle of whoever is actually working, so the progress
   *  avatar isn't a "most recent silicon sender" guess. */
  handle?: string | null;
  /** Carbon message this run is working on — anchors the status under it. */
  anchorEventId?: string | null;
  /** Receipt phase shown right after sending, before real work progress:
   *  "sent" → "read" → (after a moment) the actual silicon progress. */
  receipt?: "sent" | "read";
}

const TEMP_ID = (clientId: string) => `temp-${clientId}`;

function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** One-line text for an outgoing (optimistic) message, shown in the sidebar
 *  preview while it's waiting / in flight. No emojis — the row renders an icon. */
function outgoingPreviewText(payload: OptimisticPayload): string {
  const c = (payload.content ?? {}) as Record<string, unknown>;
  switch (payload.type) {
    case "m.text":
      return String(c.body ?? "");
    case "m.image":
      return c.caption ? String(c.caption) : "photo";
    case "m.file":
      return c.filename ? String(c.filename) : "attachment";
    case "m.voice":
      return "voice note";
    case "m.tts":
      return "audio";
    case "m.remote_browser":
      return "Silicon Browser link";
    default:
      return "message";
  }
}
// Background refresh interval — keeps relative timestamps, read receipts,
// and any out-of-band events fresh even if the WS connection blips.
const POLL_INTERVAL_MS = 10_000;
const PROGRESS_MESSAGE_TYPES = new Set([
  "m.text",
  "m.image",
  "m.file",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);
const MIN_PROGRESS_STATUS_MS = 1000;
// How long a "message sent / read" receipt shows before switching to the
// actual silicon work progress.
const RECEIPT_HOLD_MS = 3000;
// §1.1 — progress staleness. We keep showing the last live line as long as the
// silicon might still be working; only after a long silence do we collapse it to
// a quiet "Still working…" (with a dismiss, in case it died with no `done`).
const PROGRESS_STALE_HARD_MS = 100_000;
// Backend search: hits per block (page) and the debounce before firing a query.
const SEARCH_INTERVAL = 40;
const SEARCH_DEBOUNCE_MS = 280;

// The "loading earlier…" indicator at the top of the timeline. Constant height
// (just fades in/out) so toggling it never shoves the list up/down.
function ChatListHeader({ loadingOlder }: { loadingOlder: boolean }) {
  return (
    <div className="flex justify-center pb-2 pt-4">
      <span
        className={cn(
          "label-mono text-[11px] text-muted-foreground transition-opacity",
          loadingOlder ? "opacity-100" : "opacity-0",
        )}
      >
        loading earlier…
      </span>
    </div>
  );
}
const PROGRESS_TYPE_MS = { min: 13, max: 24, erase: 8 };
const MAX_PROGRESS_LINE_CHARS = 64;
// Visible-message target for the initial window and each older-history load.
// Matches ROOM_SNIPPET_LIMIT so the cache can paint roughly the same timeline
// while the raw server events reconcile in the background.
const PAGE_SIZE = 30;
// Glass caps a room-events request at 200 rows. Once a raw page is dominated
// by hidden metadata (progress, reactions, redactions), use the larger page to
// reach the next visible messages without issuing dozens of tiny requests.
const RAW_SCAN_PAGE_SIZE = 200;

function isTimelineEvent(event: Event): boolean {
  return event.type !== "m.reaction" && event.type !== "m.progress" && !event.redacted_at;
}

/**
 * Load roughly one timeline page, not merely one raw-event page. Progress and
 * reaction rows are still returned so live state remains correct, but they do
 * not count toward the visible-message target. Without this scan, a silicon's
 * progress-heavy tail can fill the latest API page and make an established
 * conversation look empty with no scroll surface available to reach history.
 */
async function loadTimelineWindow(roomId: string, before?: string) {
  const pages: Event[][] = [];
  const seenCursors = new Set<string>();
  let cursor = before;
  let visibleCount = 0;
  let requestLimit = PAGE_SIZE;
  let hasMore = false;

  while (visibleCount < PAGE_SIZE) {
    const page = await api.events(roomId, cursor, requestLimit);
    if (page.length === 0) {
      hasMore = false;
      break;
    }

    pages.unshift(page);
    visibleCount += page.filter(isTimelineEvent).length;
    hasMore = page.length >= requestLimit;
    if (!hasMore || visibleCount >= PAGE_SIZE) break;

    const nextCursor = page[0]?.event_id;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      hasMore = false;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    requestLimit = RAW_SCAN_PAGE_SIZE;
  }

  return { events: pages.flat(), hasMore };
}

// Receipt progression is monotonic — pending → sent → delivered → read. The WS
// echo ("delivered") and read_receipts ("read") often land BEFORE the HTTP send
// ack, so an ack must never knock a message back down to "sent". `bestStatus`
// keeps whichever status is further along.
const STATUS_RANK: Record<MessageStatus, number> = {
  failed: -1,
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};
function bestStatus(
  a: MessageStatus | undefined,
  b: MessageStatus | undefined,
): MessageStatus | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export function RoomView({
  room,
  allRooms,
  socket,
  contacts,
  onContactsChanged,
  connectionStatePending = false,
}: Props) {
  const router = useRouter();
  const { carbon } = useAuth();
  const myUsername = carbon?.username ?? null;
  const display = roomDisplay(room);
  const voiceSession = useVoiceRecordingSession();
  const recordingRoomId = voiceSession.roomId;
  const recordingOrigin = React.useMemo(
    () => allRooms.find((candidate) => candidate.room_id === recordingRoomId) ?? null,
    [allRooms, recordingRoomId],
  );
  const recordingOriginName = recordingOrigin
    ? roomDisplay(recordingOrigin).name
    : "the original chat";
  const showRecordingBanner =
    voiceSession.phase !== "idle" &&
    recordingRoomId !== null &&
    recordingRoomId !== room.room_id;
  const peers = React.useMemo(() => (Array.isArray(room.peers) ? room.peers : []), [room.peers]);
  // Direct 1-on-1 peer and its saved-contact record (if any) — drives the
  // header title (saved name vs @id), avatar, and the Save Contact button.
  const peer = room.kind === "direct" && peers.length === 1 ? peers[0] : null;
  const contact = peer ? contacts?.get(contactKey(peer.kind, peer.id)) : undefined;
  const [siliconConnectionState, setSiliconConnectionState] = React.useState(
    peer?.kind === "silicon" ? peer.connection_state || "online" : "online",
  );
  React.useEffect(() => {
    setSiliconConnectionState(
      peer?.kind === "silicon" ? peer.connection_state || "online" : "online",
    );
  }, [peer?.id, peer?.kind, peer?.connection_state, room.room_id]);
  const siliconUnavailable =
    peer?.kind === "silicon" && !connectionStatePending && siliconConnectionState !== "online";
  const [saveOpen, setSaveOpen] = React.useState(false);
  const headerTitle = peer
    ? contact?.name || null // null → render the styled @id below
    : display.name;
  const headerPhoto = contact?.photo_url ?? display.photoUrl;
  // §0a — prefer the peer's ASCII treatment unless the user set a custom photo.
  const headerAscii = contact?.photo_url ? null : display.asciiUrl;
  const headerSeed = peer?.id ?? display.handle;
  // Observer mode: I'm in the backend allowlist and this is a silicon↔silicon
  // room I may only watch. No composer, no reactions/replies/take-backs, and
  // no read-receipts (I'm not a member, so the read POST would 403 anyway).
  const readOnly = !!room.observed;
  const showsProgressForReplies = !readOnly && peers.some((p) => p.kind === "silicon");

  React.useEffect(() => {
    if (peer?.kind !== "silicon" || connectionStatePending) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await api.roomDetail(room.room_id);
        const nextPeer =
          next.kind === "direct" ? next.peers.find((item) => item.kind === "silicon") : null;
        if (alive && nextPeer) {
          setSiliconConnectionState(nextPeer.connection_state || "online");
        }
      } catch {
        /* keep the offline flag and retry on the next tick */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [connectionStatePending, peer?.kind, room.room_id]);

  const [events, setEvents] = React.useState<LocalEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  // §2.5 — true only once the live fetch resolves. Auto-read is gated on this so
  // we never clear unread for messages that are only in the localStorage cache.
  const [hydrated, setHydrated] = React.useState(false);
  const [activeProgress, setActiveProgress] = React.useState<ProgressEntry | null>(null);
  // Drives the "sent → read → (after a moment) real progress" sequence.
  const receiptTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReceiptTimer = React.useCallback(() => {
    if (receiptTimerRef.current) {
      clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = null;
    }
  }, []);
  // Show a "message sent"/"message read" receipt line, then after a beat fall
  // through to the actual silicon work progress.
  const showReceipt = React.useCallback(
    (kind: "sent" | "read") => {
      setActiveProgress({
        roomId: room.room_id,
        groupId: `receipt:${room.room_id}`,
        state: "thinking",
        note: "",
        updatedAt: Date.now(),
        source: "local",
        receipt: kind,
      });
      clearReceiptTimer();
      receiptTimerRef.current = setTimeout(() => {
        receiptTimerRef.current = null;
        // Drop the receipt → start the real progress (unless a server progress
        // frame or the silicon's reply already replaced it).
        setActiveProgress((prev) =>
          prev && prev.receipt
            ? { ...prev, receipt: undefined, state: "thinking", updatedAt: Date.now() }
            : prev,
        );
      }, RECEIPT_HOLD_MS);
    },
    [room.room_id, clearReceiptTimer],
  );
  // True while the composer is holding a silicon text (not yet sent) — shows
  // "holding the message until you finish typing." in place of silicon progress.
  const [holdingMessage, setHoldingMessage] = React.useState(false);
  // The composer publishes its cancelQueued(clientId) here so deleting a held
  // message's bubble drops it from the send queue.
  const cancelQueuedRef = React.useRef<((clientId: string) => void) | null>(null);
  const clearHeldClientRef = React.useRef<((clientId: string) => void) | null>(null);
  // §1.1 — a monotonically-advancing tick used to detect a progress line that
  // has gone stale (silicon crashed / backend restarted with no `done` frame).
  const [progressNow, setProgressNow] = React.useState(() => Date.now());
  // §1.9 — a message arrived while scrolled up; show a "jump to latest" pill.
  const [unseenBelow, setUnseenBelow] = React.useState(false);
  // §2.7 — "load older" pagination past the latest 100-event window.
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  // §2.2 — deltas/finals that arrive before their creating `event` frame (a
  // reconnect gap or out-of-order delivery) are buffered by event_id and
  // flushed onto the event when it lands, so streamed text is never lost.
  const deltaBufferRef = React.useRef<Map<string, { body: string; final: boolean }>>(new Map());
  // §2.1 — the live frame handler, reassigned each render so the single
  // subscription always runs the latest closure.
  const frameHandlerRef = React.useRef<(f: WsFrame) => void>(() => {});
  // §6b — ensure the "first contact" note fires at most once per room (and not
  // twice under StrictMode's double-invoked updater).
  const firstContactRef = React.useRef(false);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [focusSender, setFocusSender] = React.useState<{
    kind: "carbon" | "silicon";
    handle: string;
  } | null>(null);
  const [replyTo, setReplyTo] = React.useState<Event | null>(null);
  const draftReply = useDraftReply(room.room_id);
  const restoredDraftReplyIdRef = React.useRef<string | null>(null);
  const [editingEvent, setEditingEvent] = React.useState<Event | null>(null);
  const [restoreDraft, setRestoreDraft] = React.useState<ComposerRestoreDraft | null>(null);
  // A flattened annotation set handed off from the studio, staged into the
  // composer as a reply-linked draft (consumed by the composer, then cleared).
  const [pendingAnnotationDraft, setPendingAnnotationDraft] =
    React.useState<AnnotationDraft | null>(null);
  const [annotationSource, setAnnotationSource] =
    React.useState<AnnotationOpenRequest | null>(null);
  const [search, setSearch] = React.useState<string | null>(null);
  // Backend message search (/events/search) — covers the whole history, not just
  // the loaded window. `searchResults` is null when no query is active.
  const [searchResults, setSearchResults] = React.useState<Event[] | null>(null);
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [searchHasMore, setSearchHasMore] = React.useState(false);
  const searchBlockRef = React.useRef(0);
  const messageNodeRefs = React.useRef(new Map<string, HTMLDivElement>());
  const [highlightedEventId, setHighlightedEventId] = React.useState<string | null>(null);
  const highlightTimerRef = React.useRef<number | null>(null);
  const [pendingJumpEventId, setPendingJumpEventId] = React.useState<string | null>(null);
  const lookupTargetRef = React.useRef<string | null>(null);
  const lookupRunRef = React.useRef(0);
  const [replyJumpState, setReplyJumpState] = React.useState<
    Record<string, { status: "loading" | "continue" | "error"; message?: string; cursor?: string }>
  >({});
  const [cronOpen, setCronOpen] = React.useState(false);
  const [droppedFile, setDroppedFile] = React.useState<File | null>(null);
  const [isDropTarget, setIsDropTarget] = React.useState(false);
  // #5 — Per-handle activity state. Each entry expires after `until`.
  const [activities, setActivities] = React.useState<
    Record<string, { state: "typing" | "uploading" | "recording"; until: number }>
  >({});
  React.useEffect(() => {
    lookupRunRef.current += 1;
    lookupTargetRef.current = null;
    setLoadingOlder(false);
    setPendingJumpEventId(null);
    setReplyJumpState({});
  }, [room.room_id]);
  // Clear expired activity entries on a 2s interval.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setActivities((prev) => {
        const out: typeof prev = {};
        let changed = false;
        for (const [h, a] of Object.entries(prev)) {
          if (a.until > now) out[h] = a;
          else changed = true;
        }
        return changed ? out : prev;
      });
    }, 2000);
    return () => window.clearInterval(id);
  }, []);
  // Build a (kind, id) → handle lookup so activity frames can name a sender.
  const memberHandleLookup = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of peers) {
      m.set(`${p.kind}.${p.handle}`, p.handle);
    }
    return m;
  }, [peers]);
  const handleFor = React.useCallback(
    (kind: "carbon" | "silicon", id: number): string | null => {
      // We don't reliably know peer member_id ↔ handle on the client (Glass
      // doesn't expose Carbon.id). For 1-on-1 rooms there's exactly one
      // peer — assume it's them. For groups we'd need an extra projection;
      // until then we degrade gracefully to a generic "typing…".
      if (peers.length === 1) return peers[0].handle;
      // Fallback: any peer whose kind matches.
      return peers.find((p) => p.kind === kind)?.handle ?? null;
    },
    // memberHandleLookup is used for future group lookups; kept in deps so
    // a future projection refresh re-evaluates.
    [peers, memberHandleLookup],
  );

  const sectionRef = React.useRef<HTMLElement>(null);
  // The main timeline is a plain scroll container (like WhatsApp/Slack/Telegram
  // web): the browser's native scroll-anchoring keeps the viewport steady when
  // content above it loads (images) or is prepended (older history), so nothing
  // shifts — and there are no virtualization blank-flashes. The window is small
  // (a page at a time), so the DOM node count stays bounded.
  const scrollRootRef = React.useRef<HTMLDivElement | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  // Tracks whether the user is parked at the bottom — gates "stick to bottom".
  const stickToBottomRef = React.useRef(true);
  // Set just before older history is prepended; the layout effect reads it to
  // restore the viewport so loading a page doesn't jump the user.
  const pendingPrependRef = React.useRef<{ height: number; top: number } | null>(null);

  const scrollToBottom = React.useCallback((behavior: "auto" | "smooth" = "auto") => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const requestBottomStick = React.useCallback(
    (behavior: "auto" | "smooth" = "smooth") => {
      stickToBottomRef.current = true;
      requestAnimationFrame(() => scrollToBottom(behavior));
    },
    [scrollToBottom],
  );

  // ----- Photo URL lookup per sender (for in-message avatars) -----
  const peerByHandle = React.useMemo(() => {
    const m = new Map<string, Room["peers"][number]>();
    for (const p of peers) m.set(p.handle, p);
    return m;
  }, [peers]);
  // In a team chat, `@` should offer everyone on the team — not just whoever is
  // already a peer in this room. Load the team roster when the room belongs to a
  // team; direct/Others chats fall back to the room peers alone.
  const [teamRoster, setTeamRoster] = React.useState<TeamMembership[]>([]);
  React.useEffect(() => {
    const slug = room.team_slug;
    if (!slug) {
      setTeamRoster([]);
      return;
    }
    let alive = true;
    api
      .teamMembers(slug)
      .then((rows) => {
        if (alive) setTeamRoster(rows);
      })
      .catch(() => {
        if (alive) setTeamRoster([]);
      });
    return () => {
      alive = false;
    };
  }, [room.team_slug]);

  // People offered by the composer's `@` autocomplete. Room peers first (they
  // carry richer name/photo data), then any remaining team members, deduped by
  // kind+handle. Self is never mentionable.
  const mentionCandidates = React.useMemo<MentionCandidate[]>(() => {
    // Older cached rosters may not have member_public_id, so keep a peer label
    // index as a fallback for resolving display names to stable public ids.
    const idByLabel = new Map<string, string>();
    const indexPeer = (p: Room["peers"][number]) => {
      if (p.name) idByLabel.set(`${p.kind}:${p.name.toLowerCase()}`, p.id);
      if (p.handle) idByLabel.set(`${p.kind}:${p.handle.toLowerCase()}`, p.id);
    };
    for (const r of allRooms) for (const p of Array.isArray(r.peers) ? r.peers : []) indexPeer(p);
    for (const p of peers) indexPeer(p);

    const seen = new Map<string, MentionCandidate>();
    const add = (c: MentionCandidate) => {
      const key = `${c.kind}:${c.handle}`;
      if (!seen.has(key)) seen.set(key, c);
    };
    // Room peers first — their `id` is the canonical @-mention handle.
    for (const p of peers) {
      add({
        kind: p.kind,
        handle: p.id,
        name: p.name,
        photoUrl: p.profile_photo_url,
        asciiUrl: p.profile_ascii_url,
      });
    }
    for (const m of teamRoster) {
      if ((m.member_kind !== "carbon" && m.member_kind !== "silicon") || !m.member_handle) continue;
      if (myUsername && m.member_handle === myUsername) continue;
      const id =
        m.member_public_id ??
        idByLabel.get(`${m.member_kind}:${m.member_handle.toLowerCase()}`) ??
        m.member_handle;
      add({
        kind: m.member_kind,
        handle: id,
        name: m.member_handle,
        photoUrl: m.member_photo_url,
      });
    }
    return [...seen.values()];
  }, [peers, allRooms, teamRoster, myUsername]);
  const contactForSender = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      if (!handle || (kind !== "carbon" && kind !== "silicon")) return undefined;
      return (
        contacts?.get(contactKey(kind, handle)) ??
        contacts?.get(contactKey(kind, peerByHandle.get(handle)?.id ?? ""))
      );
    },
    [contacts, peerByHandle],
  );
  const peerPhotoByHandle = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of peers) m.set(p.handle, p.profile_photo_url);
    return m;
  }, [peers]);
  // §0a — per-handle ASCII treatment, parallel to the photo map.
  const peerAsciiByHandle = React.useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of peers) m.set(p.handle, p.profile_ascii_url ?? null);
    return m;
  }, [peers]);
  const myPhotoUrl = carbon?.profile_photo_url ?? null;
  const myAscii = carbon?.profile_ascii_url ?? null;
  const photoFor = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      if (!handle) return null;
      if (handle === myUsername) return myPhotoUrl;
      const saved = contactForSender(kind, handle);
      if (saved) return saved.photo_url ?? saved.target_photo_url;
      return peerPhotoByHandle.get(handle) ?? null;
    },
    [myUsername, myPhotoUrl, contactForSender, peerPhotoByHandle],
  );
  // §0a — ASCII treatment for the in-message avatar. A custom saved-contact
  // photo wins; otherwise prefer the peer's (or my own) ASCII.
  const asciiFor = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      if (!handle) return null;
      if (handle === myUsername) return myAscii;
      const saved = contactForSender(kind, handle);
      if (saved && (saved.photo_url || saved.target_photo_url)) return null;
      return peerAsciiByHandle.get(handle) ?? null;
    },
    [myUsername, myAscii, contactForSender, peerAsciiByHandle],
  );
  const displayNameFor = React.useCallback(
    (kind: "carbon" | "silicon" | "system", handle: string | null) => {
      const saved = contactForSender(kind, handle);
      return saved?.name?.trim() || null;
    },
    [contactForSender],
  );

  // ----- Initial events load -----
  // Load on mount / room-switch. We don't poll thereafter — the WS delivers
  // events and read_receipts in real time, and re-polling just duplicates work
  // and (worse) cascades into extra `api.read` calls via the auto-read effect
  // below. The 10s "ping" is just a re-render tick for `relativeTime`.
  React.useLayoutEffect(() => {
    let mounted = true;
    const roomId = room.room_id;
    const cachedEvents = readRoomEventSnippet(roomId);
    setLoading(!cachedEvents?.some(isTimelineEvent));
    setHydrated(false);
    // Messages present when the chat opens are historical — force them final so
    // a missed finalize frame doesn't replay the "streaming…" state as if the
    // message just arrived. Live streaming still flows in via WS frames.
    setEvents((cachedEvents ?? []).map((e) => ({ ...e, is_final: true })));
    // Restore an in-flight silicon progress line captured at the page level
    // while this room was closed, so reopening a chat where work is still
    // running shows progress immediately instead of waiting for the next frame.
    setActiveProgress(getRoomProgress(roomId));
    clearReceiptTimer();
    setActivities({});
    restoredDraftReplyIdRef.current = null;
    setReplyTo(null);
    setEditingEvent(null);
    setRestoreDraft(null);
    setFocusSender(null);
    setProfileOpen(false);
    setUnseenBelow(false);
    deltaBufferRef.current.clear();
    firstContactRef.current = false;
    loadTimelineWindow(roomId)
      .then(({ events: evs, hasMore }) => {
        if (!mounted) return;
        // Room loads count as "seen" for the global resync cursor.
        const owner = authStore.getCarbon()?.carbon_id;
        if (owner) for (const e of evs) advanceEventCursor(owner, e.event_id);
        setEvents((prev) => {
          const pending = prev.filter((e) => e.event_id.startsWith("temp-") || e._status === "pending");
          // Loaded history is complete — mark final so it doesn't replay
          // "streaming…" on open (live deltas still arrive via WS).
          const finalized = evs.map((e) => ({ ...e, is_final: true }));
          return mergeServerEvents(pending, finalized, myUsername);
        });
        setHasMore(hasMore);
        setHydrated(true); // §2.5 — live data is in; auto-read may now run
        setLoading(false);
      })
      .catch((e) => {
        if (!mounted) return;
        toast.error(e instanceof ApiError ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      mounted = false;
      clearReceiptTimer();
    };
  }, [room.room_id, myUsername, clearReceiptTimer]);

  React.useEffect(() => {
    if (loading) return;
    saveRoomEventSnippet(room.room_id, events);
  }, [events, loading, room.room_id]);

  // Force a re-render every 10s so `relativeTime` advances ("just now" →
  // "1m" → "2m"). No network — purely a UI tick.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(
      () => forceTick((n) => n + 1),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  // ----- WS subscribe + frame handling -----
  React.useEffect(() => {
    if (socket.ready) socket.send({ type: "subscribe", room_id: room.room_id });
  }, [socket.ready, room.room_id, socket.send]);

  // On reconnect, re-pull events for the open room — any frames delivered while
  // the socket was down (backend restart, tab asleep) are gone otherwise.
  const prevReadyRef = React.useRef(socket.ready);
  React.useEffect(() => {
    if (socket.ready && !prevReadyRef.current) {
      // Same window as the initial load — this effect also fires on the FIRST
      // connect of a fresh page load, so refetching a larger window here would
      // reflow the just-rendered list ("loads again a few seconds in"). A
      // PAGE_SIZE window merges near-identically and still recovers frames
      // missed during a short drop.
      api
        .events(room.room_id, undefined, PAGE_SIZE)
        .then((evs) => {
          const owner = authStore.getCarbon()?.carbon_id;
          if (owner) for (const e of evs) advanceEventCursor(owner, e.event_id);
          setEvents((prev) => mergeServerEvents(prev, evs, myUsername));
          // §1.7 — after a (re)connect, resync the progress line from the cache
          // rather than blindly dropping it: this effect also fires on the first
          // connect of a fresh page load, and the cache (persisted across
          // refresh) is the only record of an in-flight task. A local receipt
          // line is left alone. If the task finished, the cache was cleared by a
          // `done`/message frame and this resolves to null.
          setActiveProgress((p) =>
            p && p.source !== "server" ? p : getRoomProgress(room.room_id),
          );
        })
        .catch(() => undefined);
    }
    prevReadyRef.current = socket.ready;
  }, [socket.ready, room.room_id, myUsername]);


  const applyHeldSendFrame = (held: HeldSend) => {
    if (held.room_id !== room.room_id) return;
    const clientId = held.client_id;
    if (!clientId) return;
    if (held.state === "cancelled") {
      clearHeldClientRef.current?.(clientId);
      clearPendingPreview(room.room_id, clientId);
      setEvents((prev) => prev.filter((e) => e._clientId !== clientId));
      return;
    }
    if (held.state === "failed") {
      clearHeldClientRef.current?.(clientId);
      failPendingPreview(room.room_id, clientId);
      setEvents((prev) =>
        prev.map((e) => (e._clientId === clientId ? { ...e, _status: "failed" as MessageStatus } : e)),
      );
      return;
    }
    if (held.state === "sent") {
      clearHeldClientRef.current?.(clientId);
      clearPendingPreview(room.room_id, clientId);
      return;
    }
    if (!myUsername) return;
    const body = typeof held.content.body === "string" ? held.content.body : "";
    setEvents((prev) => {
      const existingIndex = prev.findIndex(
        (e) => e._clientId === clientId || e.content.client_id === clientId,
      );
      if (existingIndex >= 0) {
        const existing = prev[existingIndex];
        if (existing.content.hold_release_at === held.release_at) return prev;
        const next = [...prev];
        next[existingIndex] = {
          ...existing,
          content: { ...existing.content, hold_release_at: held.release_at },
        };
        return next;
      }
      const pending: LocalEvent = {
        event_id: `temp-${clientId}`,
        room: 0,
        sender_kind: "carbon",
        sender_id: null,
        sender_handle: myUsername,
        type: "m.text",
        content: { body, client_id: clientId, hold_release_at: held.release_at },
        reply_to_event_id: held.reply_to_event_id || "",
        is_final: true,
        created_at: held.created_at || new Date().toISOString(),
        edited_at: null,
        redacted_at: null,
        redaction_reason: "",
        _status: "pending",
        _clientId: clientId,
      };
      return [...prev, pending];
    });
    setPendingPreview(room.room_id, {
      clientId,
      text: body || "Message pending",
      status: "waiting",
    });
  };

  // §2.1 — the per-frame handler, kept current via a deps-less effect so the
  // single subscription always runs the latest closure. Processes EVERY frame,
  // so no delta / receipt / take-back is ever coalesced away.
  React.useEffect(() => {
    frameHandlerRef.current = (f: WsFrame) => {
    if ("room_id" in f && f.room_id !== room.room_id) return;
    if (f.type === "event") {
      const incoming = f.event;
      const mine = incoming.sender_handle && incoming.sender_handle === myUsername;
      const updatesExisting = events.some((e) => e.event_id === incoming.event_id);
      if (incoming.type === "m.progress") {
        const state = (incoming.content.state as ProgressState) || "thinking";
        clearReceiptTimer(); // real progress takes over from any receipt line
        if (state === "done") {
          // Done just clears the live ProgressLine — no timeline row. The
          // silicon's own follow-up message carries the outcome.
          setActiveProgress(null);
        } else {
          setActiveProgress({
            roomId: room.room_id,
            groupId: String(incoming.content.progress_group_id || incoming.event_id),
            state,
            note: String(incoming.content.note || ""),
            updatedAt: Date.now(),
            source: "server",
            pct: numOrNull(incoming.content.progress_pct),
            handle: incoming.sender_handle,
            anchorEventId: incoming.content.run_anchor_event_id
              ? String(incoming.content.run_anchor_event_id)
              : null,
          });
        }
        return;
      }
      if (!updatesExisting && !mine && PROGRESS_MESSAGE_TYPES.has(incoming.type)) {
        clearReceiptTimer();
        setActiveProgress(null);
      }
      // §1.9 — a new message from someone else while scrolled up: surface a pill.
      if (!updatesExisting && !mine && PROGRESS_MESSAGE_TYPES.has(incoming.type) && !stickToBottomRef.current) {
        setUnseenBelow(true);
      }
      // The received tone is played once, globally, by the chat page (so it
      // fires for any room, not just the open one).
      setEvents((prev) => {
        const existsIdx = prev.findIndex((e) => e.event_id === incoming.event_id);
        if (existsIdx >= 0) {
          const updated = [...prev];
          const cur = updated[existsIdx];
          updated[existsIdx] = {
            ...incoming,
            _clientId: cur._clientId,
            _status: mine ? bestStatus(cur._status, "delivered") : cur._status,
          };
          return updated;
        }
        if (mine) {
          // §2.3 — prefer matching the echo to its optimistic row by the
          // client id the server echoes back (robust to server-side content
          // enrichment: media_id, link_preview, whitespace, forward_from).
          // Fall back to the old content-equality heuristic when absent.
          const echoedClientId =
            typeof incoming.content.client_id === "string" ? incoming.content.client_id : null;
          // "failed" rows are candidates too: a background outbox flush (or a
          // POST whose response was lost after the server stored it) can land
          // the echo while the local row still says failed — the echo with our
          // client id is authoritative, so claim it instead of duplicating.
          const optIdx = prev.findIndex(
            (e) =>
              (e._status === "pending" || e._status === "failed") &&
              (echoedClientId
                ? e._clientId === echoedClientId
                : e.sender_handle === incoming.sender_handle &&
                  e.type === incoming.type &&
                  JSON.stringify(e.content) === JSON.stringify(incoming.content)),
          );
          if (optIdx >= 0) {
            const updated = [...prev];
            updated[optIdx] = {
              ...incoming,
              _clientId: prev[optIdx]._clientId,
              _status: "delivered",
            };
            return updated;
          }
        }
        // §2.2 — flush any deltas/final that arrived before this creating frame.
        const buffered = deltaBufferRef.current.get(incoming.event_id);
        let merged: Event = incoming;
        if (buffered) {
          deltaBufferRef.current.delete(incoming.event_id);
          merged = {
            ...incoming,
            is_final: incoming.is_final || buffered.final,
            content: {
              ...incoming.content,
              body: ((incoming.content.body as string) ?? "") + buffered.body,
            },
          };
        }
        return [...prev, { ...merged, _status: mine ? "delivered" : undefined }];
      });
    } else if (f.type === "event.delta") {
      setEvents((prev) => {
        const idx = prev.findIndex((e) => e.event_id === f.event_id);
        if (idx < 0) {
          // §2.2 — creating `event` not here yet; buffer the delta.
          const buf = deltaBufferRef.current.get(f.event_id) ?? { body: "", final: false };
          buf.body += f.delta;
          deltaBufferRef.current.set(f.event_id, buf);
          return prev;
        }
        const updated = [...prev];
        const e = updated[idx];
        updated[idx] = {
          ...e,
          content: { ...e.content, body: ((e.content.body as string) ?? "") + f.delta },
        };
        return updated;
      });
    } else if (f.type === "event.final") {
      setEvents((prev) => {
        const idx = prev.findIndex((e) => e.event_id === f.event_id);
        if (idx < 0) {
          const buf = deltaBufferRef.current.get(f.event_id) ?? { body: "", final: false };
          buf.final = true;
          deltaBufferRef.current.set(f.event_id, buf);
          return prev;
        }
        const updated = [...prev];
        updated[idx] = { ...updated[idx], is_final: true };
        return updated;
      });
    } else if (f.type === "event.transcript") {
      setEvents((prev) =>
        prev.map((e) =>
          e.event_id === f.event_id
            ? { ...e, content: { ...e.content, transcript: f.transcript } }
            : e,
        ),
      );
    } else if (f.type === "event.remote_browser_close") {
      // The silicon closed the shared browser early — flip the card to
      // "session closed" and expire its link without waiting for the timer.
      setEvents((prev) =>
        prev.map((e) =>
          e.event_id === f.event_id
            ? {
                ...e,
                content: { ...e.content, closed: true, expires_at: f.expires_at },
              }
            : e,
        ),
      );
    } else if (f.type === "held_send") {
      applyHeldSendFrame(f.held_send);
    } else if (f.type === "read_receipt") {
      // Receipts are broadcast for EVERY mark-read — including my own reads on
      // other devices. Only a PEER's receipt can flip my messages to "read";
      // my own receipt says nothing about whether they saw anything.
      if (f.member_handle && f.member_handle === myUsername) return;
      // §2.6 — mark by POSITION, not string `<=`. String ordering is only valid
      // for fixed-width Crockford ULIDs; forwarded/UUID-fallback ids break it.
      let didRead = false;
      setEvents((prev) => {
        const cutoffIdx = prev.findIndex((e) => e.event_id === f.event_id);
        if (cutoffIdx < 0) return prev; // cutoff outside our window — don't guess
        let changed = false;
        const updated = prev.map((e, i) => {
          if (i <= cutoffIdx && e.sender_handle === myUsername && e._status !== "read") {
            changed = true;
            return { ...e, _status: "read" as MessageStatus };
          }
          return e;
        });
        if (changed) didRead = true;
        return changed ? updated : prev;
      });
      // My just-sent message got read → upgrade the receipt line ("read"),
      // which restarts the brief hold before the real progress shows.
      if (didRead && activeProgress?.receipt) showReceipt("read");
    } else if (f.type === "take_back") {
      setEvents((prev) =>
        prev.map((e) =>
          f.event_ids.includes(e.event_id)
            ? { ...e, redacted_at: new Date().toISOString(), redaction_reason: "redacted" }
            : e,
        ),
      );
    } else if (f.type === "progress") {
      if (f.state && f.progress_group_id) {
        clearReceiptTimer(); // real progress takes over from any receipt line
        if (f.state === "done") {
          setActiveProgress(null);
        } else {
          setActiveProgress({
            roomId: room.room_id,
            groupId: f.progress_group_id,
            state: f.state as ProgressState,
            note: f.note || "",
            updatedAt: Date.now(),
            source: "server",
            pct: numOrNull(f.progress_pct),
            handle: f.member_handle ?? null,
            anchorEventId: f.run_anchor_event_id ?? null,
          });
        }
      }
      // #5 — Activity beacon (typing | uploading | recording). Skip my own
      // beacons; track per-handle so we can show "@alice is recording…"
      // alongside any other active state.
      const kind = f.kind;
      if (kind === "typing" || kind === "uploading" || kind === "recording") {
        // Prefer the handle the server stamps on the beacon — it identifies the
        // actual sender, so I can attribute it correctly *and* ignore my own
        // (the old handleFor() always returned the peer in a 1-on-1 room, which
        // made my own recording show up as "@peer is recording").
        const handle =
          f.member_handle ??
          (f.member_id !== undefined &&
          (f.member_kind === "carbon" || f.member_kind === "silicon")
            ? handleFor(f.member_kind, f.member_id)
            : null);
        if (handle && handle !== myUsername) {
          const active = f.is_typing !== false;
          setActivities((prev) => {
            const next = { ...prev };
            if (active) next[handle] = { state: kind, until: Date.now() + 8000 };
            else delete next[handle];
            return next;
          });
        }
      }
    }
    };
  });

  // Subscribe once; the handler ref above carries the latest closure (§2.1).
  React.useEffect(() => {
    return socket.subscribe((f) => frameHandlerRef.current(f));
  }, [socket.subscribe]);

  // §1.1 — while a progress line is showing, advance a 1s tick so we can detect
  // staleness (the silicon crashed / backend restarted with no `done` frame).
  React.useEffect(() => {
    if (!activeProgress) return;
    const id = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeProgress]);

  // ----- Scroll + auto-read -----
  // Reset bottom-stick when the room changes (we start at the bottom).
  React.useEffect(() => {
    stickToBottomRef.current = true;
  }, [room.room_id]);

  // Auto-read: derive the latest event from someone other than me, and only
  // POST when *that event_id* changes. The previous version depended on the
  // entire `events` array, which fires on every poll, every optimistic add,
  // and every WS frame — flooding the server with idempotent reads.
  const lastTheirsEventId = React.useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.sender_handle && e.sender_handle !== myUsername) return e.event_id;
    }
    return null;
  }, [events, myUsername]);

  // Auto-read requires the user to actually be present (visible tab; in the
  // desktop wrapper: visible AND focused window). A minimized/hidden app with
  // this room open must NOT silently read incoming messages — they'd never
  // notify. `present` flips true on return, re-running the effect to catch up.
  const present = usePresence();
  React.useEffect(() => {
    if (readOnly) return; // observers don't mark read — they aren't members
    if (!hydrated) return; // §2.5 — don't mark cached-but-unseen messages read
    if (!lastTheirsEventId) return;
    if (!present) return;
    api.read(room.room_id, lastTheirsEventId).catch(() => undefined);
  }, [lastTheirsEventId, room.room_id, readOnly, hydrated, present]);

  // ----- Take-back / self-delete / react / reply / forward -----
  const onTakeBack = async (eventId: string, force = false) => {
    try {
      const r = await api.takeBack(eventId, "manual", force);
      if (r && "detail" in r) toast.error(r.detail);
      else toast.success("took back");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const restoreFromEvent = React.useCallback((ev: Event, attachments: Event[] = []) => {
    const content = ev.content as Record<string, unknown>;
    const text =
      ev.type === "m.text"
        ? String(content.body ?? "")
        : ev.type === "m.image" || ev.type === "m.file"
          ? String(content.caption ?? "")
          : ev.type === "m.voice"
            ? String(content.transcript ?? "")
            : "";
    const mediaEvents =
      ev.type === "m.image" || ev.type === "m.file" ? [ev, ...attachments] : attachments;
    const restoredAttachments = mediaEvents
      .map((item) => {
        const c = item.content as Record<string, unknown>;
        const mediaId = typeof c.media_id === "string" ? c.media_id : "";
        if (!mediaId) return null;
        return {
          mediaId,
          mime: String(c.mime || item.media_meta?.mime || "application/octet-stream"),
          name: String(c.filename || c.caption || item.type.replace("m.", "") || "attachment"),
          size: typeof c.size === "number" ? c.size : 0,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    setRestoreDraft({
      id: `${ev.event_id}:${Date.now()}`,
      text,
      attachments: restoredAttachments,
    });
  }, []);

  // Unsend is two-step for persisted events: clicking stages the target; the
  // confirm dialog performs backend redaction and then restores the draft.
  const [pendingDelete, setPendingDelete] = React.useState<PendingUnsend | null>(null);
  const onSelfDelete = (ev: Event, attachments: Event[] = []) => {
    // A held/optimistic message that never reached the server: cancel the
    // queued send and drop the bubble — nothing to redact, no confirm needed.
    const clientId = (ev as LocalEvent)._clientId;
    if (ev.event_id.startsWith("temp-") && clientId) {
      cancelQueuedRef.current?.(clientId);
      setHoldingMessage(false);
      setEditingEvent((cur) => (cur?.event_id === ev.event_id ? null : cur));
      setEvents((prev) => prev.filter((e) => e._clientId !== clientId));
      restoreFromEvent(ev, attachments);
      return;
    }
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
    setPendingDelete({ event: ev, attachments });
  };

  const confirmDelete = async () => {
    const pending = pendingDelete;
    if (!pending) return;
    const { event: ev, attachments } = pending;
    setPendingDelete(null);
    const targets = [ev, ...attachments];
    const deleteTargets = [...attachments, ev];
    // §2.4 — snapshot the prior row so a failed delete can be rolled back
    // instead of leaving it "deleted" until the next refetch reverts it.
    const snapshots = targets
      .map((target) => events.find((e) => e.event_id === target.event_id))
      .filter((item): item is LocalEvent => Boolean(item));
    // Optimistically mark redacted so the bubble updates instantly.
    setEvents((prev) =>
      prev.map((e) =>
        targets.some((target) => target.event_id === e.event_id)
          ? {
              ...e,
              redacted_at: new Date().toISOString(),
              redaction_reason: "unsend",
              content: { redacted: true, reason: "unsend" },
            }
          : e,
      ),
    );
    const rollback = () => {
      if (!snapshots.length) return;
      const byId = new Map(snapshots.map((item) => [item.event_id, item]));
      setEvents((prev) => prev.map((e) => byId.get(e.event_id) ?? e));
    };
    try {
      for (const target of deleteTargets) {
        const r = await api.deleteEvent(target.event_id);
        if (r && "detail" in r) {
          rollback();
          toast.error(r.detail);
          return;
        }
      }
      restoreFromEvent(ev, attachments);
      toast.success("unsent");
    } catch (e) {
      rollback();
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onReact = async (ev: Event, emoji: string) => {
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
    // Toggle: if I already reacted to this message with this emoji, remove that
    // reaction; otherwise add one. Reactions are m.reaction events keyed to the
    // target via reply_to_event_id; the WS echo / take_back folds the change
    // into the reaction map below.
    const existing = events.find(
      (e) =>
        e.type === "m.reaction" &&
        !e.redacted_at &&
        e.reply_to_event_id === ev.event_id &&
        e.sender_handle === myUsername &&
        String((e.content as { emoji?: unknown }).emoji ?? "") === emoji,
    );
    if (existing) {
      // Optimistically drop my reaction, then redact it server-side.
      const snapshot = existing; // §2.4 — restore the reaction if the redact fails
      setEvents((prev) =>
        prev.map((e) =>
          e.event_id === existing.event_id
            ? { ...e, redacted_at: new Date().toISOString(), redaction_reason: "unreact" }
            : e,
        ),
      );
      const rollback = () =>
        setEvents((prev) =>
          prev.map((e) => (e.event_id === snapshot.event_id ? snapshot : e)),
        );
      try {
        const r = await api.deleteEvent(existing.event_id);
        if (r && "detail" in r) {
          rollback();
          toast.error(r.detail);
        }
      } catch (e) {
        rollback();
        toast.error(e instanceof ApiError ? e.message : String(e));
      }
      return;
    }
    try {
      await api.sendEvent(room.room_id, {
        type: "m.reaction",
        content: { emoji },
        reply_to_event_id: ev.event_id,
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onReply = (ev: Event) => {
    setEditingEvent(null);
    restoredDraftReplyIdRef.current = null;
    setReplyTo(ev);
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
  };

  const roomIncludesSilicon = peers.some((p) => p.kind === "silicon");
  const canUnsendMessage = React.useCallback(
    (ev: LocalEvent | Event) => {
      if (!isMyEvent(ev, myUsername)) return false;
      if (ev.redacted_at) return false;
      const local = ev as LocalEvent;
      const isHeldOrPending = ev.event_id.startsWith("temp-") && Boolean(local._clientId);
      if (isHeldOrPending) return true;
      if (roomIncludesSilicon) return false;
      if (typeof ev.can_unsend === "boolean") return ev.can_unsend;
      return local._status !== "read";
    },
    [myUsername, roomIncludesSilicon],
  );
  const canEditMessage = React.useCallback(
    (ev: LocalEvent | Event) => {
      if (!isMyEvent(ev, myUsername)) return false;
      if (ev.redacted_at || ev.is_final === false) return false;
      if (editableTextForEvent(ev) === null) return false;
      if (roomIncludesSilicon) {
        return ev.event_id.startsWith("temp-") && Boolean((ev as LocalEvent)._clientId);
      }
      return true;
    },
    [myUsername, roomIncludesSilicon],
  );

  const beginEdit = React.useCallback(
    (ev: Event) => {
      if (!canEditMessage(ev)) return;
      setReplyTo(null);
      setEditingEvent(ev);
    },
    [canEditMessage],
  );

  const persistEdit = React.useCallback(
    async (ev: Event, body: string) => {
      const editedAt = new Date().toISOString();
      const snapshot = events.find((item) => item.event_id === ev.event_id);
      setEvents((prev) =>
        prev.map((item) =>
          item.event_id === ev.event_id ? withEditedText(item, body, editedAt) : item,
        ),
      );
      try {
        const real = await api.editEvent(ev.event_id, body);
        setEvents((prev) =>
          prev.map((item) =>
            item.event_id === real.event_id
              ? {
                  ...real,
                  _clientId: item._clientId,
                  _status: item._status,
                }
              : item,
          ),
        );
      } catch (e) {
        if (snapshot) {
          setEvents((prev) => prev.map((item) => (item.event_id === snapshot?.event_id ? snapshot : item)));
        }
        toast.error(e instanceof ApiError ? e.message : String(e));
        throw e;
      }
    },
    [events],
  );

  // #17 — Forward picker. Setting `forwardingEvent` opens the dialog; the
  // dialog handles room selection and re-posting with forward_from metadata.
  const [forwardingEvent, setForwardingEvent] = React.useState<Event | null>(null);
  const onForward = (ev: Event) => setForwardingEvent(ev);

  // Dope #79 — multi-select → mass forward. `selectMode` swaps the composer for
  // a selection action bar; `selectedEventIds` holds the chosen source events.
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedEventIds, setSelectedEventIds] = React.useState<Set<string>>(new Set());
  // `forwardSelection` opens the shared ForwardDialog against the selection
  // (rather than a single `forwardingEvent`).
  const [forwardSelection, setForwardSelection] = React.useState(false);
  const MAX_FORWARD = 50;

  // 'select' options-menu action: enter select-mode with this message chosen.
  const onSelect = (ev: Event) => {
    setSelectMode(true);
    setSelectedEventIds(new Set([ev.event_id]));
  };
  const toggleSelect = (ev: Event) => {
    const already = selectedEventIds.has(ev.event_id);
    // Cap the set; a toggle that would exceed the cap is a no-op with a hint.
    if (!already && selectedEventIds.size >= MAX_FORWARD) {
      toast.error(`you can forward up to ${MAX_FORWARD} messages at once`);
      return;
    }
    setSelectedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(ev.event_id)) next.delete(ev.event_id);
      else next.add(ev.event_id);
      return next;
    });
  };
  const cancelSelect = () => {
    setSelectedEventIds(new Set());
    setSelectMode(false);
    setForwardSelection(false);
  };
  // Resolve the selected ids to events, deduped by attachment `bundle_id`.
  // Selection granularity is the visible bubble (the text/primary event) and
  // pinned attachments aren't independently selectable, so a bundle already
  // maps to a single selectable unit — but we dedupe defensively so the server
  // (which expands the bundle from any member) never forwards it twice.
  const selectedEvents = React.useMemo(() => {
    if (selectedEventIds.size === 0) return [] as Event[];
    const byId = new Map(events.map((e) => [e.event_id, e]));
    const out: Event[] = [];
    const seenBundles = new Set<string>();
    for (const id of selectedEventIds) {
      const ev = byId.get(id);
      if (!ev) continue;
      const bid = (ev.content as { bundle_id?: unknown }).bundle_id;
      if (typeof bid === "string" && bid) {
        if (seenBundles.has(bid)) continue;
        seenBundles.add(bid);
      }
      out.push(ev);
    }
    return out;
  }, [selectedEventIds, events]);

  // Aggregate reactions: target_event_id → { emoji → [sender_handle] }
  const reactionsByTarget = React.useMemo(() => {
    const map = new Map<string, Record<string, string[]>>();
    for (const e of events) {
      if (e.type !== "m.reaction") continue;
      if (e.redacted_at) continue;
      const target = e.reply_to_event_id;
      const emoji = String((e.content as { emoji?: unknown }).emoji ?? "");
      if (!target || !emoji) continue;
      const bucket = map.get(target) ?? {};
      const who = bucket[emoji] ?? [];
      if (e.sender_handle && !who.includes(e.sender_handle)) {
        who.push(e.sender_handle);
      }
      bucket[emoji] = who;
      map.set(target, bucket);
    }
    return map;
  }, [events]);

  // Visible events drop reactions (they render as chips under the target) and
  // deleted/redacted messages (hidden entirely — no "message deleted" row).
  const visibleEvents = React.useMemo(
    // ALL progress events stay out of the timeline (live ones render as the
    // transient ProgressLine instead). Letting done-progress through used to
    // render a "Silicon finished" row — and, worse, it sat between two of a
    // silicon's messages and broke the (sender, minute) run, so avatars showed
    // on some of its messages and not others.
    () => events.filter(isTimelineEvent),
    [events],
  );

  const requestEditLast = React.useCallback(() => {
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const event = visibleEvents[i];
      if (canEditMessage(event)) {
        beginEdit(event);
        return;
      }
    }
  }, [beginEdit, canEditMessage, visibleEvents]);

  // Lookup so a reply can render the message it's quoting.
  const eventById = React.useMemo(() => {
    const m = new Map<string, LocalEvent>();
    for (const e of events) m.set(e.event_id, e);
    return m;
  }, [events]);

  React.useEffect(() => {
    if (!draftReply?.event_id) {
      if (restoredDraftReplyIdRef.current && replyTo?.event_id === restoredDraftReplyIdRef.current) {
        restoredDraftReplyIdRef.current = null;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing reply state restored from a draft tombstone.
        setReplyTo(null);
      }
      return;
    }
    if (replyTo?.event_id === draftReply.event_id) return;
    const loaded = eventById.get(draftReply.event_id);
    if (loaded && !loaded.redacted_at) {
      restoredDraftReplyIdRef.current = draftReply.event_id;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted draft reply into RoomView state.
      setReplyTo(loaded);
      return;
    }
    const preview = draftReply.preview || "original message unavailable";
    restoredDraftReplyIdRef.current = draftReply.event_id;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted draft reply into RoomView state.
    setReplyTo({
      event_id: draftReply.event_id,
      room: 0,
      sender_kind: draftReply.sender_kind ?? "system",
      sender_id: null,
      sender_handle: draftReply.sender_handle ?? null,
      type: (draftReply.type as EventType | undefined) ?? "m.text",
      content: { body: preview },
      reply_to_event_id: "",
      is_final: true,
      created_at: "",
      edited_at: null,
      redacted_at: null,
      redaction_reason: "",
    });
  }, [draftReply, eventById, replyTo]);

  const renderedEventIdFor = React.useCallback(
    (eventId: string): string => {
      const ev = eventById.get(eventId);
      const bid = ev && (ev.type === "m.image" || ev.type === "m.file")
        ? (ev.content as { bundle_id?: unknown }).bundle_id
        : null;
      if (typeof bid === "string" && bid) {
        const anchor = events.find(
          (e) =>
            e.type === "m.text" &&
            !e.redacted_at &&
            (e.content as { bundle_id?: unknown }).bundle_id === bid,
        );
        if (anchor) return anchor.event_id;
      }
      return eventId;
    },
    [eventById, events],
  );

  const scrollToRenderedEvent = React.useCallback(
    (eventId: string): boolean => {
      const renderedId = renderedEventIdFor(eventId);
      const node = messageNodeRefs.current.get(renderedId);
      if (!node) return false;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.focus({ preventScroll: true });
      setHighlightedEventId(renderedId);
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedEventId((cur) => (cur === renderedId ? null : cur));
      }, 2300);
      window.setTimeout(() => {
        messageNodeRefs.current.get(renderedId)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 160);
      return true;
    },
    [renderedEventIdFor],
  );

  React.useEffect(() => {
    if (!pendingJumpEventId) return;
    const id = window.requestAnimationFrame(() => {
      if (scrollToRenderedEvent(pendingJumpEventId)) {
        setPendingJumpEventId(null);
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [pendingJumpEventId, scrollToRenderedEvent]);

  React.useEffect(() => {
    return () => {
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const queueJumpToEvent = React.useCallback(
    (eventId: string) => {
      if (search !== null) {
        setSearch(null);
        setSearchResults(null);
        setSearchHasMore(false);
        setSearchLoading(false);
      }
      setPendingJumpEventId(eventId);
    },
    [search],
  );

  const jumpToReplyTarget = React.useCallback(
    async (eventId: string) => {
      const loaded = eventById.get(eventId);
      if (loaded) {
        if (loaded.redacted_at) {
          setReplyJumpState((prev) => ({
            ...prev,
            [eventId]: { status: "error", message: "Original message is no longer available." },
          }));
          return;
        }
        setReplyJumpState((prev) => {
          const next = { ...prev };
          delete next[eventId];
          return next;
        });
        queueJumpToEvent(eventId);
        return;
      }

      if (lookupTargetRef.current) return;
      lookupTargetRef.current = eventId;
      const runId = ++lookupRunRef.current;
      const priorState = replyJumpState[eventId];
      setReplyJumpState((prev) => ({ ...prev, [eventId]: { status: "loading" } }));
      setLoadingOlder(true);
      try {
        let cursor =
          priorState?.status === "continue" && priorState.cursor
            ? priorState.cursor
            : events.find((e) => !e.event_id.startsWith("temp-"))?.event_id;
        let found: Event | null = null;
        const seenCursors = new Set<string>();
        const deadline = Date.now() + 5000;
        let pages = 0;
        while (cursor && pages < 15 && Date.now() < deadline) {
          if (seenCursors.has(cursor)) {
            cursor = undefined;
            break;
          }
          seenCursors.add(cursor);
          const older = await api.events(room.room_id, cursor, PAGE_SIZE);
          if (runId !== lookupRunRef.current) return;
          pages += 1;
          if (older.length === 0) {
            setHasMore(false);
            cursor = undefined;
            break;
          }
          setEvents((prev) => {
            const known = new Set(prev.map((e) => e.event_id));
            const fresh: LocalEvent[] = older
              .filter((e) => !known.has(e.event_id))
              .map((e) => ({
                ...e,
                is_final: true,
                _status: e.sender_handle === myUsername ? ("delivered" as MessageStatus) : undefined,
              }));
            return [...fresh, ...prev];
          });
          found = older.find((e) => e.event_id === eventId) ?? null;
          if (found) break;
          if (older.length < PAGE_SIZE) {
            setHasMore(false);
            cursor = undefined;
            break;
          }
          cursor = older.find((e) => !e.event_id.startsWith("temp-"))?.event_id;
        }

        if (found?.redacted_at) {
          setReplyJumpState((prev) => ({
            ...prev,
            [eventId]: { status: "error", message: "Original message is no longer available." },
          }));
          return;
        }
        if (found) {
          setReplyJumpState((prev) => {
            const next = { ...prev };
            delete next[eventId];
            return next;
          });
          queueJumpToEvent(eventId);
        } else {
          setReplyJumpState((prev) => ({
            ...prev,
            [eventId]: cursor
              ? {
                  status: "continue",
                  cursor,
                  message: "Still looking farther back. Click to continue.",
                }
              : { status: "error", message: "Couldn’t find the original message." },
          }));
        }
      } catch (e) {
        const message =
          e instanceof ApiError && (e.status === 401 || e.status === 403)
            ? "You don’t have access to that message."
            : "Couldn’t find the original message.";
        setReplyJumpState((prev) => ({ ...prev, [eventId]: { status: "error", message } }));
      } finally {
        if (runId === lookupRunRef.current) {
          lookupTargetRef.current = null;
          setLoadingOlder(false);
        }
      }
    },
    [eventById, events, myUsername, queueJumpToEvent, replyJumpState, room.room_id],
  );

  // The studio hands off a flattened annotation set here: reply to the original
  // file message (so the thread + silicon have a clear reference) and stage the
  // draft into the composer for the user to add a message before sending.
  const onAttachAnnotations = React.useCallback(
    (draft: AnnotationDraft) => {
      const src = draft.sourceEventId ? eventById.get(draft.sourceEventId) : undefined;
      if (src) {
        restoredDraftReplyIdRef.current = null;
        setReplyTo(src);
      }
      setPendingAnnotationDraft(draft);
    },
    [eventById],
  );
  const onOpenAnnotation = React.useCallback((request: AnnotationOpenRequest) => {
    setAnnotationSource(request);
  }, []);

  // ----- Optimistic send plumbing -----
  const onOptimisticAdd = React.useCallback(
    (clientId: string, payload: OptimisticPayload) => {
      if (!myUsername) return;
      const now = new Date().toISOString();
      const placeholder: LocalEvent = {
        event_id: TEMP_ID(clientId),
        room: 0,
        sender_kind: "carbon",
        sender_id: null,
        sender_handle: myUsername,
        type: payload.type,
        content: payload.content ?? {},
        reply_to_event_id: payload.reply_to_event_id ?? "",
        is_final: true,
        created_at: now,
        edited_at: payload.edited_at ?? null,
        redacted_at: null,
        redaction_reason: "",
        _status: "pending",
        _clientId: clientId,
      };
      // Persist before React commits so switching chats immediately after send
      // still paints the outgoing message without waiting on the network.
      appendRoomEventSnippet(room.room_id, placeholder);
      setEvents((prev) => {
        // §6b — first message ever in this room: a single mono system note.
        const hadReal = prev.some(
          (e) => !e.event_id.startsWith("temp-") && e.type !== "m.progress" && !e.redacted_at,
        );
        if (!hadReal && !firstContactRef.current) {
          firstContactRef.current = true;
          toast.success("> first contact established");
        }
        return [...prev, placeholder];
      });
      // Surface the outgoing message in the sidebar preview while it's waiting
      // to send / in flight (cleared on ack, marked failed on error).
      setPendingPreview(room.room_id, {
        clientId,
        text: outgoingPreviewText(payload),
        status: "waiting",
      });
      requestBottomStick("smooth");
      // No progress yet — we don't show anything until the message is actually
      // sent (see onAck → showReceipt).
      // Audible "sent" tone — small ascending chirp. Respects reduced-motion
      // + the silicon-interface:sounds=off opt-out.
      playSent();
      vibrate(8); // §3c — feather-light haptic on send
      // Prompt for notification access on the user's first send: an in-app ask
      // first, then (on "enable") the real OS permission prompt. One-time.
      if (shouldPromptNotifications()) {
        markNotificationsAsked();
        toast("get notified when a reply comes in?", {
          description: "we'll ping you even when this tab isn't focused.",
          duration: 10000,
          action: {
            label: "enable",
            onClick: () => {
              void requestBrowserNotifications();
            },
          },
        });
      }
    },
    [myUsername, room.room_id, showsProgressForReplies, requestBottomStick],
  );

  const onAck = React.useCallback((clientId: string, real: Event) => {
    requestBottomStick("smooth");
    // Sent — the sidebar's last_event will reflect it; drop the pending preview.
    clearPendingPreview(room.room_id, clientId);
    appendRoomEventSnippet(room.room_id, {
      ...real,
      _clientId: clientId,
      _status: "sent",
    } as LocalEvent);
    playAckTick(); // §3b — the confirm half of "send → delivered"
    setEvents((prev) => {
      const optIdx = prev.findIndex((e) => e._clientId === clientId);
      const dupIdx = prev.findIndex(
        (e) => e.event_id === real.event_id && e._clientId !== clientId,
      );
      if (optIdx >= 0 && dupIdx < 0) {
        const updated = [...prev];
        // Don't downgrade: the WS echo / read_receipt may have already advanced
        // this row past "sent" before the HTTP ack landed.
        updated[optIdx] = {
          ...real,
          _clientId: clientId,
          _status: bestStatus(prev[optIdx]._status, "sent"),
        };
        return updated;
      }
      if (optIdx >= 0 && dupIdx >= 0) {
        const updated = [...prev];
        const dup = updated[dupIdx];
        updated[dupIdx] = {
          ...dup,
          _clientId: clientId,
          _status: bestStatus(dup._status, "sent"),
        };
        updated.splice(optIdx, 1);
        return updated;
      }
      if (dupIdx >= 0) {
        const updated = [...prev];
        updated[dupIdx] = {
          ...updated[dupIdx],
          _status: bestStatus(updated[dupIdx]._status, "sent"),
        };
        return updated;
      }
      return prev;
    });
    // Message is now actually sent → begin the receipt sequence ("sent" → …).
    if (showsProgressForReplies && PROGRESS_MESSAGE_TYPES.has(real.type)) {
      showReceipt("sent");
    }
  }, [requestBottomStick, showsProgressForReplies, showReceipt, room.room_id]);

  const onOptimisticUpdate = React.useCallback(
    (clientId: string, payload: OptimisticPayload) => {
      updatePendingPreview(room.room_id, clientId, outgoingPreviewText(payload));
      setEvents((prev) =>
        prev.map((e) =>
          e._clientId === clientId
            ? {
                ...e,
                type: payload.type,
                content: payload.content ?? {},
                reply_to_event_id: payload.reply_to_event_id ?? "",
                edited_at: payload.edited_at ?? e.edited_at,
              }
            : e,
        ),
      );
    },
    [room.room_id],
  );

  const onFail = React.useCallback(
    (clientId: string, err: unknown) => {
      setEvents((prev) =>
        prev.map((e) => (e._clientId === clientId ? { ...e, _status: "failed" as MessageStatus } : e)),
      );
      failPendingPreview(room.room_id, clientId);
      setActiveProgress((prev) => (prev?.groupId === `local:${clientId}` ? null : prev));
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
    [room.room_id],
  );

  const heldAckRef = React.useRef(onAck);
  React.useEffect(() => {
    heldAckRef.current = onAck;
  }, [onAck]);

  React.useEffect(() => {
    let cancelled = false;
    const timers = new Set<number>();
    const clientIds = new Map<string, string>();

    const schedule = (heldSendId: string, delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        void recover(heldSendId);
      }, Math.max(0, delay));
      timers.add(timer);
    };

    const recover = async (heldSendId: string) => {
      if (cancelled) return;
      try {
        const latest = await api.heldSends(room.room_id);
        if (cancelled) return;
        const held = latest.held_sends.find((item) => item.held_send_id === heldSendId);
        if (!held) {
          // The hold may already have reached a terminal state while its WS
          // frame was missed. Reconcile the optimistic row from event history.
          const recent = await api.events(room.room_id, undefined, 50);
          const clientId = clientIds.get(heldSendId);
          const sent = clientId
            ? recent.find((event) => event.content.client_id === clientId)
            : undefined;
          if (sent && clientId) heldAckRef.current(clientId, sent);
          return;
        }
        clientIds.set(held.held_send_id, held.client_id);
        applyHeldSendFrame(held);
        if (held.state === "releasing") {
          schedule(heldSendId, 1_000);
          return;
        }
        const remaining = Date.parse(held.release_at) - Date.now();
        if (Number.isFinite(remaining) && remaining > 100) {
          schedule(heldSendId, remaining + 100);
          return;
        }
        const released = await api.sendHeldNow(room.room_id, held.held_send_id);
        if (cancelled) return;
        applyHeldSendFrame(released);
        if (released.state === "sent") {
          // The send-now endpoint returns the hold projection, not the Event.
          // An idempotent event POST retrieves the already-created Event so the
          // optimistic bubble resolves even if its WebSocket echo was missed.
          const event = await api.sendEvent(
            room.room_id,
            {
              type: held.type,
              content: held.content,
              reply_to_event_id: held.reply_to_event_id || undefined,
            },
            held.client_id,
          );
          if (!cancelled) heldAckRef.current(held.client_id, event);
        }
      } catch {
        // The server ETA task + beat sweep remain authoritative. Retry once
        // this room is reopened rather than spinning while offline.
      }
    };

    void api.heldSends(room.room_id).then((res) => {
      if (cancelled) return;
      for (const held of res.held_sends) {
        clientIds.set(held.held_send_id, held.client_id);
        applyHeldSendFrame(held);
        const releaseAt = Date.parse(held.release_at);
        const delay = Number.isFinite(releaseAt) ? releaseAt - Date.now() + 100 : 0;
        schedule(held.held_send_id, delay);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  // applyHeldSendFrame is intentionally omitted; this effect should only refetch
  // server holds when the room changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.room_id]);

  // Tap-to-retry on a failed bubble: re-POST the SAME payload with the SAME
  // client id (the server is idempotent per content.client_id, so a retry of
  // a send that secretly succeeded resolves to the original event). The row
  // flips back to "pending" — and so does the sidebar's pending preview —
  // then the normal ack/fail path takes over. Text retries also clear their
  // outbox entry on success so the background flusher doesn't re-send.
  const retrySend = React.useCallback(
    (ev: Event) => {
      const local = ev as LocalEvent;
      const clientId = local._clientId;
      if (!clientId || local._status !== "failed") return;
      const payload: OptimisticPayload = {
        type: ev.type,
        content: ev.content,
        reply_to_event_id: ev.reply_to_event_id || undefined,
      };
      setEvents((prev) =>
        prev.map((e) =>
          e._clientId === clientId ? { ...e, _status: "pending" as MessageStatus } : e,
        ),
      );
      setPendingPreview(room.room_id, {
        clientId,
        text: outgoingPreviewText(payload),
        status: "waiting",
      });
      api
        .sendEvent(room.room_id, payload, clientId)
        .then((real) => {
          const owner = authStore.getCarbon()?.carbon_id;
          if (owner) ackOutbox(owner, clientId);
          onAck(clientId, real);
        })
        .catch((err) => onFail(clientId, err));
    },
    [room.room_id, onAck, onFail],
  );

  // Empty-room "Say Hi" — sends a plain "hi" using the optimistic send flow.
  const [sayingHi, setSayingHi] = React.useState(false);
  const sayHi = React.useCallback(async () => {
    if (sayingHi) return;
    setSayingHi(true);
    const clientId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c_${Date.now()}`;
    const payload: OptimisticPayload = { type: "m.text", content: { body: "hi" } };
    onOptimisticAdd(clientId, payload);
    try {
      const real = await api.sendEvent(room.room_id, payload, clientId);
      onAck(clientId, real);
    } catch (e) {
      onFail(clientId, e);
    } finally {
      setSayingHi(false);
    }
  }, [sayingHi, onOptimisticAdd, onAck, onFail, room.room_id]);

  const sendPreviewText = React.useCallback(
    async (body: string, options?: { replyToEventId?: string }) => {
      if (readOnly) throw new Error("room is read-only");
      const clientId = newClientId();
      const payload: OptimisticPayload = {
        type: "m.text",
        content: { body },
        reply_to_event_id: options?.replyToEventId,
      };
      onOptimisticAdd(clientId, payload);
      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      if (outboxOwner) {
        enqueueOutbox(outboxOwner, {
          roomId: room.room_id,
          clientId,
          body,
          replyTo: options?.replyToEventId,
          at: Date.now(),
        });
      }
      try {
        const real = await api.sendEvent(room.room_id, payload, clientId);
        if (outboxOwner) ackOutbox(outboxOwner, clientId);
        onAck(clientId, real);
        track.messageSent({ room_id: room.room_id, message_type: "m.text", is_reply: Boolean(options?.replyToEventId) });
      } catch (e) {
        onFail(clientId, e);
        throw e;
      }
    },
    [onAck, onFail, onOptimisticAdd, readOnly, room.room_id],
  );

  const roomSendValue = React.useMemo(
    () => ({ roomId: room.room_id, readOnly, sendText: sendPreviewText }),
    [readOnly, room.room_id, sendPreviewText],
  );

  // ----- Drag-and-drop a file onto the chat surface -----
  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setIsDropTarget(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    // We get bogus dragleave events as the cursor crosses child elements.
    // Filter to the actual exit by checking relatedTarget.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDropTarget(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setIsDropTarget(false);
    setDroppedFile(e.dataTransfer.files[0]);
  };

  // ----- Search filter -----
  const filteredEvents = React.useMemo(() => {
    // No active query (closed, or open-but-empty) → the normal loaded window.
    if (!search?.trim()) return visibleEvents;
    // Active query → server search results across the whole history, sorted
    // chronologically so the timeline (day bands, grouping) reads top→bottom.
    return ([...(searchResults ?? [])] as LocalEvent[]).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
  }, [visibleEvents, search, searchResults]);

  // Fire the backend search (debounced) whenever the query changes.
  React.useEffect(() => {
    const q = search?.trim() ?? "";
    if (!q) {
      setSearchResults(null);
      setSearchHasMore(false);
      setSearchLoading(false);
      searchBlockRef.current = 0;
      return;
    }
    let alive = true;
    setSearchLoading(true);
    const t = window.setTimeout(() => {
      searchBlockRef.current = 0;
      api
        .search({ q, room: room.room_id, block: 0, interval: SEARCH_INTERVAL })
        .then((r) => {
          if (!alive) return;
          setSearchResults(r.results);
          setSearchHasMore(r.has_more);
        })
        .catch(() => {
          if (alive) {
            setSearchResults([]);
            setSearchHasMore(false);
          }
        })
        .finally(() => {
          if (alive) setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [search, room.room_id]);

  // Page in the next block of search hits.
  const loadMoreSearch = React.useCallback(async () => {
    const q = search?.trim() ?? "";
    if (!q || searchLoading || !searchHasMore) return;
    setSearchLoading(true);
    try {
      const next = searchBlockRef.current + 1;
      const r = await api.search({ q, room: room.room_id, block: next, interval: SEARCH_INTERVAL });
      searchBlockRef.current = next;
      setSearchResults((prev) => {
        const seen = new Set((prev ?? []).map((e) => e.event_id));
        const merged = [...(prev ?? [])];
        for (const e of r.results) if (!seen.has(e.event_id)) merged.push(e);
        return merged;
      });
      setSearchHasMore(r.has_more);
    } catch {
      /* leave existing results in place */
    } finally {
      setSearchLoading(false);
    }
  }, [search, room.room_id, searchLoading, searchHasMore]);
  // §2 — collapse attachment+text bundles: attachments sharing a `bundle_id`
  // with a text message are pinned onto that bubble instead of rendered as their
  // own rows. `displayRows` is the timeline minus those folded-in attachments;
  // `pinsByKey` maps the text bubble's render key to its attachment events.
  const { displayRows, pinsByKey } = React.useMemo(() => {
    const keyOf = (e: Event) => (e as LocalEvent)._clientId ?? e.event_id;
    const bundles = new Map<string, { text?: Event; atts: Event[] }>();
    for (const e of filteredEvents) {
      const bid = (e.content as { bundle_id?: unknown }).bundle_id;
      if (typeof bid !== "string" || !bid) continue;
      const b = bundles.get(bid) ?? { atts: [] as Event[] };
      if (e.type === "m.text") b.text = e;
      else if (e.type === "m.image" || e.type === "m.file") b.atts.push(e);
      bundles.set(bid, b);
    }
    const skip = new Set<Event>();
    const pins = new Map<string, Event[]>();
    for (const b of bundles.values()) {
      if (b.text && b.atts.length) {
        for (const a of b.atts) skip.add(a);
        pins.set(keyOf(b.text), b.atts);
      }
    }
    return {
      displayRows: skip.size ? filteredEvents.filter((e) => !skip.has(e)) : filteredEvents,
      pinsByKey: pins,
    };
  }, [filteredEvents]);
  const cancelLatestHeld = React.useCallback(() => {
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const event = visibleEvents[i] as LocalEvent;
      if (!isMyEvent(event, myUsername)) continue;
      if (!event.event_id.startsWith("temp-") || !event._clientId) continue;
      onSelfDelete(event, pinsByKey.get(event._clientId ?? event.event_id) ?? []);
      return;
    }
  }, [myUsername, pinsByKey, visibleEvents]);
  const latestVisibleEvent = visibleEvents[visibleEvents.length - 1] ?? null;
  const latestVisibleEventId = latestVisibleEvent?.event_id ?? null;
  // Show the progress line whenever there's active progress for this room. We
  // no longer suppress it just because the latest visible event is from a
  // silicon: progress is cleared the moment a real message lands (both locally
  // and in the page-level cache), so a lingering entry genuinely means work is
  // still in flight — including inter-silicon chats where every message is a
  // silicon, and multi-step tasks that post then keep working.
  const shouldShowActiveProgress = !search && activeProgress?.roomId === room.room_id;
  const progressAvatarHandle = React.useMemo(() => {
    // §1.6 — prefer the handle the progress frame actually attributed the work
    // to, instead of guessing "most recent silicon sender".
    if (activeProgress?.handle) return activeProgress.handle;
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const event = visibleEvents[i];
      if (event.sender_kind === "silicon" && event.sender_handle) return event.sender_handle;
    }
    if (peer?.kind === "silicon") return peer.handle;
    return headerSeed;
  }, [activeProgress, visibleEvents, peer, headerSeed]);
  // §1.1 — how long since the progress line last advanced.
  const progressStaleMs = activeProgress ? progressNow - activeProgress.updatedAt : 0;
  const progressAvatarSrc = React.useMemo(() => {
    if (!progressAvatarHandle) return headerPhoto;
    return photoFor("silicon", progressAvatarHandle) ?? headerPhoto;
  }, [progressAvatarHandle, photoFor, headerPhoto]);

  // §1 — anchor the active run's status to the message that started it. A
  // message's key (_clientId/event_id) is stable across the optimistic→server
  // swap, so identity beats timestamps here (wall-clock skew put the status
  // above the latest message). Record the newest message's key when a run
  // begins.
  const lastRowKey = displayRows.length
    ? ((displayRows[displayRows.length - 1] as LocalEvent)._clientId ??
        displayRows[displayRows.length - 1].event_id)
    : null;
  const lastRowKeyRef = React.useRef<string | null>(lastRowKey);
  lastRowKeyRef.current = lastRowKey;
  const [runAnchorKey, setRunAnchorKey] = React.useState<string | null>(null);
  // Capture the anchor ONCE, on the rising edge of "a run is active" — the
  // message that was latest when the silicon began working. Messages sent while
  // the run stays active must NOT move the anchor (a later message just creates
  // a new progress group-id); they fall below the status as a fresh turn.
  const runActiveNow = !search && shouldShowActiveProgress && !holdingMessage;
  React.useEffect(() => {
    if (!runActiveNow) {
      setRunAnchorKey(null);
      return;
    }
    setRunAnchorKey((prev) => prev ?? lastRowKeyRef.current);
  }, [runActiveNow]);

  // The active run's server-stamped anchor (the carbon message it's working on),
  // when present — preferred over the client rising-edge guess.
  const activeAnchorId = activeProgress?.anchorEventId ?? null;

  // §1 — fold the flat timeline into "turn" groups, and place each silicon run
  // (its reply + working status) under the carbon message that triggered it.
  const timelineItems = React.useMemo(() => {
    type Party = "carbon" | "silicon";
    type Row = (typeof displayRows)[number];
    type Item =
      | { kind: "panel"; party: Party; events: Row[]; key: string; dayLabel: string | null }
      | { kind: "system"; event: Row; key: string; dayLabel: string | null }
      | { kind: "progress"; key: string; dayLabel: string | null };
    const keyOf = (e: Row) => (e as LocalEvent)._clientId ?? e.event_id;
    const isSystem = (e: Row) => e.type === "m.system" || e.type === "m.session_marker";
    const partyOf = (e: Row): Party => (e.sender_kind === "silicon" ? "silicon" : "carbon");
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    };

    // §run-grouping — move each silicon reply that carries a run_anchor_event_id
    // to sit right after the carbon message it answers, so a reply lands under
    // its question even when newer messages were sent during the run. (No
    // anchors → unchanged chronological order.)
    const present = new Set(displayRows.map((e) => e.event_id));
    const repliesByAnchor = new Map<string, Row[]>();
    const moved = new Set<Row>();
    for (const e of displayRows) {
      const anchor = e.run_anchor_event_id;
      if (e.sender_kind === "silicon" && anchor && present.has(anchor)) {
        const list = repliesByAnchor.get(anchor) ?? [];
        list.push(e);
        repliesByAnchor.set(anchor, list);
        moved.add(e);
      }
    }
    let rows: Row[] = displayRows;
    if (moved.size) {
      rows = [];
      for (const e of displayRows) {
        if (moved.has(e)) continue;
        rows.push(e);
        const replies = repliesByAnchor.get(e.event_id);
        if (replies) rows.push(...replies);
      }
    }

    const runActiveRaw = !search && shouldShowActiveProgress && !holdingMessage;
    let lastReal: Row | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isSystem(rows[i])) {
        lastReal = rows[i];
        break;
      }
    }
    // Prefer the server anchor; fall back to the client rising-edge anchor when
    // the backend doesn't stamp one (older server, or a cron/proactive run).
    const useServerAnchor = !!activeAnchorId && present.has(activeAnchorId);
    let runActive: boolean;
    if (useServerAnchor) {
      // Show the status until a reply for this run lands (an anchored reply).
      runActive = runActiveRaw && !repliesByAnchor.has(activeAnchorId);
    } else {
      const anchorIdx =
        runActiveRaw && runAnchorKey ? rows.findIndex((e) => keyOf(e) === runAnchorKey) : -1;
      const repliedAfterAnchor =
        anchorIdx >= 0 && rows.slice(anchorIdx + 1).some((e) => e.sender_kind === "silicon");
      runActive =
        runActiveRaw &&
        (room.observed ? !repliedAfterAnchor : lastReal?.sender_kind !== "silicon");
    }

    const raw: Array<{ item: Item; iso: string }> = [];
    let cur: { party: Party; events: Row[] } | null = null;
    let progressPlaced = false;
    let lastIso = rows.length ? rows[0].created_at : new Date(0).toISOString();
    const flush = () => {
      if (cur && cur.events.length) {
        raw.push({
          item: {
            kind: "panel",
            party: cur.party,
            events: cur.events,
            key: keyOf(cur.events[0]),
            dayLabel: null,
          },
          iso: cur.events[0].created_at,
        });
      }
      cur = null;
    };
    const pushProgress = (iso: string) => {
      flush();
      raw.push({ item: { kind: "progress", key: "run-progress", dayLabel: null }, iso });
      progressPlaced = true;
    };
    for (const e of rows) {
      lastIso = e.created_at;
      if (isSystem(e)) {
        flush();
        raw.push({ item: { kind: "system", event: e, key: keyOf(e), dayLabel: null }, iso: e.created_at });
      } else {
        const p = partyOf(e);
        if (!cur || cur.party !== p) {
          flush();
          cur = { party: p, events: [] };
        }
        cur.events.push(e);
      }
      // Insert the run status right after the carbon message it's answering —
      // but ONLY when the server told us which one (run_anchor_event_id). With
      // no server anchor (cron/proactive, or a run with no unanswered carbon),
      // the client rising-edge guess lands mid-list after reply reordering, so
      // we let it fall through to the bottom instead.
      if (runActive && !progressPlaced && useServerAnchor && e.event_id === activeAnchorId) {
        pushProgress(e.created_at);
      }
    }
    flush();
    // No server anchor (or it's out of the loaded window) → pin to the bottom.
    if (runActive && !progressPlaced) pushProgress(lastIso);
    // Day band before the first item of each new local calendar day.
    let prevDay: string | null = null;
    for (const r of raw) {
      const d = dayKey(r.iso);
      if (d !== prevDay) {
        r.item.dayLabel = dayLabel(r.iso);
        prevDay = d;
      }
    }
    return raw.map((r) => r.item);
  }, [
    displayRows,
    search,
    shouldShowActiveProgress,
    holdingMessage,
    runAnchorKey,
    room.observed,
    activeAnchorId,
  ]);

  // Keep the viewport pinned to the bottom across content changes when the user
  // is parked there. Native scroll-anchoring handles content ABOVE the viewport
  // (images loading, older history prepended) — but appending below it doesn't
  // move the anchor, so we explicitly stick to the bottom for new messages /
  // progress. Runs as a layout effect so there's no flash before the scroll.
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Older history was just prepended → keep the same content under the
    // viewport (new height was added above, so shift scrollTop by the delta).
    const p = pendingPrependRef.current;
    if (p) {
      pendingPrependRef.current = null;
      el.scrollTop = el.scrollHeight - p.height + p.top;
      return;
    }
    // Otherwise, if parked at the bottom, follow new messages / progress.
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [timelineItems]);

  // Land at the bottom once per room, after the server load settles, then a few
  // re-snaps as late content (images / pdf thumbs) grows the layout.
  const didInitialBottomRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!hydrated || timelineItems.length === 0) return;
    if (didInitialBottomRef.current === room.room_id) return;
    didInitialBottomRef.current = room.room_id;
    stickToBottomRef.current = true;
    const jump = () => {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(jump));
    const timers = [80, 250, 600].map((ms) => window.setTimeout(jump, ms));
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [room.room_id, hydrated, timelineItems.length]);

  const openSenderProfile = React.useCallback(
    (sender: { kind: "carbon" | "silicon"; handle: string }) => {
      setFocusSender(sender);
      setProfileOpen(true);
    },
    [],
  );

  const focusedDirectRoom = React.useMemo(() => {
    if (!focusSender) return null;
    return (
      allRooms.find(
        (candidate) =>
          candidate.kind === "direct" &&
          candidate.peers.some(
            (candidatePeer) =>
              candidatePeer.kind === focusSender.kind &&
              (candidatePeer.id === focusSender.handle ||
                candidatePeer.handle === focusSender.handle),
          ),
      ) ?? null
    );
  }, [allRooms, focusSender]);

  const openDirectMessage = React.useCallback(
    async (target: { kind: "carbon" | "silicon"; handle: string }) => {
      const existing = allRooms.find(
        (candidate) =>
          candidate.kind === "direct" &&
          candidate.peers.some(
            (candidatePeer) =>
              candidatePeer.kind === target.kind &&
              (candidatePeer.id === target.handle || candidatePeer.handle === target.handle),
          ),
      );
      const destination = existing ?? (await api.directRoom(target.kind, target.handle));
      setProfileOpen(false);
      setFocusSender(null);
      router.push(`/chat?room=${encodeURIComponent(destination.room_id)}`);
    },
    [allRooms, router],
  );

  // §2.7 — load the previous page of history (the API supports a `before`
  // cursor). Prepends older events; Virtuoso's firstItemIndex keeps the
  // viewport anchored (see the prepend effect above).
  const loadOlder = React.useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    const oldest = events.find((e) => !e.event_id.startsWith("temp-"));
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const { events: older, hasMore: olderHasMore } = await loadTimelineWindow(
        room.room_id,
        oldest.event_id,
      );
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      // Snapshot scroll metrics right before the prepend so the layout effect
      // can restore the exact viewport (older messages add height ABOVE).
      const el = scrollerRef.current;
      pendingPrependRef.current = el
        ? { height: el.scrollHeight, top: el.scrollTop }
        : null;
      setEvents((prev) => {
        const known = new Set(prev.map((e) => e.event_id));
        const fresh: LocalEvent[] = older
          .filter((e) => !known.has(e.event_id))
          // Loaded history is complete — mark final (matches the initial load).
          .map((e) => ({
            ...e,
            is_final: true,
            _status: e.sender_handle === myUsername ? ("delivered" as MessageStatus) : undefined,
          }));
        return [...fresh, ...prev];
      });
      setHasMore(olderHasMore);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMore, events, room.room_id, myUsername]);

  // One timeline item's content (day band + body). Shared by the virtualized
  // main list (Virtuoso itemContent) and the non-virtualized search list.
  type TimelineRow = (typeof timelineItems)[number];
  const renderTimelineItem = (item: TimelineRow): React.ReactNode => {
    const dayBand = item.dayLabel ? (
      <div className="py-1 text-center text-[10px] text-muted-foreground">{item.dayLabel}</div>
    ) : null;
    if (item.kind === "system") {
      return (
        <>
          {dayBand}
          <MessageBubble
            event={item.event}
            isMine={isMyEvent(item.event, myUsername)}
            myHandle={myUsername}
            isDirect={room.kind === "direct"}
            mentionTargets={mentionCandidates}
            onMentionClick={openSenderProfile}
            roomId={room.room_id}
            onAttachAnnotations={readOnly ? undefined : onAttachAnnotations}
            onOpenAnnotation={readOnly ? undefined : onOpenAnnotation}
          />
        </>
      );
    }
    if (item.kind === "progress") {
      if (!activeProgress) return dayBand;
      return (
        <>
          {dayBand}
          <div className="my-3">
            <ProgressLine
              entry={activeProgress}
              avatarSeed={progressAvatarHandle || headerSeed}
              avatarSrc={progressAvatarSrc}
              avatarFamily={peer?.kind === "silicon" ? "silicon" : "carbon"}
              staleMs={progressStaleMs}
              onDismiss={() => {
                clearRoomProgress(room.room_id);
                setActiveProgress(null);
              }}
            />
          </div>
        </>
      );
    }
    // A turn: consecutive messages from one party, separated by spacing.
    return (
      <>
        {dayBand}
        <div className="my-3">
          {item.events.map((e, j) => {
            const prev = item.events[j - 1];
            const next = item.events[j + 1];
            const sameAs = (a?: LocalEvent | Event) =>
              !!a &&
              a.sender_handle === e.sender_handle &&
              a.created_at.slice(0, 16) === e.created_at.slice(0, 16);
            const renderedId = e.event_id;
            return (
              <div
                key={e._clientId ?? e.event_id}
                ref={(node) => {
                  if (node) messageNodeRefs.current.set(renderedId, node);
                  else messageNodeRefs.current.delete(renderedId);
                }}
                data-event-id={renderedId}
                tabIndex={-1}
                className={cn(
                  "scroll-mt-24 rounded-sm transition-[background-color,box-shadow] duration-300 focus:outline-none",
                  highlightedEventId === renderedId && "bg-primary/5 ring-2 ring-primary/40",
                )}
              >
                <MessageBubble
                  event={e}
                  isMine={isMyEvent(e, myUsername)}
                  myHandle={myUsername}
                  roomId={room.room_id}
                  onAttachAnnotations={readOnly ? undefined : onAttachAnnotations}
                  onOpenAnnotation={readOnly ? undefined : onOpenAnnotation}
                  replyToEvent={e.reply_to_event_id ? eventById.get(e.reply_to_event_id) : undefined}
                  onJumpToEvent={jumpToReplyTarget}
                  replyJumpState={e.reply_to_event_id ? replyJumpState[e.reply_to_event_id] : undefined}
                  isDirect={room.kind === "direct"}
                  status={e._status}
                  senderPhotoUrl={photoFor(e.sender_kind, e.sender_handle)}
                  senderAsciiUrl={asciiFor(e.sender_kind, e.sender_handle)}
                  senderAvatarKind={e.sender_kind}
                  senderDisplayName={displayNameFor(e.sender_kind, e.sender_handle)}
                  onSenderClick={openSenderProfile}
                  onTakeBack={readOnly ? undefined : onTakeBack}
                  showSender={!sameAs(prev)}
                  showTime={!sameAs(next)}
                  reactions={reactionsByTarget.get(e.event_id) ?? undefined}
                  onReply={readOnly ? undefined : onReply}
                  onReact={readOnly ? undefined : onReact}
                  onForward={readOnly ? undefined : onForward}
                  onSelect={readOnly ? undefined : onSelect}
                  onEdit={readOnly || !canEditMessage(e) ? undefined : beginEdit}
                  selectMode={selectMode}
                  selected={selectedEventIds.has(e.event_id)}
                  onToggleSelect={readOnly ? undefined : toggleSelect}
                  onRetry={readOnly ? undefined : retrySend}
                  onDelete={
                    readOnly || !canUnsendMessage(e)
                      ? undefined
                      : (target) =>
                          onSelfDelete(target, pinsByKey.get(e._clientId ?? e.event_id) ?? [])
                  }
                  pinnedAttachments={pinsByKey.get(e._clientId ?? e.event_id)}
                  mentionTargets={mentionCandidates}
                  onMentionClick={openSenderProfile}
                />
              </div>
            );
          })}
        </div>
      </>
    );
  };

  // The composer's "holding…" pre-send state — rendered in the Virtuoso footer.
  const holdingLabel =
    editingEvent?.event_id.startsWith("temp-")
      ? "holding this message until you finish editing."
      : "holding the message until you finish typing.";
  const holdingNode = holdingMessage ? (
    <div className="my-2 flex w-full items-center justify-start gap-2">
      <div className="w-7 shrink-0">
        <IdAvatar
          seed={progressAvatarHandle || headerSeed}
          src={progressAvatarSrc}
          size={28}
          family={peer?.kind === "silicon" ? "silicon" : "carbon"}
        />
      </div>
      <span className="text-sm text-muted-foreground">
        {holdingLabel}
      </span>
    </div>
  ) : null;

  const searching = !!search?.trim();
  const crossChatRecordingBanner = showRecordingBanner && recordingRoomId ? (
    <button
      type="button"
      aria-live="polite"
      onClick={() => router.push(`/chat?room=${encodeURIComponent(recordingRoomId)}`)}
      className="flex w-full items-center justify-center gap-2 border-t border-input bg-card px-4 py-2 text-xs text-foreground transition-colors hover:bg-accent"
    >
      <Microphone className="h-3.5 w-3.5 animate-pulse" />
      <span>
        voice note is being recorded in <strong>{recordingOriginName}</strong>
      </span>
      <span className="text-muted-foreground">· return</span>
    </button>
  ) : null;

  return (
    <RoomSendProvider value={roomSendValue}>
      {/* `min-h-0` is the key — without it, a flex child grows to its content's
          intrinsic height, the chat list overflows the viewport, and the
          sidebar/composer get pushed down. With min-h-0 the section participates
          in flex sizing properly and only the inner ScrollArea scrolls. */}
      <section
      ref={sectionRef}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      {/* Header — clicking anywhere on the left side opens the profile. */}
      {/* Header — fixed height so clicking search doesn't shift the row when
          the search field swaps in for the icon button. */}
      <header className="group/header relative z-10 flex h-[68px] items-center gap-3 border-b bg-elevated pl-6 pr-6 shadow-[0_2px_12px_-6px_rgba(60,50,36,0.14)]">
        <button
          type="button"
          onClick={() => {
            setFocusSender(null);
            setProfileOpen(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-left transition-opacity hover:opacity-80"
          title="view profile & attachments"
        >
          <IdAvatar seed={headerSeed} src={headerPhoto} asciiSrc={headerAscii} size={36} family={peer?.kind ?? "carbon"} />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">
              {headerTitle ?? (
                <>
                  <span className="opacity-60">@</span>
                  {peer?.id}
                </>
              )}
            </h2>
            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              {readOnly && <Eye className="h-3 w-3 shrink-0" />}
              {readOnly
                ? "observing · read-only"
                : (formatActivities(activities) ?? display.subtitle)}
            </p>
          </div>
        </button>
        {/* Save Contact — only for unsaved 1-on-1 peers, left of search. */}
        {peer && !contact && (
          <Button
            size="sm"
            onClick={() => setSaveOpen(true)}
            className="shrink-0 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            title="save contact"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Save Contact
          </Button>
        )}
        {peer && contact && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSaveOpen(true)}
            className="shrink-0 gap-1.5 opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
            title="edit saved contact"
          >
            <NotePencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
        {/* Crons — only in a 1-on-1 silicon chat, left of search. */}
        {peer?.kind === "silicon" && search === null && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setCronOpen(true)}
            aria-label="view crons"
            title="crons this silicon set for you"
          >
            <Clock />
          </Button>
        )}
        {search === null ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setSearch("")}
            aria-label="search messages"
            title="search messages"
          >
            <MagnifyingGlass />
          </Button>
        ) : (
          <SearchBar value={search} onChange={setSearch} onClose={() => setSearch(null)} />
        )}
      </header>

      {peer?.kind === "silicon" && (
        <CronDrawer
          siliconId={peer.id}
          siliconName={contact?.name ?? peer.name}
          open={cronOpen}
          onOpenChange={setCronOpen}
        />
      )}

      {peer && (
        <SaveContactDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          peer={peer}
          existing={contact}
          onSaved={() => onContactsChanged?.()}
        />
      )}

      <ProfileDrawer
        room={room}
        events={events}
        currentUsername={carbon?.username}
        contact={
          focusSender
            ? contactForSender(focusSender.kind, focusSender.handle)
            : contact
        }
        onEditContact={!focusSender && peer ? () => setSaveOpen(true) : undefined}
        open={profileOpen}
        onOpenChange={(v) => {
          setProfileOpen(v);
          if (!v) setFocusSender(null);
        }}
        focusSender={focusSender}
        contentRoomId={focusSender ? focusedDirectRoom?.room_id ?? null : room.room_id}
        onMessage={focusSender || peer ? openDirectMessage : undefined}
      />

      {/* data-private masks all message text out of PostHog session replays
          (see instrumentation-client.ts maskTextSelector). */}
      {searching ? (
        // Search results are a small, bounded set — a plain scroll area is fine
        // (no virtualization needed).
        <ScrollArea ref={scrollRootRef} className="flex-1" data-private>
          <div className="w-full px-6 py-4">
            {searchHasMore && filteredEvents.length > 0 ? (
              <div className="flex justify-center pb-3">
                <button
                  type="button"
                  onClick={loadMoreSearch}
                  disabled={searchLoading}
                  className="label-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                >
                  {searchLoading ? "searching…" : "more results"}
                </button>
              </div>
            ) : null}
            {searchLoading && filteredEvents.length === 0 ? (
              <div className="border bg-muted/40 p-6 text-sm text-muted-foreground">
                <span className="font-mono">
                  searching <span className="text-foreground">&quot;{search?.trim()}&quot;</span>…
                </span>
              </div>
            ) : filteredEvents.length === 0 ? (
              <div className="border bg-muted/40 p-6 text-sm text-muted-foreground">
                <span className="font-mono">
                  no events match <span className="text-foreground">&quot;{search}&quot;</span>
                </span>
              </div>
            ) : (
              timelineItems.map((item) => (
                <React.Fragment key={item.key}>{renderTimelineItem(item)}</React.Fragment>
              ))
            )}
          </div>
        </ScrollArea>
      ) : loading && filteredEvents.length === 0 ? (
        <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">loading messages…</div>
      ) : filteredEvents.length === 0 ? (
        <div className="flex-1 px-6 py-4">
          {/* §2b — first-contact prompt with a one-click Say Hi. */}
          <div className="border bg-muted/40 p-6 text-sm text-muted-foreground">
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <span>no messages yet - say hi.</span>
              {!readOnly ? (
                <Button size="sm" onClick={sayHi} disabled={sayingHi}>
                  {sayingHi ? "saying hi…" : "Say Hi"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        // Virtualized main timeline — only the visible rows are in the DOM, so it
        // scales to very long histories. Virtuoso handles dynamic heights,
        // stick-to-bottom (followOutput), and prepend anchoring (firstItemIndex).
        // Plain scroll container — native scroll-anchoring (overflowAnchor)
        // keeps the viewport steady when content above loads or is prepended,
        // so nothing shifts and there are no virtualization blank-flashes.
        <div
          key={room.room_id}
          ref={scrollerRef}
          data-private
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:auto]"
          onScroll={() => {
            const el = scrollerRef.current;
            if (!el) return;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            stickToBottomRef.current = atBottom;
            if (atBottom) setUnseenBelow(false);
            // Prefetch older history a buffer BEFORE the top, so the prepend
            // lands while there's still content above to anchor against.
            if (el.scrollTop < 600 && hasMore && !loadingOlder) void loadOlder();
          }}
        >
          <ChatListHeader loadingOlder={loadingOlder} />
          {timelineItems.map((item) => (
            <div key={item.key} className="px-6" style={{ display: "flow-root" }}>
              {renderTimelineItem(item)}
            </div>
          ))}
          {holdingNode ? <div className="px-6">{holdingNode}</div> : null}
          <div className="h-4" />
        </div>
      )}

      {/* §1.9 — when a message arrives while scrolled up, surface a pill to
          jump back to the latest instead of silently appending below the fold. */}
      {unseenBelow && !readOnly ? (
        <button
          type="button"
          onClick={() => {
            setUnseenBelow(false);
            requestBottomStick("smooth");
          }}
          className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 border border-foreground bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-none transition-opacity hover:opacity-90"
        >
          ↓ new messages
        </button>
      ) : null}

      {selectMode && voiceSession.phase === "idle" ? (
        // Dope #79 — selection action bar, shown in place of the composer while
        // multi-selecting. readOnly rooms never enter select-mode (no onSelect).
        <div className="flex items-center justify-between gap-2 border-t bg-background px-4 py-3">
          <span className="label-mono text-[10px] text-muted-foreground">
            {selectedEventIds.size} selected
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={cancelSelect}>
              cancel
            </Button>
            <Button
              onClick={() => setForwardSelection(true)}
              disabled={selectedEventIds.size === 0}
            >
              forward
            </Button>
          </div>
        </div>
      ) : readOnly && voiceSession.phase === "idle" ? (
        <div className="flex items-center justify-center gap-2 border-t bg-muted/40 px-6 py-4 text-xs text-muted-foreground">
          <Eye className="h-3.5 w-3.5" />
          You&rsquo;re observing this silicon-to-silicon conversation. It&rsquo;s
          read-only - you can&rsquo;t send messages here.
        </div>
      ) : readOnly ? (
        <>
          {crossChatRecordingBanner}
          <div className="border-t bg-background p-3">
            <VoiceRecorder />
          </div>
        </>
      ) : (
        <>
          {siliconUnavailable && (
            <div className="flex items-center justify-center gap-2 border-t border-input bg-muted/40 px-6 py-3 text-xs text-muted-foreground">
              <WarningCircle className="h-3.5 w-3.5 text-destructive" />
              <span>
                This silicon is not available right now. Don&rsquo;t worry, the message you write
                here will be saved in draft.
              </span>
            </div>
          )}
          {crossChatRecordingBanner}
          <Composer
            roomId={room.room_id}
            onOptimisticAdd={onOptimisticAdd}
            onAck={onAck}
            onFail={onFail}
            onOptimisticUpdate={onOptimisticUpdate}
            droppedFile={droppedFile}
            onDroppedFileConsumed={() => setDroppedFile(null)}
            pendingAnnotationDraft={pendingAnnotationDraft}
            onAnnotationDraftConsumed={() => setPendingAnnotationDraft(null)}
            replyTo={replyTo}
            onClearReply={() => {
              restoredDraftReplyIdRef.current = null;
              setReplyTo(null);
            }}
            delayTextForSilicon={room.kind === "direct" && peer?.kind === "silicon"}
            onHoldStateChange={setHoldingMessage}
            cancelQueuedRef={cancelQueuedRef}
            clearHeldClientRef={clearHeldClientRef}
            mentionCandidates={mentionCandidates}
            editingEvent={editingEvent}
            onEditComplete={() => setEditingEvent(null)}
            onPersistedEdit={persistEdit}
            onRequestEditLast={requestEditLast}
            restoreDraft={restoreDraft}
            onRestoreDraftConsumed={() => setRestoreDraft(null)}
            onCancelHeldLast={cancelLatestHeld}
            sendDisabled={siliconUnavailable}
            sendDisabledReason="This silicon is not available right now."
          />
        </>
      )}

      {/* Visual hint while a file is hovering over the chat surface. */}
      <DropOverlay visible={isDropTarget} />

      {annotationSource && (
        <AnnotationStudio
          open
          onOpenChange={(open) => {
            if (!open) setAnnotationSource(null);
          }}
          url={annotationSource.url}
          mime={annotationSource.mime}
          filename={annotationSource.filename}
          roomId={annotationSource.roomId}
          sourceMediaId={annotationSource.sourceMediaId}
          sourceEventId={annotationSource.sourceEventId}
          onAttach={annotationSource.onAttach}
        />
      )}

      <ForwardDialog
        open={!!forwardingEvent || forwardSelection}
        onOpenChange={(v) => {
          if (!v) {
            setForwardingEvent(null);
            setForwardSelection(false);
          }
        }}
        event={forwardingEvent}
        events={forwardSelection ? selectedEvents : undefined}
        rooms={allRooms}
        sourceRoomId={room.room_id}
        // On full success from the multi-select flow, drop out of select-mode.
        onComplete={cancelSelect}
      />

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsend message?</DialogTitle>
            <DialogDescription>
              This removes it for everyone and brings it back to your composer.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              cancel
            </Button>
            <Button
              onClick={confirmDelete}
              variant="destructive"
            >
              unsend
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </section>
    </RoomSendProvider>
  );
}

function ProgressLine({
  entry,
  avatarSeed,
  avatarSrc,
  avatarFamily,
  staleMs = 0,
  onDismiss,
}: {
  entry: ProgressEntry;
  avatarSeed: string;
  avatarSrc?: string | null;
  avatarFamily?: "carbon" | "silicon";
  staleMs?: number;
  onDismiss?: () => void;
}) {
  // Receipt phase: "message sent" / "message read" before the actual work
  // progress kicks in. Rendered with the same activity-line markup as the live
  // progress line (mono uppercase copy + the pixel core) so it shares the
  // "WORKING" styling and transitions seamlessly into real progress.
  if (entry.receipt) {
    const read = entry.receipt === "read";
    return (
      <div className="my-2 flex w-full items-center justify-start gap-2">
        <div className="w-7 shrink-0">
          <IdAvatar seed={avatarSeed || "?"} src={avatarSrc} size={28} family={avatarFamily ?? "silicon"} />
        </div>
        <div className="min-w-0 max-w-[70%]">
          <span className="silicon-activity-line flex min-h-7 items-center text-sm">
            <span className="inline-flex min-w-0 max-w-full items-center gap-3 overflow-hidden">
              <span className="silicon-activity-copy">
                {read ? "message read" : "message sent"}
              </span>
              <span className="silicon-activity-core" aria-hidden="true">
                {Array.from({ length: 16 }, (_, i) => (
                  <span key={i} />
                ))}
              </span>
            </span>
          </span>
        </div>
      </div>
    );
  }
  // §1.1 — keep the last live line going while the silicon might still be
  // working (no "no update for Ns" countdown). Only after a long silence do we
  // collapse to a quiet "Still working…" with a dismiss, in case it died with no
  // `done` frame.
  const dead = staleMs >= PROGRESS_STALE_HARD_MS;
  if (dead) {
    return (
      <div className="my-2 flex w-full items-start gap-2">
        <div className="w-7 shrink-0">
          <IdAvatar seed={avatarSeed || "?"} src={avatarSrc} size={28} family={avatarFamily ?? "carbon"} />
        </div>
        <div className="min-w-0 max-w-[70%] space-y-1">
          <span className="block text-sm text-muted-foreground">Still working…</span>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="label-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              dismiss
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return <ProgressLineLive entry={entry} avatarSeed={avatarSeed} avatarSrc={avatarSrc} avatarFamily={avatarFamily} />;
}

function ProgressLineLive({
  entry,
  avatarSeed,
  avatarSrc,
  avatarFamily,
}: {
  entry: ProgressEntry;
  avatarSeed: string;
  avatarSrc?: string | null;
  avatarFamily?: "carbon" | "silicon";
}) {
  const initialTickRef = React.useRef<number | null>(null);
  if (initialTickRef.current === null) {
    initialTickRef.current = randomProgressTick(progressLineOptions(entry).length, -1);
  }
  const [tick, setTick] = React.useState(initialTickRef.current);
  const [typed, setTyped] = React.useState("");
  const typedRef = React.useRef("");
  const pendingTargetRef = React.useRef<string | null>(null);
  const [target, setTarget] = React.useState(() => formatProgressLine(entry, initialTickRef.current ?? 0));
  const targetRef = React.useRef(target);
  const [phase, setPhase] = React.useState<"typing" | "holding" | "erasing">("typing");
  const holdMsRef = React.useRef(6500);
  const typedDoneAtRef = React.useRef(0);

  React.useEffect(() => {
    typedRef.current = typed;
  }, [typed]);

  React.useEffect(() => {
    targetRef.current = target;
  }, [target]);

  React.useEffect(() => {
    const nextTick = randomProgressTick(progressLineOptions(entry).length, tick);
    const next = formatProgressLine(entry, nextTick);
    const currentTyped = typedRef.current;
    const currentTarget = targetRef.current;
    const currentComplete = currentTyped === currentTarget && currentTarget.length > 0;
    setTick(nextTick);

    if (currentTyped === next) {
      pendingTargetRef.current = null;
      return;
    }

    if (currentTyped) {
      pendingTargetRef.current = next;
      if (!currentComplete) return;

      const typedDoneAt = typedDoneAtRef.current || Date.now();
      const remainingHold = MIN_PROGRESS_STATUS_MS - (Date.now() - typedDoneAt);
      if (remainingHold > 0) {
        holdMsRef.current = remainingHold;
        setPhase("holding");
      } else {
        setPhase("erasing");
      }
      return;
    }

    pendingTargetRef.current = null;
    typedDoneAtRef.current = 0;
    if (currentTarget !== next) {
      setTarget(next);
    }
    setTyped("");
    setPhase("typing");
  }, [entry.groupId, entry.state, entry.note, entry.source]);

  React.useEffect(() => {
    let timeoutId: number | null = null;
    if (phase === "typing") {
      if (typed.length < target.length) {
        timeoutId = window.setTimeout(
          () => setTyped(target.slice(0, typed.length + 1)),
          PROGRESS_TYPE_MS.min +
            Math.floor(Math.random() * (PROGRESS_TYPE_MS.max - PROGRESS_TYPE_MS.min + 1)),
        );
      } else {
        if (!typedDoneAtRef.current) typedDoneAtRef.current = Date.now();
        if (pendingTargetRef.current) {
          const remainingHold = MIN_PROGRESS_STATUS_MS - (Date.now() - typedDoneAtRef.current);
          if (remainingHold > 0) {
            holdMsRef.current = remainingHold;
            setPhase("holding");
          } else {
            setPhase("erasing");
          }
          return;
        }
        // Type the actual state/note once and hold — no random cycling.
        return;
      }
    } else if (phase === "holding") {
      timeoutId = window.setTimeout(() => setPhase("erasing"), holdMsRef.current);
    } else if (typed.length > 0) {
      timeoutId = window.setTimeout(() => setTyped((text) => text.slice(0, -1)), PROGRESS_TYPE_MS.erase);
    } else {
      if (pendingTargetRef.current) {
        typedDoneAtRef.current = 0;
        setTarget(pendingTargetRef.current);
        pendingTargetRef.current = null;
        setPhase("typing");
        return;
      }
      const nextTick = randomProgressTick(progressLineOptions(entry).length, tick);
      setTick(nextTick);
      typedDoneAtRef.current = 0;
      setTarget(formatProgressLine(entry, nextTick));
      setPhase("typing");
    }
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [phase, typed, target, entry, tick]);

  return (
    <div className="my-2 flex w-full items-center justify-start gap-2">
      <div className="w-7 shrink-0">
        <IdAvatar seed={avatarSeed || "?"} src={avatarSrc} size={28} family={avatarFamily ?? "carbon"} />
      </div>
      <div className="min-w-0 max-w-[70%]">
        <span className="silicon-activity-line flex min-h-7 items-center text-sm">
          <span className="inline-flex min-w-0 max-w-full items-center gap-3 overflow-hidden">
            <span className="silicon-activity-copy">
              {typed || "\u00a0"}
            </span>
            <span className="silicon-activity-core" aria-hidden="true">
              {Array.from({ length: 16 }, (_, i) => (
                <span key={i} />
              ))}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

function progressLineOptions(entry: ProgressEntry): string[] {
  // The actual flow: the silicon's note if it sent one, else the real state.
  const note = meaningfulProgressNote(entry.note, entry.state);
  if (note) return [sentenceCase(note)];
  return [progressStateLabel(entry.state)];
}

function randomProgressTick(length: number, previous: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (next === previous) {
    next = (next + 1 + Math.floor(Math.random() * (length - 1))) % length;
  }
  return next;
}

function formatProgressLine(entry: ProgressEntry, tick = 0): string {
  const lines = progressLineOptions(entry);
  return truncateProgressLine(lines[tick % lines.length]);
}

function truncateProgressLine(value: string): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= MAX_PROGRESS_LINE_CHARS) return text;
  return `${text.slice(0, Math.max(0, MAX_PROGRESS_LINE_CHARS - 2)).trimEnd()}..`;
}

function progressStateLabel(state: ProgressState): string {
  switch (state) {
    case "reading_file":
      return "Reading file";
    case "writing_file":
      return "Writing file";
    case "executing":
      return "Executing command";
    case "searching_web":
      return "Searching web";
    case "done":
      return "Wrapping up";
    case "thinking":
    default:
      return "Working";
  }
}

function meaningfulProgressNote(note: string, state: ProgressState): string {
  const text = collapsePathMentions(note.trim());
  if (!text) return "";
  const normalized = text.toLowerCase().replace(/[.…]+$/g, "").trim();
  // Internal tool-call chatter ("called tool: reply", "calling tool: …") is a
  // mechanic, not a user-facing status — fall back to the plain state label.
  if (
    normalized.startsWith("called tool") ||
    normalized.startsWith("calling tool") ||
    normalized.startsWith("tool call") ||
    normalized.startsWith("tool:")
  ) {
    return "";
  }
  if (state === "thinking" && (normalized === "thinking" || normalized.startsWith("thought for "))) {
    return "";
  }
  if (
    state === "executing" &&
    (normalized.startsWith("executing command failed") ||
      normalized.startsWith("message failed:"))
  ) {
    return sentenceCase(text);
  }
  if (
    state === "executing" &&
    (normalized.startsWith("executing:") ||
      normalized === "executing command" ||
      normalized.startsWith("executing output:") ||
      normalized.startsWith("executing done:"))
  ) {
    return "Executing command";
  }
  return text;
}

function collapsePathMentions(value: string): string {
  return value.replace(
    /(`?)(?!(?:[a-z][a-z0-9+.-]*:\/\/))((?:~?\/|\.{1,2}\/|[A-Za-z]:[\\/]|(?:[A-Za-z0-9_.-]+[\\/]))[^\s`"'<>]*)(`?)/gi,
    (match, open: string, rawPath: string, close: string, offset: number, input: string) => {
      if (input.slice(Math.max(0, offset - 8), offset).includes("://")) return match;
      const suffixMatch = rawPath.match(/[),.;:\]}]+$/);
      const suffix = suffixMatch?.[0] ?? "";
      const path = suffix ? rawPath.slice(0, -suffix.length) : rawPath;
      const parts = path.split(/[\\/]+/).filter(Boolean);
      const fileName = parts[parts.length - 1];
      if (!fileName || fileName === path) return match;
      const tick = open || close ? "`" : "";
      return `${tick}${fileName}${tick}${suffix}`;
    },
  );
}

function sentenceCase(value: string): string {
  const text = value.trim();
  if (!text) return "Working";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function SearchBar({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-56 items-center gap-1 border border-input bg-transparent px-2 transition-colors focus-within:border-ring">
      <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Stop here so Esc closes the search field, not the whole chat.
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="search messages"
        className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="close search"
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="border-2 border-dashed border-foreground/30 bg-card px-6 py-4 text-sm text-foreground/80">
        drop to attach
      </div>
    </div>
  );
}

function isMyEvent(e: Event, myUsername: string | null) {
  if (!myUsername) return false;
  return e.sender_kind === "carbon" && e.sender_handle === myUsername;
}

/** Coerce an unknown wire value to a finite number in 0..100, else null. */
function numOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/**
 * Reconcile a fresh server snapshot with our locally-tracked events without
 * blowing away optimistic rows or hard-won _status upgrades.
 *
 * • Every server event is the source of truth for its content — but we keep
 *   our existing `_status` so a poll never downgrades a "read" tick back to
 *   "delivered".
 * • Any local row the server didn't echo back this round is preserved (our
 *   optimistic placeholders, and any just-sent rows that didn't fit in the
 *   100-event polling window).
 */
/**
 * Render the active-state map as a single subtitle line.
 *   • @alice is typing…
 *   • @alice is uploading…
 *   • @alice is recording…
 *   • @alice, @bob are typing…
 * Returns null when nothing is active, so the caller falls back to the
 * static room subtitle.
 */
function formatActivities(
  acts: Record<string, { state: "typing" | "uploading" | "recording"; until: number }>,
): string | null {
  const entries = Object.entries(acts);
  if (entries.length === 0) return null;
  // If everyone is doing the same thing, fold the verb. Otherwise pick one.
  const states = new Set(entries.map(([, a]) => a.state));
  const verb = states.size === 1 ? [...states][0] : "typing";
  const handles = entries.map(([h]) => `@${h}`);
  const who =
    handles.length === 1
      ? handles[0]
      : `${handles.slice(0, -1).join(", ")} & ${handles.slice(-1)}`;
  // §1.10 — agree the verb in number: "@a is typing…" vs "@a & @b are typing…".
  const aux = handles.length === 1 ? "is" : "are";
  return `${who} ${aux} ${verb}…`;
}

function mergeServerEvents(
  prev: LocalEvent[],
  server: Event[],
  myUsername: string | null,
): LocalEvent[] {
  const serverIds = new Set(server.map((e) => e.event_id));
  const byPrev = new Map(prev.map((e) => [e.event_id, e] as const));
  const byClient = new Map<string, LocalEvent>();
  for (const event of prev) {
    const clientId = localClientId(event);
    if (clientId) byClient.set(clientId, event);
  }
  const consumedLocalIds = new Set<string>();
  const merged: LocalEvent[] = server.map((ev) => {
    const clientId = localClientId(ev);
    const existing = byPrev.get(ev.event_id) ?? (clientId ? byClient.get(clientId) : undefined);
    if (existing) {
      if (existing.event_id !== ev.event_id) consumedLocalIds.add(existing.event_id);
      return {
        ...ev,
        _status: existing._status,
        _clientId: existing._clientId ?? clientId ?? undefined,
      };
    }
    const mine = ev.sender_handle && ev.sender_handle === myUsername;
    return { ...ev, _status: mine ? ("delivered" as MessageStatus) : undefined };
  });
  const localOnly = prev.filter(
    (e) => !serverIds.has(e.event_id) && !consumedLocalIds.has(e.event_id),
  );
  // Keep strict chronological order. Appending localOnly (e.g. older history
  // loaded via loadOlder, or optimistic temps) to the end scrambled the array,
  // which broke loadOlder's "oldest = events[0]" cursor and stalled pagination.
  // ULID / ISO created_at sorts lexicographically = chronologically.
  return [...merged, ...localOnly].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
}

function localClientId(event: Event | LocalEvent): string | null {
  const local = (event as LocalEvent)._clientId;
  if (typeof local === "string" && local) return local;
  const content = event.content?.client_id;
  return typeof content === "string" && content ? content : null;
}
