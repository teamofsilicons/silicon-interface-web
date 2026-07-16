"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown, Check, Checks, Clock, Eye, MagnifyingGlass, Microphone, WarningCircle, X } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import { loadStoredRoomEvents, storeEvents } from "@/lib/chat-store";
import { evictCachedMedia } from "@/lib/media-cache";
import {
  SyncIntegrityError,
  validateHistoryPage,
  type HistoryTraversal,
} from "@/lib/sync-integrity";
import {
  classifySyncFailure,
  reportSyncRecovered,
  reportSyncRecovery,
  syncRecoveryState,
} from "@/lib/sync-recovery";
import { cn, dayLabel, relativeTimeAgo } from "@/lib/utils";
import { presenceIsOnline } from "@/lib/presence-state";
import { authStore, useAuth } from "@/lib/auth";
import { roomDisplay } from "@/lib/peers";
import { playSent, playAckTick, vibrate } from "@/lib/sounds";
import {
  shouldPromptNotifications,
  markNotificationsAsked,
  closeBrowserNotification,
  removeNotificationByEvent,
  requestBrowserNotifications,
} from "@/lib/notifications";
import { projectRedactedEvent, projectRedactedWindow } from "@/lib/redaction-state";
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
import { track } from "@/lib/analytics";
import {
  ackOutbox,
  commitOutboxCorrection,
  discardOutbox,
  enqueueOutbox,
  listOutbox,
  type OutboxEntry,
} from "@/lib/outbox";
import {
  heldCancellationCanHide,
  listHeldCancellations,
  maySendHeldOutbox,
  withOutboxClientLock,
} from "@/lib/held-cancellation";
import {
  acceptedHeldSend,
  eventForSentHeld,
  isAmbiguousSendFailure,
} from "@/lib/operation-recovery";
import {
  ABUSE_CHALLENGE_SOLVED_EVENT,
  challengeFromErrorBody,
  rememberAbuseChallenge,
} from "@/lib/abuse-challenge-store";
import {
  OUTBOX_RETRY_SCHEDULED_EVENT,
  persistOutboxFailure,
  prepareManualOutboxRetry,
  wakeOutboxRecovery,
} from "@/lib/outbox-recovery";
import {
  discardMediaSend,
  replaceMediaOutboxSource,
  restartMediaUploadGeneration,
} from "@/lib/media-send";
import { ensureDeviceRegistration } from "@/lib/device-registration";
import {
  isUnreadEligibleEvent,
  roomOpenReadTarget,
  selectUnreadDividerEventId,
  selectVisibleReadTarget,
} from "@/lib/unread-boundary";
import {
  classifySendFailure,
  sendFailureFromHeld,
  sendFailureMessage,
  type CorrectionAction,
  type SendFailureRecord,
} from "@/lib/send-failure";
import {
  heldSendDeadline,
  heldChallengeUsableOnDevice,
  heldSendBelongsToDevice,
  heldSendMaySchedule,
  heldSendProjectionKey,
  heldSendUiState,
} from "@/lib/held-send-state";
import {
  restoredOutboxStatus,
  statusAfterSendFailure,
  statusAfterSendTimeout,
} from "@/lib/outbox-ui-state";
import { editableTextForEvent, withEditedText } from "@/lib/event-edit";
import { SILICON_TEXT_HOLD_MS } from "@/lib/silicon-hold";
import { isGifMedia } from "@/lib/media-meta";
import {
  anchorPixelCorrection,
  findVirtualAnchorIndex,
} from "@/lib/virtualization-anchor";
import { countNovelHistoryRows, hasNovelHistoryRows } from "@/lib/history-window";
import { belongsToSameTimelinePanel } from "@/lib/timeline-panel";
import {
  shouldLoadOlderDuringRangeChange,
  timelineViewportPadding,
} from "@/lib/timeline-text-selection";
import { authoritativeEditConflict } from "@/lib/edit-conflict";
import { reconcileReplyTarget } from "@/lib/reply-state";
import { chatConnectingCopy } from "@/lib/connection-status";
import { messageReceiptPresentation } from "@/lib/message-receipt";
import { mergeSearchPage, recentLocalSearch } from "@/lib/reliable-search";
import {
  aggregateReactions,
  applyOwnReactionOverride,
  normalizeReactionEmoji,
  ownReactionIsActive,
  reactionIntentKey,
  reconcileReactionResult,
  retryReactionMutation,
} from "@/lib/reaction-state";
import {
  allowDraftNavigation,
  setDraft,
  setDraftReply,
  useDraftReply,
} from "@/lib/drafts";
import { useVoiceRecordingSession } from "@/lib/voice-recording-session";
import { loadCachedTeamRoster, saveCachedTeamRoster } from "@/lib/sidebar-cache";
import {
  canSendPlaintextToRoom,
  normalizeDeliveryObject,
  normalizeDeliverySummary,
} from "@/lib/delivery-state";
import { deviceId } from "@/lib/device-id";
import {
  createModerationReportIntent,
  listModerationReportIntents,
  MODERATION_REPORT_RETRY_SCHEDULED_EVENT,
  writeModerationReportIntent,
  type ModerationReportRetryScheduledDetail,
  type ModerationReportIntent,
  type ModerationReportReason,
} from "@/lib/moderation-report-journal";
import { createModerationReportRecoveryScheduler } from "@/lib/moderation-report-recovery";
import {
  applyTimelineIdentity,
  bindAcceptedTimelineEvent,
  canEditAuthoritativeTimelineEvent,
  ensureTimelineIdentitySync,
  hasAuthoritativeEventId,
  identityFromPersistedFields,
  readTimelineIdentity,
  reconcileTimelineEvents,
  timelineRenderKey,
  type TimelineEvent,
} from "@/lib/timeline-identity";

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
  type CancelQueuedResult,
  type ComposerCopyDraft,
  type MentionCandidate,
  type OptimisticPayload,
} from "@/components/chat/composer";
import { VoiceRecorder } from "@/components/chat/voice-recorder";
import { AnnotationStudio } from "@/components/chat/annotation-studio/annotation-studio";
import { ForwardDialog } from "@/components/chat/forward-dialog";
import { RoomSendProvider } from "@/components/chat/room-send-context";
import { MessageBubble, type MessageStatus } from "@/components/chat/message-bubble";
import { sendTimeoutMs } from "@/lib/send-timeout";
import type { AnnotationOpenRequest } from "@/components/chat/media-previewer";
import { ProfileDrawer } from "@/components/chat/profile-drawer";
import { CronDrawer } from "@/components/chat/cron-drawer";
import { SiliconBrowserMark } from "@/components/chat/remote-browser-card";
import { SiliconBrowserDialog } from "@/components/chat/silicon-browser-dialog";
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
    state?: "offline" | "captive" | "degraded" | "connecting" | "authenticating" | "syncing" | "online";
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
  /** Fired only after Glass commits a genuinely visible read target. */
  onReadThrough?: (eventId: string, streamPosition: number) => void;
}

type LocalEvent = TimelineEvent & {
  _status?: MessageStatus;
  _sendTimeoutAt?: string;
  _sendTimeoutMs?: number;
  _failure?: SendFailureRecord;
  _nextAttemptAt?: number;
  _heldSendId?: string;
  _heldVersion?: number;
  _heldChallengeDeviceMismatch?: boolean;
};

type PendingTextCorrection = {
  event: LocalEvent;
  action: "edit_message" | "review_input";
  text: string;
};

const VISIBLE_HELD_SEND_MS = SILICON_TEXT_HOLD_MS;
const MAX_EXTENDED_HELD_SEND_MS = 300_000;
const HELD_SEND_RECOVERY_MAX_DELAY_MS = MAX_EXTENDED_HELD_SEND_MS + 100;

function localHeldReleaseAt(held: HeldSend): string {
  const now = Date.now();
  const serverHoldMs =
    Date.parse(heldSendDeadline(held)) -
    Date.parse(held.updated_at || held.created_at);
  const localDelay = Number.isFinite(serverHoldMs)
    ? Math.min(MAX_EXTENDED_HELD_SEND_MS, Math.max(0, serverHoldMs))
    : VISIBLE_HELD_SEND_MS;
  return new Date(now + localDelay).toISOString();
}

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
  /** Plain recipient activity shown before real work progress. */
  receipt?:
    | "waiting"
    | "partially_delivered"
    | "delivered"
    | "partially_read"
    | "read";
}

type ActivityReceipt = NonNullable<ProgressEntry["receipt"]>;

function activityReceiptFromDeliveries(
  deliveries: Record<string, NonNullable<Event["delivery"]>> | undefined,
): ActivityReceipt | null {
  const statuses = Object.values(deliveries ?? {}).map(
    (delivery) => normalizeDeliveryObject(delivery).state,
  );
  if (statuses.length === 0) return null;
  if (statuses.every((status) => status === "read")) return "read";
  if (
    statuses.every(
      (status) =>
        status === "delivered" || status === "partially_read" || status === "read",
    )
  ) {
    return statuses.every((status) => status === "delivered")
      ? "delivered"
      : "partially_read";
  }
  if (statuses.some((status) => status === "partially_delivered")) {
    return "partially_delivered";
  }
  return "waiting";
}

const TEMP_ID = (clientId: string) => `temp-${clientId}`;

function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function replyPreviewOf(event: Event): string {
  const content = event.content as Record<string, unknown>;
  if (event.type === "m.text") {
    const body = String(content.body ?? "");
    return body.length > 80 ? `${body.slice(0, 80)}…` : body;
  }
  if (event.type === "m.image") {
    return isGifMedia(content.mime, content.filename) ? "GIF" : "photo";
  }
  if (event.type === "m.file") {
    return String(content.filename ?? content.caption ?? "attachment");
  }
  if (event.type === "m.album") return String(content.caption ?? "attachments");
  if (event.type === "m.voice") return "voice note";
  if (event.type === "m.remote_browser") return "Silicon Browser link";
  if (event.type === "m.tts") return "audio";
  return event.type;
}

/** One-line text for an outgoing (optimistic) message, shown in the sidebar
 *  preview while it's waiting / in flight. No emojis — the row renders an icon. */
function outgoingPreviewText(payload: OptimisticPayload): string {
  const c = (payload.content ?? {}) as Record<string, unknown>;
  switch (payload.type) {
    case "m.text":
      return String(c.body ?? "");
    case "m.image": {
      const caption = c.caption ? String(c.caption) : "";
      if (isGifMedia(c.mime, c.filename)) return caption ? `GIF · ${caption}` : "GIF";
      return caption || "photo";
    }
    case "m.file":
      return c.filename ? String(c.filename) : "attachment";
    case "m.album": {
      const count = Array.isArray(c.items) ? c.items.length : 0;
      return c.caption ? String(c.caption) : count ? `${count} attachments` : "attachments";
    }
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
  "m.album",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);
const MIN_PROGRESS_STATUS_MS = 1000;
// How long recipient activity shows before switching to the
// actual silicon work progress.
const RECEIPT_HOLD_MS = 3000;
// §1.1 — progress staleness. We keep showing the last live line as long as the
// silicon might still be working; only after a long silence do we collapse it to
// a quiet "Still working…" (with a dismiss, in case it died with no `done`).
const PROGRESS_STALE_HARD_MS = 100_000;
// Backend search: hits per block (page) and the debounce before firing a query.
const SEARCH_INTERVAL = 40;
const SEARCH_DEBOUNCE_MS = 280;

// The earlier-history connection indicator has constant height
// (just fades in/out) so toggling it never shoves the list up/down.
function ChatListHeader({ loadingOlder }: { loadingOlder: boolean }) {
  return (
    <div className="flex justify-center pb-2 pt-4">
      <span
        role="status"
        aria-live="polite"
        aria-hidden={!loadingOlder}
        className={cn(
          "label-mono text-[11px] text-muted-foreground transition-opacity",
          loadingOlder ? "opacity-100" : "opacity-0",
        )}
      >
        Connecting…
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
  // Signal/Element keep a stable tombstone row so replies, scroll anchors, and
  // unread boundaries do not collapse when content is redacted.
  return event.type !== "m.reaction" && event.type !== "m.progress";
}

/**
 * Load roughly one timeline page, not merely one raw-event page. Progress and
 * reaction rows are still returned so live state remains correct, but they do
 * not count toward the visible-message target. Without this scan, a silicon's
 * progress-heavy tail can fill the latest API page and make an established
 * conversation look empty with no scroll surface available to reach history.
 */
async function loadTimelineWindow(
  roomId: string,
  pageCursor?: string | null,
  anchor?: string,
  expectedBefore?: string,
  knownEventIds: ReadonlySet<string> = new Set(),
) {
  const pages: Event[][] = [];
  const seenCursors = new Set<string>();
  let cursor = pageCursor ?? "";
  let visibleCount = 0;
  let requestLimit = PAGE_SIZE;
  let hasMore = false;
  let nextCursor: string | null = cursor;
  let traversal: HistoryTraversal = {
    throughEventId: undefined,
    seenEventIds: new Set<string>(),
    oldestEventId: anchor ?? expectedBefore,
  };
  if (cursor) seenCursors.add(cursor);

  while (visibleCount < PAGE_SIZE) {
    const page = await api.historyPage(
      roomId,
      cursor,
      requestLimit,
      "backward",
      cursor ? undefined : anchor,
    );
    traversal = validateHistoryPage(page, traversal, roomId);
    if (page.events.length === 0) {
      hasMore = false;
      nextCursor = null;
      break;
    }

    pages.unshift(page.events);
    // A durable cache can paint farther back than the first live response.
    // Keep advancing the *same signed traversal* until this window contains a
    // useful number of timeline rows that the caller does not already own.
    // Counting cached overlap here would strand the user at scrollTop=0 with
    // a cursor that still points inside the cached range.
    visibleCount += countNovelHistoryRows(page.events, knownEventIds, isTimelineEvent);
    hasMore = page.has_more && Boolean(page.cursor);
    nextCursor = page.cursor;
    if (!hasMore || visibleCount >= PAGE_SIZE) break;

    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new SyncIntegrityError(
        "history",
        "page_invariant",
        "History continuation did not make progress.",
        { roomId },
      );
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
    requestLimit = RAW_SCAN_PAGE_SIZE;
  }

  return {
    events: pages.flat(),
    hasMore,
    cursor: hasMore ? nextCursor : null,
    boundaryEventId: traversal.oldestEventId ?? null,
  };
}

// Receipt progression is monotonic — waiting → delivered → read. The WS echo
// and read receipts often land BEFORE the HTTP send ack, so an ack must never
// knock a message back down to waiting. `bestStatus`
// keeps whichever status is further along.
const STATUS_RANK: Record<MessageStatus, number> = {
  failed: -1,
  pending: 0,
  resolving: 0,
  retry_wait: 0,
  retrying: 0,
  challenge: 0,
  sent: 1,
  partially_delivered: 2,
  delivered: 3,
  partially_read: 4,
  read: 5,
};
function bestStatus(
  a: MessageStatus | undefined,
  b: MessageStatus | undefined,
): MessageStatus | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function serverDeliveryStatus(event: Event): MessageStatus {
  return event.delivery?.state ?? "sent";
}

/* eslint-disable react-hooks/preserve-manual-memoization -- RoomView is explicitly opted out of compiler memoization until its durable journal/socket/viewport state is split into smaller components. */
export function RoomView({
  room,
  allRooms,
  socket,
  contacts,
  onContactsChanged,
  connectionStatePending = false,
  onReadThrough,
}: Props) {
  "use no memo";
  // RoomView intentionally coordinates multiple durable journals, websocket
  // projections, and viewport anchors. Keep the React Compiler out until these
  // independently stateful surfaces are split into smaller components.
  const router = useRouter();
  const {
    ready: socketReady,
    state: socketState,
    send: socketSend,
    subscribe: socketSubscribe,
  } = socket;
  const { carbon } = useAuth();
  const myUsername = carbon?.username ?? null;
  const timelineOwner = carbon?.carbon_id ?? "session";
  const timelineDevice = authStore.getBoundDeviceId() ?? deviceId();
  const reportHistoryFailure = React.useCallback((error: unknown) => {
    const owner = carbon?.carbon_id;
    if (!owner) return;
    const decision = classifySyncFailure(error, "history");
    void reportSyncRecovery(owner, {
      phase: "degraded",
      reason: decision.reason,
      stream: "history",
      details: { ...decision.details, roomId: room.room_id },
    });
  }, [carbon?.carbon_id, room.room_id]);
  const reportHistoryHealthy = React.useCallback(() => {
    const owner = carbon?.carbon_id;
    if (!owner) return;
    void syncRecoveryState(owner).then((record) => {
      if (record?.phase !== "recovered" && record?.stream === "history") {
        return reportSyncRecovered(owner, record, ["history"]);
      }
      return null;
    }).catch(() => undefined);
  }, [carbon?.carbon_id]);
  const display = roomDisplay(room);
  const plaintextSendAllowed = canSendPlaintextToRoom(room.security_mode);
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
  const carbonPresence = peer?.kind === "carbon" ? peer.presence : undefined;
  const presenceOnline = presenceIsOnline(carbonPresence);
  const lastSeen = carbonPresence?.last_seen_at
    ? relativeTimeAgo(carbonPresence.last_seen_at)
    : "";
  const carbonPresenceLabel =
    carbonPresence?.state === "hidden"
      ? null
      : presenceOnline
        ? "online"
        : lastSeen
          ? `last seen ${lastSeen}`
          : carbonPresence
            ? "offline"
            : null;
  const contact = peer ? contacts?.get(contactKey(peer.kind, peer.id)) : undefined;
  const siliconConnectionKey =
    peer?.kind === "silicon" ? `${room.room_id}:${peer.id}` : null;
  const [polledSiliconConnection, setPolledSiliconConnection] = React.useState<{
    key: string;
    metadataState: string;
    state: string;
  } | null>(null);
  // A poll result only applies to the exact room+peer it queried. Deriving the
  // fallback directly from room metadata prevents a stale offline result from
  // flashing when the user switches rooms, without an effect-driven reset.
  const metadataSiliconConnectionState =
    peer?.kind === "silicon" ? peer.connection_state || "online" : "online";
  const siliconConnectionState =
    siliconConnectionKey &&
    polledSiliconConnection?.key === siliconConnectionKey &&
    polledSiliconConnection.metadataState === metadataSiliconConnectionState
      ? polledSiliconConnection.state
      : metadataSiliconConnectionState;
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
          setPolledSiliconConnection({
            key: `${room.room_id}:${nextPeer.id}`,
            metadataState: peer.connection_state || "online",
            state: nextPeer.connection_state || "online",
          });
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
  }, [connectionStatePending, peer?.connection_state, peer?.kind, room.room_id]);

  const [events, setEvents] = React.useState<LocalEvent[]>([]);
  // While a desired-state mutation is in flight, this projection wins over
  // delayed/out-of-order WS echoes. Requests for the same reaction are chained
  // so rapid cross-device-style toggles converge in click order.
  const [reactionOverrides, setReactionOverrides] = React.useState<Record<string, boolean>>({});
  const reactionGenerationRef = React.useRef(new Map<string, number>());
  const reactionChainsRef = React.useRef(new Map<string, Promise<void>>());
  const reactionRoomRef = React.useRef(room.room_id);
  React.useEffect(() => {
    reactionRoomRef.current = room.room_id;
    reactionGenerationRef.current.clear();
    reactionChainsRef.current.clear();
    queueMicrotask(() => {
      if (reactionRoomRef.current === room.room_id) setReactionOverrides({});
    });
  }, [room.room_id]);
  const [loading, setLoading] = React.useState(true);
  const chatConnectionStatus = chatConnectingCopy(
    socketState,
    loading && events.length === 0,
  );
  // §2.5 — true only once the live fetch resolves. Auto-read is gated on this so
  // we never clear unread for messages that are only in the localStorage cache.
  const [hydrated, setHydrated] = React.useState(false);
  const [activeProgress, setActiveProgress] = React.useState<ProgressEntry | null>(null);
  // Drives the "waiting → delivered → read" activity sequence.
  const receiptTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReceiptTimer = React.useCallback(() => {
    if (receiptTimerRef.current) {
      clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = null;
    }
  }, []);
  // Show plain recipient activity, then after a beat fall through to the
  // actual silicon work progress.
  const showReceipt = React.useCallback(
    (kind: ActivityReceipt) => {
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
  const cancelQueuedRef = React.useRef<
    ((clientId: string) => Promise<CancelQueuedResult>) | null
  >(null);
  const clearHeldClientRef = React.useRef<((clientId: string) => void) | null>(null);
  // §1.1 — a monotonically-advancing tick used to detect a progress line that
  // has gone stale (silicon crashed / backend restarted with no `done` frame).
  const [progressNow, setProgressNow] = React.useState(() => Date.now());
  // Messages received while the user is reading history are counted on the
  // always-available jump-to-bottom control.
  const [unseenBelow, setUnseenBelow] = React.useState(0);
  const [timelineAtBottom, setTimelineAtBottom] = React.useState(true);
  // §2.7 — "load older" pagination past the latest 100-event window.
  const [hasMore, setHasMore] = React.useState(false);
  const [historyCursor, setHistoryCursor] = React.useState<string | null>(null);
  // The oldest raw event proven by `historyCursor`'s fixed traversal. This is
  // intentionally separate from `events[0]`: a durable cache may contain a
  // much older projection than the live page that issued the cursor.
  const [historyBoundaryEventId, setHistoryBoundaryEventId] = React.useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const loadingOlderRef = React.useRef(false);
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
  const [reportTarget, setReportTarget] = React.useState<Event | null>(null);
  const [reportReason, setReportReason] = React.useState<ModerationReportReason>("spam");
  const [reportDetails, setReportDetails] = React.useState("");
  const [reportSubmitting, setReportSubmitting] = React.useState(false);
  const reportsSendingRef = React.useRef(new Set<string>());
  const [focusSender, setFocusSender] = React.useState<{
    kind: "carbon" | "silicon";
    handle: string;
  } | null>(null);

  const deliverModerationReport = React.useCallback(async (intent: ModerationReportIntent) => {
    if (reportsSendingRef.current.has(intent.clientId) || intent.state === "accepted" || intent.state === "blocked") {
      return intent.state;
    }
    reportsSendingRef.current.add(intent.clientId);
    const attempt = intent.attempts + 1;
    const sending: ModerationReportIntent = {
      ...intent,
      state: "sending",
      attempts: attempt,
      nextAttemptAt: null,
      errorCode: null,
      updatedAt: Date.now(),
    };
    try {
      // Save the attempt before transport. A crash after the POST is repaired
      // by replaying the exact client id, which Glass resolves idempotently.
      await writeModerationReportIntent(sending);
      const receipt = await api.reportMessage({
        target_kind: sending.targetKind,
        target_id: sending.targetId,
        reason: sending.reason,
        details: sending.details,
        client_id: sending.clientId,
        event_id: sending.eventId,
      });
      await writeModerationReportIntent({
        ...sending,
        state: "accepted",
        reportId: receipt.report_id,
        updatedAt: Date.now(),
      });
      return "accepted" as const;
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      const permanent = apiError !== null && [400, 403, 404, 409, 422].includes(apiError.status);
      const retryDelay = Math.min(
        60 * 60 * 1000,
        apiError?.retryAfterMs ?? Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6)),
      );
      const failed: ModerationReportIntent = {
        ...sending,
        state: permanent ? "blocked" : "retry_wait",
        nextAttemptAt: permanent ? null : Date.now() + Math.max(1_000, retryDelay),
        errorCode: apiError ? `http_${apiError.status}` : "transport_unavailable",
        updatedAt: Date.now(),
      };
      // If this write fails, the earlier durable `sending` state remains and
      // restart recovery safely retries the same immutable request.
      await writeModerationReportIntent(failed).catch(() => undefined);
      return failed.state;
    } finally {
      reportsSendingRef.current.delete(intent.clientId);
    }
  }, []);

  React.useEffect(() => {
    const ownerId = carbon?.carbon_id;
    if (!ownerId) return;
    const scheduler = createModerationReportRecoveryScheduler({
      recover: async () => {
        if (typeof navigator !== "undefined" && !navigator.onLine) return null;
        const rows = await listModerationReportIntents(ownerId).catch(() => []);
        const now = Date.now();
        const due = rows.filter(
          (row) =>
            row.state === "pending" ||
            row.state === "sending" ||
            (row.state === "retry_wait" && (row.nextAttemptAt ?? 0) <= now),
        );
        await Promise.all(due.map((row) => deliverModerationReport(row)));
        const refreshed = await listModerationReportIntents(ownerId).catch(() => []);
        return refreshed
          .filter((row) => row.state === "retry_wait" && row.nextAttemptAt !== null)
          .reduce<number | null>(
            (earliest, row) => earliest === null
              ? row.nextAttemptAt
              : Math.min(earliest, row.nextAttemptAt!),
            null,
          );
      },
    });
    const online = () => scheduler.wake();
    const retryScheduled = (event: globalThis.Event) => {
      const detail = (
        event as CustomEvent<ModerationReportRetryScheduledDetail>
      ).detail;
      if (detail?.ownerId !== ownerId) return;
      scheduler.schedule(detail.nextAttemptAt);
    };
    window.addEventListener("online", online);
    window.addEventListener(
      MODERATION_REPORT_RETRY_SCHEDULED_EVENT,
      retryScheduled,
    );
    scheduler.wake();
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener(
        MODERATION_REPORT_RETRY_SCHEDULED_EVENT,
        retryScheduled,
      );
      scheduler.cancel();
    };
  }, [carbon?.carbon_id, deliverModerationReport]);

  const submitModerationReport = React.useCallback(async () => {
    if (!reportTarget || !carbon?.carbon_id || reportSubmitting) return;
    const targetId = reportTarget.sender_public_id ||
      (reportTarget.sender_kind === "carbon" ? reportTarget.sender_handle : null);
    if (!targetId || (reportTarget.sender_kind !== "carbon" && reportTarget.sender_kind !== "silicon")) {
      toast.error("This older message cannot be safely identified. Refresh the chat and try again.");
      return;
    }
    setReportSubmitting(true);
    try {
      const intent = createModerationReportIntent({
        ownerId: carbon.carbon_id,
        targetKind: reportTarget.sender_kind,
        targetId,
        eventId: reportTarget.event_id,
        reason: reportReason,
        details: reportDetails.trim(),
      });
      // The dialog is not dismissed until this exact report is owned by at
      // least one durable browser store.
      await writeModerationReportIntent(intent);
      const state = await deliverModerationReport(intent);
      setReportTarget(null);
      setReportDetails("");
      setReportReason("spam");
      if (state === "accepted") toast.success("report received");
      else if (state === "retry_wait") toast.info("Report saved. We’ll send it when connected.");
      else toast.error("report saved, but it needs your attention");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "report could not be saved");
    } finally {
      setReportSubmitting(false);
    }
  }, [
    carbon,
    deliverModerationReport,
    reportDetails,
    reportReason,
    reportSubmitting,
    reportTarget,
    setReportDetails,
    setReportReason,
    setReportTarget,
  ]);
  const [replyTo, setReplyTo] = React.useState<Event | null>(null);
  const draftReply = useDraftReply(room.room_id);
  const restoredDraftReplyIdRef = React.useRef<string | null>(null);
  const updateReplyDraft = React.useCallback(
    (event: Event | null) => {
      restoredDraftReplyIdRef.current = null;
      setReplyTo(event);
      setDraftReply(
        room.room_id,
        event
          ? {
              event_id: event.event_id,
              sender_handle: event.sender_handle || undefined,
              sender_kind: event.sender_kind,
              type: event.type,
              preview: replyPreviewOf(event),
            }
          : null,
      );
    },
    [room.room_id],
  );
  const [editingEvent, setEditingEvent] = React.useState<Event | null>(null);
  const [composerCopy, setComposerCopy] = React.useState<ComposerCopyDraft | null>(null);
  const [pendingTextCorrection, setPendingTextCorrection] =
    React.useState<PendingTextCorrection | null>(null);
  const [replacementTarget, setReplacementTarget] = React.useState<LocalEvent | null>(null);
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
  const [searchNotice, setSearchNotice] = React.useState<string | null>(null);
  const searchCursorRef = React.useRef<string | null>(null);
  const searchGenerationRef = React.useRef(0);
  const messageNodeRefs = React.useRef(new Map<string, HTMLDivElement>());
  const unreadDividerNodeRef = React.useRef<HTMLDivElement | null>(null);
  const [highlightedEventId, setHighlightedEventId] = React.useState<string | null>(null);
  const highlightTimerRef = React.useRef<number | null>(null);
  const [pendingJumpEventId, setPendingJumpEventId] = React.useState<string | null>(null);
  const lookupTargetRef = React.useRef<string | null>(null);
  const lookupRunRef = React.useRef(0);
  const [replyJumpState, setReplyJumpState] = React.useState<
    Record<string, {
      status: "loading" | "continue" | "error";
      message?: string;
      cursor?: string;
      throughEventId?: string | null;
      oldestEventId?: string;
    }>
  >({});
  const [cronOpen, setCronOpen] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [droppedFiles, setDroppedFiles] = React.useState<File[]>([]);
  const [isDropTarget, setIsDropTarget] = React.useState(false);
  // #5 — Per-handle activity state. Each entry expires after `until`.
  const [activities, setActivities] = React.useState<
    Record<string, { state: "typing" | "uploading" | "recording"; until: number }>
  >({});
  React.useEffect(() => {
    const lookupRun = ++lookupRunRef.current;
    lookupTargetRef.current = null;
    loadingOlderRef.current = false;
    queueMicrotask(() => {
      if (lookupRunRef.current !== lookupRun) return;
      setLoadingOlder(false);
      setHistoryCursor(null);
      setHistoryBoundaryEventId(null);
      setPendingJumpEventId(null);
      setReplyJumpState({});
    });
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
  const handleFor = React.useCallback(
    (kind: "carbon" | "silicon"): string | null => {
      // We don't reliably know peer member_id ↔ handle on the client (Glass
      // doesn't expose Carbon.id). For 1-on-1 rooms there's exactly one
      // peer — assume it's them. For groups we'd need an extra projection;
      // until then we degrade gracefully to a generic "typing…".
      if (peers.length === 1) return peers[0].handle;
      // Fallback: any peer whose kind matches.
      return peers.find((p) => p.kind === kind)?.handle ?? null;
    },
    [peers],
  );

  const sectionRef = React.useRef<HTMLElement>(null);
  // Virtuoso owns the long timeline DOM. We still retain its concrete scroller
  // for visibility geometry/read receipts and exact pixel-anchor correction.
  const scrollRootRef = React.useRef<HTMLDivElement | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const virtuosoRef = React.useRef<VirtuosoHandle | null>(null);
  const timelineLengthRef = React.useRef(0);
  // Native browser selection and a virtualized list normally fight each
  // other: as the pointer auto-scrolls, Virtuoso recycles the DOM node that
  // owns the selection anchor and the browser drops the highlight. While a
  // timeline selection exists we retain the loaded window and pause structural
  // history mutations/autoscrolls. This keeps selection native (including the
  // platform copy menu) without making the full history expensive all the
  // time.
  const [textSelectionActive, setTextSelectionActive] = React.useState(false);
  const textSelectionActiveRef = React.useRef(false);
  const activeRoomIdRef = React.useRef(room.room_id);
  React.useLayoutEffect(() => {
    activeRoomIdRef.current = room.room_id;
  }, [room.room_id]);
  const selectionGestureRef = React.useRef(false);
  const selectionEndWaitersRef = React.useRef(new Set<() => void>());
  const updateTextSelectionActive = React.useCallback((active: boolean) => {
    textSelectionActiveRef.current = active;
    setTextSelectionActive((current) => (current === active ? current : active));
    if (!active && selectionEndWaitersRef.current.size > 0) {
      const waiters = [...selectionEndWaitersRef.current];
      selectionEndWaitersRef.current.clear();
      waiters.forEach((resolve) => resolve());
    }
  }, []);
  const waitForTextSelectionEnd = React.useCallback(() => {
    if (!textSelectionActiveRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      selectionEndWaitersRef.current.add(resolve);
    });
  }, []);
  // Tracks whether the user is parked at the bottom — gates "stick to bottom".
  const stickToBottomRef = React.useRef(true);
  // Stable event + exact viewport pixel captured before a prepend. After
  // Virtuoso receives the older page, we find that event's new virtual index
  // and restore the same pixel—not merely an approximate scrollTop.
  const pendingPrependRef = React.useRef<{ eventId: string; offset: number } | null>(null);

  const scrollToBottom = React.useCallback((behavior: "auto" | "smooth" = "auto") => {
    const index = timelineLengthRef.current - 1;
    if (index >= 0) virtuosoRef.current?.scrollToIndex({ index, align: "end", behavior });
  }, []);

  const requestBottomStick = React.useCallback(
    (behavior: "auto" | "smooth" = "smooth") => {
      if (textSelectionActiveRef.current) return;
      stickToBottomRef.current = true;
      setTimelineAtBottom(true);
      setUnseenBelow(0);
      requestAnimationFrame(() => scrollToBottom(behavior));
    },
    [scrollToBottom],
  );

  // Keep all currently loaded message nodes mounted for the lifetime of a
  // native selection. `selectstart` fires before the browser creates its
  // range, so pin immediately; `selectionchange` then keeps the pin until the
  // user actually clears/collapses that range. Pointer-up alone must not
  // release it because the selected range is still live and copyable.
  React.useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;

    const selectionTouchesTimeline = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      return Boolean((anchor && root.contains(anchor)) || (focus && root.contains(focus)));
    };
    const onSelectStart = (event: globalThis.Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !root.contains(target)) return;
      selectionGestureRef.current = true;
      updateTextSelectionActive(true);
    };
    const onSelectionChange = () => {
      if (selectionGestureRef.current) {
        if (selectionTouchesTimeline()) updateTextSelectionActive(true);
        return;
      }
      updateTextSelectionActive(selectionTouchesTimeline());
    };
    const onPointerEnd = () => {
      selectionGestureRef.current = false;
      requestAnimationFrame(onSelectionChange);
    };

    root.addEventListener("selectstart", onSelectStart);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      root.removeEventListener("selectstart", onSelectStart);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      selectionGestureRef.current = false;
      updateTextSelectionActive(false);
    };
  }, [hydrated, room.room_id, search, updateTextSelectionActive]);

  // A history page that finishes while the user is selecting must not prepend
  // and regroup the first virtual row underneath the browser's live Range.
  // Release any waiter on unmount/room change as well so no request is left
  // suspended behind a selection that belongs to an obsolete timeline.
  React.useEffect(() => () => {
    const waiters = [...selectionEndWaitersRef.current];
    selectionEndWaitersRef.current.clear();
    waiters.forEach((resolve) => resolve());
  }, [room.room_id]);

  // ----- Photo URL lookup per sender (for in-message avatars) -----
  const peerByHandle = React.useMemo(() => {
    const m = new Map<string, Room["peers"][number]>();
    for (const p of peers) m.set(p.handle, p);
    return m;
  }, [peers]);
  // In a team chat, `@` should offer everyone on the team — not just whoever is
  // already a peer in this room. Load the team roster when the room belongs to a
  // team; direct/Others chats fall back to the room peers alone.
  const ownerId = carbon?.carbon_id ?? null;
  const rosterSlug = room.team_slug ?? null;
  const [teamRosterResult, setTeamRosterResult] = React.useState<{
    ownerId: string | null;
    slug: string | null;
    rows: TeamMembership[];
  }>(() => ({
    ownerId,
    slug: rosterSlug,
    rows: loadCachedTeamRoster(ownerId, rosterSlug) ?? [],
  }));
  const teamRoster = React.useMemo(
    () =>
      teamRosterResult.ownerId === ownerId && teamRosterResult.slug === rosterSlug
        ? teamRosterResult.rows
        : loadCachedTeamRoster(ownerId, rosterSlug) ?? [],
    [ownerId, rosterSlug, teamRosterResult],
  );
  React.useEffect(() => {
    const slug = room.team_slug;
    if (!slug) return;
    let alive = true;
    api
      .teamMembers(slug)
      .then((rows) => {
        if (!alive) return;
        setTeamRosterResult({ ownerId, slug, rows });
        saveCachedTeamRoster(ownerId, slug, rows);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ownerId, room.team_slug]);

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
  // Rendering can resolve anyone the sidebar already knows immediately, even
  // during a cold roster fetch. Keep this broader lookup out of the composer's
  // autocomplete: a direct chat should still suggest only its actual peers.
  const messageMentionTargets = React.useMemo<MentionCandidate[]>(() => {
    const seen = new Map<string, MentionCandidate>();
    const add = (candidate: MentionCandidate) => {
      const key = `${candidate.kind}:${candidate.handle}`;
      if (!seen.has(key)) seen.set(key, candidate);
    };
    for (const candidate of mentionCandidates) add(candidate);
    for (const candidateRoom of allRooms) {
      for (const p of Array.isArray(candidateRoom.peers) ? candidateRoom.peers : []) {
        add({
          kind: p.kind,
          handle: p.id,
          name: p.name,
          photoUrl: p.profile_photo_url,
          asciiUrl: p.profile_ascii_url,
        });
      }
    }
    return [...seen.values()];
  }, [allRooms, mentionCandidates]);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- room changes require one atomic pre-paint reset so stale timeline/outbox state never appears in the next room.
    setLoading(!cachedEvents?.some(isTimelineEvent));
    setHydrated(false);
    // Messages present when the chat opens are historical — force them final so
    // a missed finalize frame doesn't replay the "streaming…" state as if the
    // message just arrived. Live streaming still flows in via WS frames.
    setEvents(
      (cachedEvents ?? []).map((e) => {
        const local = e as LocalEvent;
        const cachedStatus = local._status;
        const fallbackStatus =
          !e.event_id.startsWith("temp-") && isMyEvent(e, myUsername)
            ? serverDeliveryStatus(e)
            : undefined;
        return {
          ...e,
          is_final: true,
          _status: cachedStatus ?? fallbackStatus,
        };
      }),
    );
    // Restore an in-flight silicon progress line captured at the page level
    // while this room was closed, so reopening a chat where work is still
    // running shows progress immediately instead of waiting for the next frame.
    setActiveProgress(getRoomProgress(roomId));
    clearReceiptTimer();
    setActivities({});
    restoredDraftReplyIdRef.current = null;
    setReplyTo(null);
    setEditingEvent(null);
    setComposerCopy(null);
    setPendingTextCorrection(null);
    setReplacementTarget(null);
    setFocusSender(null);
    setProfileOpen(false);
    setUnseenBelow(0);
    setTimelineAtBottom(true);
    deltaBufferRef.current.clear();
    firstContactRef.current = false;
    let durableCacheAvailable = false;
    const cacheOwner = authStore.getCarbon()?.carbon_id;
    if (cacheOwner) {
      void Promise.all([listOutbox(cacheOwner), listHeldCancellations(cacheOwner)]).then(([entries, cancellations]) => {
        if (!mounted || !myUsername) return;
        const terminalCancellations = new Set(
          cancellations
            .filter(heldCancellationCanHide)
            .map((row) => row.clientId),
        );
        const pendingCancellations = new Set(
          cancellations
            .filter((row) => row.state === "pending")
            .map((row) => row.clientId),
        );
        const pending = entries
          .filter(
            (entry) =>
              entry.roomId === roomId &&
              !terminalCancellations.has(entry.clientId) &&
              !(entry.operation === "media" && entry.media?.phase === "acquiring"),
          )
          .map((entry): LocalEvent => {
            const timeoutMs = sendTimeoutMs();
            const identity =
              entry.localKey &&
              typeof entry.localSequence === "number" &&
              entry.originDevice &&
              entry.localCreatedAt
                ? identityFromPersistedFields(cacheOwner, entry.clientId, {
                    localKey: entry.localKey,
                    localSequence: entry.localSequence,
                    originDevice: entry.originDevice,
                    localCreatedAt: entry.localCreatedAt,
                  })
                : ensureTimelineIdentitySync(
                    cacheOwner,
                    entry.clientId,
                    timelineDevice,
                    entry.at,
                  );
            const placeholder: LocalEvent = {
              event_id: TEMP_ID(entry.clientId),
              room: 0,
              sender_kind: "carbon",
              sender_id: null,
              sender_handle: myUsername,
              type: (entry.type ?? "m.text") as Event["type"],
              content:
                entry.type && entry.type !== "m.text"
                  ? { ...(entry.content ?? {}) }
                  : { ...(entry.content ?? {}), body: entry.body },
              reply_to_event_id: entry.replyTo ?? "",
              is_final: true,
              created_at: new Date(entry.at).toISOString(),
              edited_at: null,
              redacted_at: null,
              redaction_reason: "",
              _status: pendingCancellations.has(entry.clientId)
                ? "retrying"
                : restoredOutboxStatus(entry.state, entry.attempts ?? 0),
              _clientId: entry.clientId,
              _failure: entry.failure,
              _nextAttemptAt: entry.nextAttemptAt,
              _sendTimeoutMs: timeoutMs,
              _sendTimeoutAt: new Date(
                Math.max(Date.now() + 1_000, entry.at + timeoutMs),
              ).toISOString(),
            };
            return applyTimelineIdentity(placeholder, identity);
          });
        if (!pending.length) return;
        for (const row of pending) {
          setPendingPreview(roomId, {
            clientId: row._clientId as string,
            text: outgoingPreviewText({
              type: row.type,
              content: row.content,
              reply_to_event_id: row.reply_to_event_id || undefined,
            }),
            status:
              row._status === "failed" || row._status === "challenge"
                ? "failed"
                : "waiting",
          });
        }
        setEvents((prev) =>
          mergeServerEvents(prev, pending, myUsername, timelineOwner, timelineDevice),
        );
        setLoading(false);
      }).catch(() => undefined);
      void loadStoredRoomEvents(cacheOwner, roomId, 100).then((stored) => {
        if (!mounted || stored.length === 0) return;
        durableCacheAvailable = true;
        setEvents((prev) =>
          mergeServerEvents(prev, stored, myUsername, timelineOwner, timelineDevice),
        );
        setLoading(false);
      });
    }
    loadTimelineWindow(roomId)
      .then(({ events: evs, hasMore, cursor, boundaryEventId }) => {
        if (!mounted) return;
        reportHistoryHealthy();
        setEvents((prev) => {
          // Loaded history is complete — mark final so it doesn't replay
          // "streaming…" on open (live deltas still arrive via WS). Reconcile
          // the full cached set so read/delivered ticks survive hydration.
          const finalized = evs.map((e) => ({ ...e, is_final: true }));
          return mergeServerEvents(
            prev,
            finalized,
            myUsername,
            timelineOwner,
            timelineDevice,
          );
        });
        setHasMore(hasMore);
        setHistoryCursor(cursor);
        setHistoryBoundaryEventId(boundaryEventId);
        setHydrated(true); // §2.5 — live data is in; auto-read may now run
        setLoading(false);
      })
      .catch((e) => {
        if (!mounted) return;
        reportHistoryFailure(e);
        if (!cachedEvents?.some(isTimelineEvent) && !durableCacheAvailable) {
          toast.error(e instanceof ApiError ? e.message : String(e));
        }
        setLoading(false);
      });
    return () => {
      mounted = false;
      clearReceiptTimer();
    };
  }, [
    room.room_id,
    myUsername,
    clearReceiptTimer,
    reportHistoryFailure,
    reportHistoryHealthy,
    timelineDevice,
    timelineOwner,
  ]);

  // The page-level worker owns retries even when the originating composer is
  // gone. Project each committed revision into the open room by rereading the
  // durable row; raw `lastError` text is deliberately never rendered.
  React.useEffect(() => {
    const syncOutboxState = (event: globalThis.Event) => {
      const detail = (event as CustomEvent<{ ownerId?: string; clientId?: string }>).detail;
      if (!detail?.ownerId || detail.ownerId !== carbon?.carbon_id || !detail.clientId) return;
      void listOutbox(detail.ownerId).then((rows) => {
        const row = rows.find(
          (candidate) =>
            candidate.clientId === detail.clientId && candidate.roomId === room.room_id,
        );
        if (!row) return;
        setEvents((current) =>
          current.map((item) =>
            item._clientId === row.clientId && item.event_id.startsWith("temp-")
              ? {
                  ...item,
                  _status: restoredOutboxStatus(
                    row.state,
                    row.attempts ?? 0,
                  ) as MessageStatus,
                  _failure: row.failure,
                  _nextAttemptAt: row.nextAttemptAt,
                }
              : item,
          ),
        );
      }).catch(() => undefined);
    };
    window.addEventListener(OUTBOX_RETRY_SCHEDULED_EVENT, syncOutboxState);
    return () =>
      window.removeEventListener(OUTBOX_RETRY_SCHEDULED_EVENT, syncOutboxState);
  }, [carbon?.carbon_id, room.room_id]);

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
    if (socketReady) socketSend({ type: "subscribe", room_id: room.room_id });
  }, [socketReady, room.room_id, socketSend]);

  // On reconnect, re-pull events for the open room — any frames delivered while
  // the socket was down (backend restart, tab asleep) are gone otherwise.
  const prevReadyRef = React.useRef(socketReady);
  React.useEffect(() => {
    if (socketReady && !prevReadyRef.current) {
      // Same window as the initial load — this effect also fires on the FIRST
      // connect of a fresh page load, so refetching a larger window here would
      // reflow the just-rendered list ("loads again a few seconds in"). A
      // PAGE_SIZE window merges near-identically and still recovers frames
      // missed during a short drop.
      loadTimelineWindow(room.room_id)
        .then(({ events: evs }) => {
          reportHistoryHealthy();
          setEvents((prev) =>
            mergeServerEvents(prev, evs, myUsername, timelineOwner, timelineDevice),
          );
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
        .catch((error) => reportHistoryFailure(error));
    }
    prevReadyRef.current = socketReady;
  }, [
    socketReady,
    room.room_id,
    myUsername,
    reportHistoryFailure,
    reportHistoryHealthy,
    timelineDevice,
    timelineOwner,
  ]);

  const applyHeldSendFrameRef = React.useRef<(held: HeldSend) => void>(() => undefined);
  const heldAckRef = React.useRef<(clientId: string, real: Event) => void>(() => undefined);
  const heldClientBySentEventRef = React.useRef(new Map<string, string>());
  const recentServerEventRef = React.useRef(new Map<string, Event>());
  const applyHeldSendFrame = (held: HeldSend) => {
    if (held.room_id !== room.room_id) return;
    const clientId = held.client_id;
    if (!clientId) return;
    const ownsDevice = heldSendBelongsToDevice(held, timelineDevice);
    const projectionKey = heldSendProjectionKey(held, timelineDevice);
    const matchesProjection = (event: LocalEvent) =>
      event._heldSendId === held.held_send_id ||
      (ownsDevice &&
        event._clientId === clientId &&
        event._originDevice === timelineDevice);
    const uiState = heldSendUiState(held);
    const failure = sendFailureFromHeld(held);
    const challengeUsable = heldChallengeUsableOnDevice(held, timelineDevice);
    if (challengeUsable && carbon?.carbon_id) {
      const challenge = challengeFromErrorBody({
        code: "challenge_required",
        challenge: held.challenge,
      });
      if (challenge) void rememberAbuseChallenge(carbon.carbon_id, challenge);
    }
    if (uiState === "cancelled") {
      if (ownsDevice) {
        clearHeldClientRef.current?.(clientId);
        clearPendingPreview(room.room_id, clientId);
      }
      setEvents((prev) => prev.filter((event) => !matchesProjection(event)));
      return;
    }
    if (uiState === "sent") {
      if (ownsDevice) {
        clearHeldClientRef.current?.(clientId);
        clearPendingPreview(room.room_id, clientId);
        if (held.sent_event_id) {
          const accepted = events.find((event) => event.event_id === held.sent_event_id)
            ?? recentServerEventRef.current.get(held.sent_event_id);
          if (accepted) {
            heldClientBySentEventRef.current.delete(held.sent_event_id);
            heldAckRef.current(clientId, accepted);
            return;
          }
          heldClientBySentEventRef.current.set(held.sent_event_id, clientId);
        }
      }
      setEvents((prev) =>
        ownsDevice
          ? prev.map((event) =>
              matchesProjection(event)
                ? { ...event, _status: "sent" as MessageStatus }
                : event,
            )
          : prev.filter((event) => !matchesProjection(event)),
      );
      return;
    }
    if (uiState === "failed" || uiState === "challenge") {
      // Stop composer-owned timers, but retain/project the server-owned body so
      // a reload never hides an attention-state held send.
      if (ownsDevice) {
        clearHeldClientRef.current?.(clientId);
        failPendingPreview(room.room_id, clientId);
      }
    }
    if (!myUsername) return;
    const body = typeof held.content.body === "string" ? held.content.body : "";
    const status: MessageStatus =
      uiState === "failed"
        ? "failed"
        : uiState === "challenge"
          ? "challenge"
          : uiState === "retry_wait"
            ? "retry_wait"
            : uiState === "retrying"
              ? "retrying"
              : "pending";
    const nextAttemptAtValue = held.next_attempt_at
      ? Date.parse(held.next_attempt_at)
      : Number.NaN;
    const nextAttemptAt = Number.isFinite(nextAttemptAtValue)
      ? nextAttemptAtValue
      : failure?.nextAttemptAt;
    setEvents((prev) => {
      const existingIndex = prev.findIndex(matchesProjection);
      if (existingIndex >= 0) {
        const existing = prev[existingIndex];
        const currentReleaseAt =
          typeof existing.content.hold_release_at === "string"
            ? existing.content.hold_release_at
            : null;
        const currentDeadline = currentReleaseAt ? Date.parse(currentReleaseAt) : Number.NaN;
        // Preserve a valid locally-anchored countdown. Only replace an absent
        // or visibly skewed deadline with a duration-based local projection.
        const preserveLocalDeadline =
          status === "pending" &&
          Number.isFinite(currentDeadline) &&
          currentDeadline <= Date.now() + MAX_EXTENDED_HELD_SEND_MS;
        const next = [...prev];
        next[existingIndex] = {
          ...existing,
          type: held.type,
          content: {
            ...held.content,
            client_id: held.client_id,
            hold_release_at: preserveLocalDeadline
              ? currentReleaseAt
              : localHeldReleaseAt(held),
          },
          reply_to_event_id: held.reply_to_event_id || "",
          _status: status,
          _failure: failure ?? undefined,
          _nextAttemptAt: nextAttemptAt,
          _heldSendId: held.held_send_id,
          _heldVersion: held.version,
          _heldChallengeDeviceMismatch: uiState === "challenge" && !challengeUsable,
        };
        return next;
      }
      const pendingBase: LocalEvent = {
        event_id: `temp-${projectionKey}`,
        room: 0,
        sender_kind: "carbon",
        sender_id: null,
        sender_handle: myUsername,
        type: held.type,
        content: {
          ...held.content,
          body,
          client_id: held.client_id,
          hold_release_at: localHeldReleaseAt(held),
        },
        reply_to_event_id: held.reply_to_event_id || "",
        is_final: true,
        created_at: held.created_at || new Date().toISOString(),
        edited_at: null,
        redacted_at: null,
        redaction_reason: "",
        _status: status,
        _clientId: projectionKey,
        _failure: failure ?? undefined,
        _nextAttemptAt: nextAttemptAt,
        _heldSendId: held.held_send_id,
        _heldVersion: held.version,
        _heldChallengeDeviceMismatch: uiState === "challenge" && !challengeUsable,
      };
      const identity =
        readTimelineIdentity(timelineOwner, projectionKey) ??
        ensureTimelineIdentitySync(
          timelineOwner,
          projectionKey,
          held.device_id || timelineDevice,
          Number.isFinite(Date.parse(held.created_at))
            ? Date.parse(held.created_at)
            : Date.now(),
        );
      const pending = applyTimelineIdentity(pendingBase, identity);
      return [...prev, pending];
    });
    if (ownsDevice) {
      setPendingPreview(room.room_id, {
        clientId,
        text: body || "Message pending",
        status: uiState === "failed" || uiState === "challenge" ? "failed" : "waiting",
      });
    }
  };
  React.useEffect(() => {
    applyHeldSendFrameRef.current = applyHeldSendFrame;
  });

  React.useEffect(() => {
    const releaseSolvedHeldChallenges = () => {
      void api.heldSends(room.room_id).then(async ({ held_sends }) => {
        const candidates = held_sends.filter(
          (held) =>
            held.state === "challenge" &&
            heldSendBelongsToDevice(held, timelineDevice),
        );
        for (const held of candidates) {
          const released = await api.sendHeldNow(room.room_id, held.held_send_id);
          applyHeldSendFrame(released);
        }
      }).catch(() => undefined);
    };
    window.addEventListener(
      ABUSE_CHALLENGE_SOLVED_EVENT,
      releaseSolvedHeldChallenges,
    );
    return () =>
      window.removeEventListener(
        ABUSE_CHALLENGE_SOLVED_EVENT,
        releaseSolvedHeldChallenges,
      );
  // applyHeldSendFrame is render-local and intentionally reads current room UI.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.room_id, timelineDevice]);

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
      // Count genuinely new incoming messages while the user is reading
      // history. Existing-event updates (edits/finalization) do not badge.
      if (!updatesExisting && !mine && PROGRESS_MESSAGE_TYPES.has(incoming.type) && !stickToBottomRef.current) {
        setUnseenBelow((count) => count + 1);
      }
      // The received tone is played once, globally, by the chat page (so it
      // fires for any room, not just the open one).
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
      recentServerEventRef.current.set(merged.event_id, merged);
      if (recentServerEventRef.current.size > 256) {
        const oldest = recentServerEventRef.current.keys().next().value;
        if (oldest) recentServerEventRef.current.delete(oldest);
      }
      const heldClientId = heldClientBySentEventRef.current.get(merged.event_id);
      if (heldClientId) {
        heldClientBySentEventRef.current.delete(merged.event_id);
        heldAckRef.current(heldClientId, merged);
        return;
      }
      setEvents((prev) => {
        // A generic socket frame may bind only through Glass' top-level,
        // device-scoped transaction_id. Never infer identity from
        // content.client_id or content equality: both collide across devices.
        return mergeServerEvents(
          prev,
          [merged],
          myUsername,
          timelineOwner,
          timelineDevice,
        );
      });
    } else if (f.type === "delivery_receipt") {
      if (!f.member_handle || f.member_handle !== myUsername) {
        const delivered = new Set(f.event_ids);
        const receipt = activityReceiptFromDeliveries(f.deliveries);
        setEvents((prev) =>
          prev.map((event) => {
            if (!delivered.has(event.event_id) || event.sender_handle !== myUsername) {
              return event;
            }
            const incomingSummary = f.deliveries?.[event.event_id];
            const summary = incomingSummary
              ? normalizeDeliveryObject(incomingSummary)
              : normalizeDeliverySummary(
                  event.delivery?.recipient_count ?? 1,
                  Math.max(event.delivery?.delivered_count ?? 0, 1),
                  event.delivery?.read_count ?? 0,
                );
            const status = summary.state;
            return {
              ...event,
              delivery: summary,
              _status: bestStatus(event._status, status),
            };
          }),
        );
        if (receipt && activeProgress?.receipt) showReceipt(receipt);
      }
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
      const receipt = activityReceiptFromDeliveries(f.deliveries);
      setEvents((prev) => {
        const cutoffIdx = prev.findIndex((e) => e.event_id === f.event_id);
        let changed = false;
        const updated = prev.map((e, i) => {
          const incomingSummary = f.deliveries?.[e.event_id];
          const covered = incomingSummary != null || (cutoffIdx >= 0 && i <= cutoffIdx);
          if (covered && e.sender_handle === myUsername && e._status !== "read") {
            const summary = incomingSummary
              ? normalizeDeliveryObject(incomingSummary)
              : normalizeDeliverySummary(
                  e.delivery?.recipient_count ?? 1,
                  e.delivery?.delivered_count ?? 0,
                  Math.max(e.delivery?.read_count ?? 0, 1),
                );
            const status = summary.state;
            changed = true;
            return {
              ...e,
              delivery: summary,
              _status: bestStatus(e._status, status),
            };
          }
          return e;
        });
        return changed ? updated : prev;
      });
      // My just-sent message got read → upgrade the receipt line ("read"),
      // which restarts the brief hold before the real progress shows.
      if (receipt && activeProgress?.receipt) showReceipt(receipt);
    } else if (f.type === "thread_read_receipt") {
      if (f.member_handle && f.member_handle === myUsername) {
        return;
      }
      setEvents((previous) => {
        let changed = false;
        const next = previous.map((event) => {
          const incoming = f.deliveries?.[event.event_id];
          if (!incoming || event.sender_handle !== myUsername) return event;
          const summary = normalizeDeliveryObject(incoming);
          changed = true;
          return {
            ...event,
            delivery: summary,
            _status: bestStatus(event._status, summary.state),
          };
        });
        return changed ? next : previous;
      });
    } else if (f.type === "take_back") {
      setEvents((prev) => {
        const result = projectRedactedWindow(
          prev,
          f.event_ids,
          new Date().toISOString(),
          "redacted",
        );
        result.mediaIds.forEach(evictCachedMedia);
        if (result.changed.length > 0) {
          void storeEvents(
            timelineOwner,
            result.changed.map((event) => ({ roomId: room.room_id, event })),
          ).catch(reportHistoryFailure);
        }
        return result.events;
      });
      for (const eventId of f.event_ids) {
        removeNotificationByEvent(timelineOwner, eventId);
        closeBrowserNotification(eventId);
      }
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
            ? handleFor(f.member_kind)
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
    return socketSubscribe((f) => frameHandlerRef.current(f));
  }, [socketSubscribe]);

  // §1.1 — while a progress line is showing, advance a 1s tick so we can detect
  // staleness (the silicon crashed / backend restarted with no `done` frame).
  React.useEffect(() => {
    if (!activeProgress) return;
    const id = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeProgress]);

  // ----- Scroll + auto-read -----
  // Opening a room consumes the room's current unread tail immediately. Later
  // arrivals still require actual viewport exposure before advancing read.
  const committedReadPositionRef = React.useRef(room.unread_boundary.last_read_stream_position);
  const pendingReadPositionRef = React.useRef(0);
  const openedReadRoomRef = React.useRef<string | null>(null);
  const commitReadPosition = React.useCallback((
    eventId: string | null,
    streamPosition: number,
    forceLocal = false,
  ) => {
    if (readOnly || !Number.isSafeInteger(streamPosition)) return;
    if (!forceLocal && streamPosition <= Math.max(
      committedReadPositionRef.current,
      pendingReadPositionRef.current,
    )) return;
    pendingReadPositionRef.current = Math.max(pendingReadPositionRef.current, streamPosition);
    // Reading is a local fact as soon as the room/viewport exposes the event.
    // Do not leave the sidebar badge waiting on network round-trip latency.
    onReadThrough?.(eventId ?? "", streamPosition);
    if (!eventId) {
      committedReadPositionRef.current = Math.max(
        committedReadPositionRef.current,
        streamPosition,
      );
      if (pendingReadPositionRef.current === streamPosition) pendingReadPositionRef.current = 0;
      return;
    }
    void api.read(room.room_id, eventId).then(() => {
      committedReadPositionRef.current = Math.max(
        committedReadPositionRef.current,
        streamPosition,
      );
      if (pendingReadPositionRef.current === streamPosition) pendingReadPositionRef.current = 0;
    }).catch(() => {
      if (pendingReadPositionRef.current === streamPosition) pendingReadPositionRef.current = 0;
    });
  }, [onReadThrough, readOnly, room.room_id]);

  const commitReadTarget = React.useCallback((target: Event) => {
    if (!hasAuthoritativeEventId(target) || !Number.isSafeInteger(target.stream_position)) return;
    commitReadPosition(target.event_id, Number(target.stream_position));
  }, [commitReadPosition]);

  React.useLayoutEffect(() => {
    if (openedReadRoomRef.current === room.room_id || readOnly) return;
    openedReadRoomRef.current = room.room_id;
    const target = roomOpenReadTarget(room);
    if (target) commitReadPosition(target.eventId, target.streamPosition, true);
  }, [commitReadPosition, readOnly, room]);

  const markVisibleRead = React.useCallback(() => {
    if (readOnly || !hydrated) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const viewport = scroller.getBoundingClientRect();
    const candidates: Array<{ event: Event; top: number; bottom: number; height: number }> = [];
    for (const event of events) {
      if (
        !hasAuthoritativeEventId(event) ||
        !isUnreadEligibleEvent(event)
      ) continue;
      const node = messageNodeRefs.current.get(event.event_id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      candidates.push({ event, top: rect.top, bottom: rect.bottom, height: rect.height });
    }
    const target = selectVisibleReadTarget(
      candidates,
      viewport,
      myUsername,
      Math.max(committedReadPositionRef.current, pendingReadPositionRef.current),
    );
    if (!target) return;
    commitReadTarget(target);
  }, [commitReadTarget, events, hydrated, myUsername, readOnly]);

  React.useEffect(() => {
    const run = () => requestAnimationFrame(markVisibleRead);
    run();
    window.addEventListener("focus", run);
    window.addEventListener("resize", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.removeEventListener("focus", run);
      window.removeEventListener("resize", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [markVisibleRead]);

  // ----- Take-back / self-delete / react / reply / forward -----
  const onTakeBack = async (eventId: string, force = false) => {
    if (!eventId || eventId.startsWith("temp-")) return;
    try {
      const r = await api.takeBack(eventId, "manual", force);
      if (r && "detail" in r) toast.error(r.detail);
      else toast.success("took back");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const copyEventToComposer = React.useCallback((event: Event, attachments: Event[] = []) => {
    const content = event.content as Record<string, unknown>;
    const text =
      event.type === "m.text"
        ? String(content.body ?? "")
        : event.type === "m.image" || event.type === "m.file"
          ? String(content.caption ?? "")
          : event.type === "m.voice"
            ? String(content.transcript ?? "")
            : "";
    const mediaEvents =
      event.type === "m.image" || event.type === "m.file"
        ? [event, ...attachments]
        : attachments;
    const copiedAttachments = mediaEvents
      .map((item) => {
        const itemContent = item.content as Record<string, unknown>;
        const mediaId = typeof itemContent.media_id === "string" ? itemContent.media_id : "";
        if (!mediaId) return null;
        return {
          mediaId,
          mime: String(itemContent.mime || item.media_meta?.mime || "application/octet-stream"),
          name: String(
            itemContent.filename || itemContent.caption || item.type.replace("m.", "") || "attachment",
          ),
          size: typeof itemContent.size === "number" ? itemContent.size : 0,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    setComposerCopy({
      id: `${event.event_id}:${Date.now()}`,
      text,
      attachments: copiedAttachments,
    });
  }, []);

  // A redaction can collapse a large row to a tiny tombstone. Virtuoso learns
  // that new height on the next measurement pass; if the reader was already at
  // the bottom, settle only after that pass so the viewport never flashes at a
  // stale offset. Readers scrolled into history are left exactly where they are.
  const settleTimelineAfterUnsend = React.useCallback(() => {
    if (!stickToBottomRef.current || textSelectionActiveRef.current) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!stickToBottomRef.current || textSelectionActiveRef.current) return;
        virtuosoRef.current?.autoscrollToBottom();
      });
    });
  }, []);

  // Unsend is two-step for persisted events: clicking stages the target and
  // the confirm dialog performs backend redaction. Deleted content is never
  // copied back into the draft/composer.
  const [pendingDelete, setPendingDelete] = React.useState<PendingUnsend | null>(null);
  const onSelfDelete = async (ev: Event, attachments: Event[] = []) => {
    // A held/optimistic message that never reached the server: cancel the
    // queued send and drop the bubble — nothing to redact, no confirm needed.
    const clientId = (ev as LocalEvent)._clientId;
    if (ev.event_id.startsWith("temp-") && clientId) {
      const cancel = cancelQueuedRef.current;
      if (!cancel) return;
      const previousStatus = (ev as LocalEvent)._status;
      setEvents((prev) =>
        prev.map((event) =>
          event._clientId === clientId
            ? { ...event, _status: "retrying" as MessageStatus }
            : event,
        ),
      );
      const result = await cancel(clientId);
      if (result === "not-held" || result === "failed") {
        setEvents((prev) =>
          prev.map((event) =>
            event._clientId === clientId
              ? { ...event, _status: previousStatus }
              : event,
          ),
        );
        return;
      }
      if (result === "sent") {
        // The server won the release race. Replace the temp row from
        // authoritative history instead of pretending the delete succeeded.
        void loadTimelineWindow(room.room_id).then(({ events: authoritative }) => {
          setEvents((prev) =>
            mergeServerEvents(
              prev,
              authoritative,
              myUsername,
              timelineOwner,
              timelineDevice,
            ),
          );
        }).catch(() => undefined);
        return;
      }
      if (result !== "cancelled") return;
      setHoldingMessage(false);
      setEditingEvent((cur) => (cur?.event_id === ev.event_id ? null : cur));
      setEvents((prev) => prev.filter((e) => e._clientId !== clientId));
      settleTimelineAfterUnsend();
      return;
    }
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
    const marker = new Date().toISOString();
    const targetIds = new Set(targets.map((target) => target.event_id));
    setEvents((prev) => projectRedactedWindow(prev, targetIds, marker, "unsend").events);
    settleTimelineAfterUnsend();
    const confirmed = new Set<string>();
    const rollbackUnconfirmed = () => {
      if (!snapshots.length) return;
      const byId = new Map(snapshots.map((item) => [item.event_id, item]));
      setEvents((prev) => prev.map((e) => {
        if (confirmed.has(e.event_id) || e.redacted_at !== marker) return e;
        return byId.get(e.event_id) ?? e;
      }));
      settleTimelineAfterUnsend();
    };
    try {
      for (const target of deleteTargets) {
        const r = await api.deleteEvent(target.event_id);
        if (r && "detail" in r) {
          rollbackUnconfirmed();
          toast.error(r.detail);
          return;
        }
        confirmed.add(target.event_id);
        const snapshot = snapshots.find((item) => item.event_id === target.event_id);
        if (snapshot) {
          const projected = projectRedactedEvent(snapshot, marker, "unsend");
          projected.mediaIds.forEach(evictCachedMedia);
          void storeEvents(timelineOwner, [{ roomId: room.room_id, event: projected.event }])
            .catch(reportHistoryFailure);
        }
        removeNotificationByEvent(timelineOwner, target.event_id);
        closeBrowserNotification(target.event_id);
      }
      toast.success("unsent");
    } catch (e) {
      rollbackUnconfirmed();
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const onReact = (ev: Event, rawEmoji: string) => {
    if (!hasAuthoritativeEventId(ev) || !myUsername) return;
    if (ev.event_id === latestVisibleEventId) requestBottomStick();
    const emoji = normalizeReactionEmoji(rawEmoji);
    const key = reactionIntentKey(ev.event_id, emoji);
    const desired = !ownReactionIsActive(
      events,
      ev.event_id,
      emoji,
      myUsername,
      reactionOverrides[key],
    );
    setReactionOverrides((previous) => ({ ...previous, [key]: desired }));

    const generation = (reactionGenerationRef.current.get(key) ?? 0) + 1;
    reactionGenerationRef.current.set(key, generation);
    const roomId = room.room_id;
    const clientId = desired ? newClientId() : undefined;
    const previous = reactionChainsRef.current.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const result = await retryReactionMutation(
          () => api.setReaction(ev.event_id, emoji, desired, clientId),
          {
            shouldRetry: (error) =>
              !(error instanceof ApiError) ||
              error.status === 408 ||
              error.status === 425 ||
              error.status === 429 ||
              error.status >= 500,
          },
        );
        if (reactionRoomRef.current !== roomId) return;
        setEvents((current) =>
          reconcileReactionResult(
            current, ev.event_id, emoji, myUsername, desired, result,
          ),
        );
        if (reactionGenerationRef.current.get(key) === generation) {
          setReactionOverrides((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        }
      })
      .catch((error) => {
        if (
          reactionRoomRef.current !== roomId ||
          reactionGenerationRef.current.get(key) !== generation
        ) return;
        setReactionOverrides((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        toast.error(error instanceof ApiError ? error.message : String(error));
      })
      .finally(() => {
        if (reactionChainsRef.current.get(key) === task) {
          reactionChainsRef.current.delete(key);
        }
      });
    reactionChainsRef.current.set(key, task);
  };

  const onReply = (ev: Event) => {
    if (!hasAuthoritativeEventId(ev)) return;
    setEditingEvent(null);
    updateReplyDraft(ev);
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
      return canEditAuthoritativeTimelineEvent(ev, {
        isMine: isMyEvent(ev, myUsername),
        roomIncludesSilicon,
        hasEditableText: editableTextForEvent(ev) !== null,
      });
    },
    [myUsername, roomIncludesSilicon],
  );

  const beginEdit = React.useCallback(
    (ev: Event) => {
      if (!canEditMessage(ev)) return;
      updateReplyDraft(null);
      setEditingEvent(ev);
    },
    [canEditMessage, setEditingEvent, updateReplyDraft],
  );

  const persistEdit = React.useCallback(
    async (ev: Event, body: string) => {
      if (!hasAuthoritativeEventId(ev)) {
        throw new Error("message is still pending and cannot be edited yet");
      }
      const editedAt = new Date().toISOString();
      const snapshot = events.find((item) => item.event_id === ev.event_id);
      setEvents((prev) =>
        prev.map((item) =>
          item.event_id === ev.event_id ? withEditedText(item, body, editedAt) : item,
        ),
      );
      try {
        const real = await api.editEvent(ev.event_id, body, ev.edit_version ?? 0);
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
        const authoritative = authoritativeEditConflict(e, ev.event_id);
        if (authoritative) {
          setEvents((prev) => prev.map((item) =>
            item.event_id === authoritative.event_id
              ? { ...authoritative, _clientId: item._clientId, _status: item._status }
              : item,
          ));
          // Keep the replacement text in the composer, but advance the base
          // snapshot so a deliberate retry compares against the current row.
          setEditingEvent(authoritative);
          toast.error("This message changed on another device. Your edit is still here; review and save again.");
        } else if (snapshot) {
          setEvents((prev) => prev.map((item) => (item.event_id === snapshot.event_id ? snapshot : item)));
          toast.error(e instanceof ApiError ? e.message : String(e));
        } else {
          toast.error(e instanceof ApiError ? e.message : String(e));
        }
        throw e;
      }
    },
    [events, setEditingEvent, setEvents],
  );

  // #17 — Forward picker. Setting `forwardingEvent` opens the dialog; the
  // dialog handles room selection and re-posting with forward_from metadata.
  const [forwardingEvent, setForwardingEvent] = React.useState<Event | null>(null);
  const onForward = (ev: Event) => {
    if (!hasAuthoritativeEventId(ev)) return;
    setForwardingEvent(ev);
  };

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
    if (!hasAuthoritativeEventId(ev)) return;
    setSelectMode(true);
    setSelectedEventIds(new Set([ev.event_id]));
  };
  const toggleSelect = (ev: Event) => {
    if (!hasAuthoritativeEventId(ev)) return;
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
    const map = aggregateReactions(events);
    if (myUsername) {
      for (const [key, desired] of Object.entries(reactionOverrides)) {
        const separator = key.indexOf("\u0000");
        if (separator < 1) continue;
        const target = key.slice(0, separator);
        const emoji = key.slice(separator + 1);
        const bucket = map.get(target) ?? {};
        const who = applyOwnReactionOverride(bucket[emoji] ?? [], myUsername, desired);
        if (who.length) bucket[emoji] = who;
        else delete bucket[emoji];
        if (Object.keys(bucket).length) map.set(target, bucket);
        else map.delete(target);
      }
    }
    return map;
  }, [events, myUsername, reactionOverrides]);

  // Visible events drop reactions (they render as chips under the target) and
  // deleted/redacted messages (hidden entirely — no "message deleted" row).
  // ALL progress events stay out of the timeline (live ones render as the
  // transient ProgressLine instead). Letting done-progress through used to
  // break the (sender, minute) run.
  const visibleEvents = events.filter(isTimelineEvent);

  const requestEditLast = () => {
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const event = visibleEvents[i];
      if (canEditMessage(event)) {
        beginEdit(event);
        return;
      }
    }
  };

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
        setReplyTo(null);
      }
      return;
    }
    const loaded = eventById.get(draftReply.event_id);
    if (replyTo?.event_id === draftReply.event_id) {
      // Reply state must follow edits/redaction from live sync. Holding the
      // original object would let a now-deleted target pass the composer's
      // pre-send guard and unnecessarily enter the failed outbox flow.
      const reconciled = reconcileReplyTarget(replyTo, loaded);
      if (reconciled !== replyTo) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile active reply to authoritative timeline state.
        setReplyTo(reconciled);
      }
      return;
    }
    if (loaded) {
      restoredDraftReplyIdRef.current = draftReply.event_id;
      setReplyTo(loaded);
      return;
    }
    const preview = draftReply.preview || "original message unavailable";
    restoredDraftReplyIdRef.current = draftReply.event_id;
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
        const loadedOldest = events.find((e) => !e.event_id.startsWith("temp-"))?.event_id;
        let cursor: string | undefined =
          priorState?.status === "continue" && priorState.cursor
            ? priorState.cursor
            : "";
        let anchor: string | undefined = cursor ? undefined : loadedOldest;
        let traversal: HistoryTraversal = {
          throughEventId:
            priorState?.status === "continue"
              ? priorState.throughEventId
              : undefined,
          seenEventIds: new Set<string>(),
          oldestEventId:
            priorState?.status === "continue"
              ? priorState.oldestEventId
              : anchor,
        };
        let found: Event | null = null;
        const seenCursors = new Set<string>();
        const deadline = Date.now() + 5000;
        let pages = 0;
        let recoveredExpiredCursor = false;
        let recoveredRejectedAnchor = false;
        while ((cursor !== undefined || anchor) && pages < 15 && Date.now() < deadline) {
          if (cursor && seenCursors.has(cursor)) {
            throw new SyncIntegrityError(
              "history",
              "page_invariant",
              "We couldn’t open that message. Try again.",
              { roomId: room.room_id },
            );
          }
          if (cursor) seenCursors.add(cursor);
          let page;
          try {
            page = await api.historyPage(
              room.room_id,
              cursor ?? "",
              PAGE_SIZE,
              "backward",
              cursor ? undefined : anchor,
            );
          } catch (error) {
            const code =
              error instanceof ApiError && error.body && typeof error.body === "object" &&
              "code" in error.body
                ? String((error.body as { code?: unknown }).code ?? "")
                : "";
            if (
              !recoveredRejectedAnchor &&
              !cursor &&
              anchor &&
              error instanceof ApiError &&
              error.status === 400
            ) {
              recoveredRejectedAnchor = true;
              anchor = undefined;
              traversal = {
                throughEventId: undefined,
                seenEventIds: new Set<string>(),
              };
              continue;
            }
            if (
              recoveredExpiredCursor ||
              !(error instanceof ApiError) ||
              error.status !== 410 ||
              code !== "cursor_expired"
            ) {
              throw error;
            }
            recoveredExpiredCursor = true;
            cursor = "";
            anchor = events.find((e) => !e.event_id.startsWith("temp-"))?.event_id;
            traversal = {
              throughEventId: undefined,
              seenEventIds: new Set<string>(),
              oldestEventId: anchor,
            };
            seenCursors.clear();
            continue;
          }
          if (runId !== lookupRunRef.current) return;
          pages += 1;
          traversal = validateHistoryPage(page, traversal, room.room_id);
          const older = page.events;
          if (older.length === 0 && !page.has_more) {
            setHasMore(false);
            cursor = undefined;
            break;
          }
          setEvents((prev) => {
            const finalized = older.map((event) => ({ ...event, is_final: true }));
            return mergeServerEvents(
              prev,
              finalized,
              myUsername,
              timelineOwner,
              timelineDevice,
            );
          });
          found = older.find((e) => e.event_id === eventId) ?? null;
          if (found) break;
          if (!page.has_more || !page.cursor) {
            setHasMore(false);
            cursor = undefined;
            break;
          }
          cursor = page.cursor;
          anchor = undefined;
        }
        reportHistoryHealthy();

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
                  throughEventId: traversal.throughEventId,
                  oldestEventId: traversal.oldestEventId,
                  message: "Still looking farther back. Click to continue.",
                }
              : { status: "error", message: "Couldn’t find the original message." },
          }));
        }
      } catch (e) {
        reportHistoryFailure(e);
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
    [
      eventById,
      events,
      myUsername,
      queueJumpToEvent,
      replyJumpState,
      room.room_id,
      timelineDevice,
      timelineOwner,
      reportHistoryFailure,
      reportHistoryHealthy,
    ],
  );

  // The studio hands off a flattened annotation set here: reply to the original
  // file message (so replies + the silicon have a clear reference) and stage the
  // draft into the composer for the user to add a message before sending.
  const onAttachAnnotations = React.useCallback(
    (draft: AnnotationDraft) => {
      const src = draft.sourceEventId ? eventById.get(draft.sourceEventId) : undefined;
      if (src) {
        updateReplyDraft(src);
      }
      setPendingAnnotationDraft(draft);
    },
    [eventById, setPendingAnnotationDraft, updateReplyDraft],
  );
  const onOpenAnnotation = React.useCallback((request: AnnotationOpenRequest) => {
    setAnnotationSource(request);
  }, [setAnnotationSource]);

  // ----- Optimistic send plumbing -----
  const onOptimisticAdd = React.useCallback(
    (
      clientId: string,
      payload: OptimisticPayload,
      options?: { timeoutMs?: number },
    ) => {
      if (!myUsername) return;
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const timeoutMs = options?.timeoutMs ?? sendTimeoutMs();
      const placeholderBase: LocalEvent = {
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
        _sendTimeoutMs: timeoutMs,
        _sendTimeoutAt: new Date(Date.now() + timeoutMs).toISOString(),
      };
      const identity = ensureTimelineIdentitySync(
        timelineOwner,
        clientId,
        timelineDevice,
        nowMs,
      );
      const placeholder = applyTimelineIdentity(placeholderBase, identity);
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
    [
      myUsername,
      room.room_id,
      requestBottomStick,
      timelineDevice,
      timelineOwner,
    ],
  );

  const onAck = React.useCallback((clientId: string, real: Event) => {
    requestBottomStick("smooth");
    // Sent — the sidebar's last_event will reflect it; drop the pending preview.
    clearPendingPreview(room.room_id, clientId);
    let identity = bindAcceptedTimelineEvent(timelineOwner, clientId, real);
    if (!identity) {
      identity = ensureTimelineIdentitySync(
        timelineOwner,
        clientId,
        timelineDevice,
        Date.now(),
      );
      identity = bindAcceptedTimelineEvent(timelineOwner, clientId, real) ?? identity;
    }
    const accepted = applyTimelineIdentity(real, identity, true) as LocalEvent;
    appendRoomEventSnippet(room.room_id, {
      ...accepted,
      _status: "sent",
    } as LocalEvent);
    playAckTick(); // §3b — the confirm half of "send → delivered"
    // A direct response is the one additional trusted binding source when an
    // older Glass server omits transaction_id. The reconciler collapses a WS
    // echo that raced ahead of this response into the original local row.
    setEvents((prev) =>
      mergeServerEvents(
        prev,
        [accepted],
        myUsername,
        timelineOwner,
        timelineDevice,
        clientId,
      ),
    );
    // Server acceptance is still waiting; a recipient receipt upgrades it.
    if (showsProgressForReplies && PROGRESS_MESSAGE_TYPES.has(real.type)) {
      showReceipt("waiting");
    }
  }, [
    showsProgressForReplies,
    showReceipt,
    room.room_id,
    myUsername,
    requestBottomStick,
    timelineDevice,
    timelineOwner,
  ]);

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
      const owner = authStore.getCarbon()?.carbon_id;
      if (owner) void persistOutboxFailure(owner, clientId, err).catch(() => false);
      const current = events.find((event) => event._clientId === clientId);
      const classified = classifySendFailure(err, {
        attempt: (current?._failure?.attempt ?? 0) + 1,
        now: Date.now(),
      });
      const challenge =
        err instanceof ApiError ? challengeFromErrorBody(err.body) : null;
      const status: "failed" | "resolving" | "retry_wait" | "challenge" = challenge
        ? "challenge"
        : isAmbiguousSendFailure(classified.failure.httpStatus)
            ? "resolving"
            : classified.phase === "blocked"
              ? "failed"
              : "retry_wait";
      const failureChangesVisibleState =
        !current ||
        statusAfterSendFailure(current._status, status, current.event_id) !== current._status;
      setEvents((prev) =>
        prev.map((event) =>
          event._clientId === clientId
            ? {
                ...event,
                _status: statusAfterSendFailure(
                  event._status,
                  status,
                  event.event_id,
                ) as MessageStatus | undefined,
                _failure: classified.failure,
                _nextAttemptAt: classified.failure.nextAttemptAt,
              }
            : event,
        ),
      );
      if ((status === "failed" || status === "challenge") && failureChangesVisibleState) {
        failPendingPreview(room.room_id, clientId);
      }
      setActiveProgress((prev) => (prev?.groupId === `local:${clientId}` ? null : prev));
      if (status === "failed" && failureChangesVisibleState) {
        toast.error(sendFailureMessage(classified.failure));
      }
    },
    [events, room.room_id],
  );

  // A lost response, stalled upload, dead worker, or sleeping tab must not
  // leave a bubble saying "sending" forever. Silence is ambiguous: the durable
  // outbox keeps automatic ownership, so the UI moves to retrying (never a
  // terminal manual-retry affordance) and wakes central recovery.
  React.useEffect(() => {
    const pending = events.filter(
      (event) => event._status === "pending" && Boolean(event._clientId),
    );
    if (pending.length === 0) return;

    const deadlineOf = (event: LocalEvent) => {
      const explicit = event._sendTimeoutAt
        ? Date.parse(event._sendTimeoutAt)
        : Number.NaN;
      if (Number.isFinite(explicit)) return explicit;
      const created = Date.parse(event.created_at);
      return (
        (Number.isFinite(created) ? created : Date.now()) +
        (event._sendTimeoutMs ?? sendTimeoutMs())
      );
    };
    const nextDeadline = Math.min(...pending.map(deadlineOf));
    const timer = window.setTimeout(() => {
      const now = Date.now();
      const expiredClientIds = new Set(
        pending
          .filter((event) => deadlineOf(event) <= now)
          .map((event) => event._clientId as string),
      );
      if (expiredClientIds.size === 0) return;
      setEvents((current) =>
        current.map((event) =>
          event._status === "pending" &&
          event._clientId &&
          expiredClientIds.has(event._clientId)
            ? {
                ...event,
                _status: statusAfterSendTimeout(event._status) as MessageStatus,
              }
            : event,
        ),
      );
      const owner = authStore.getCarbon()?.carbon_id;
      for (const clientId of expiredClientIds) {
        if (owner) wakeOutboxRecovery(owner, clientId);
      }
    }, Math.max(0, nextDeadline - Date.now()) + 25);
    return () => window.clearTimeout(timer);
  }, [events, room.room_id]);

  React.useEffect(() => {
    heldAckRef.current = onAck;
  }, [onAck]);

  React.useEffect(() => {
    let cancelled = false;
    const timers = new Set<number>();
    const heldById = new Map<string, HeldSend>();

    const schedule = (heldSendId: string, delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        void recover(heldSendId);
      }, Math.max(0, delay));
      timers.add(timer);
    };

    const projectSent = async (held: HeldSend): Promise<boolean> => {
      if (held.state !== "sent" || !held.sent_event_id) return false;
      const { events: recent } = await loadTimelineWindow(room.room_id);
      if (cancelled) return false;
      const event = eventForSentHeld(held, recent);
      if (!event) return false;
      heldAckRef.current(held.client_id, event);
      return true;
    };

    const recover = async (heldSendId: string) => {
      if (cancelled) return;
      try {
        const latest = await api.heldSends(room.room_id);
        if (cancelled) return;
        const held = latest.held_sends.find((item) => item.held_send_id === heldSendId);
        if (!held) {
          // The pending-list endpoint may stop returning a terminal hold before
          // its WS frame arrives. Resolve the *held_send* ledger (never POST an
          // event_send with the same client id: those are distinct namespaces),
          // then project only its exact sent_event_id.
          const known = heldById.get(heldSendId);
          if (!known) return;
          let terminal = known;
          if (terminal.state !== "sent") {
            const status = await api.clientOperation(
              room.room_id,
              "held_send",
              known.client_id,
            );
            const resolved = acceptedHeldSend(
              status,
              room.room_id,
              known.client_id,
              authStore.getBoundDeviceId(),
            );
            if (!resolved) return;
            terminal = resolved;
            heldById.set(heldSendId, terminal);
            applyHeldSendFrame(terminal);
          }
          if (terminal.state === "sent" && !(await projectSent(terminal))) {
            schedule(heldSendId, 1_000);
          }
          return;
        }
        heldById.set(held.held_send_id, held);
        applyHeldSendFrame(held);
        if (held.state === "sent") {
          if (!(await projectSent(held))) schedule(heldSendId, 1_000);
          return;
        }
        if (!heldSendMaySchedule(held)) return;
        if (held.state === "releasing") {
          schedule(heldSendId, 1_000);
          return;
        }
        // This recovery callback was already scheduled from the server's
        // relative hold duration. Do not compare its absolute timestamp to the
        // browser clock again or skew can add another minute here.
        const owner = authStore.getCarbon()?.carbon_id ?? null;
        const release = async (): Promise<HeldSend | null> => {
          if (owner && !(await maySendHeldOutbox(owner, held.client_id))) return null;
          return api.sendHeldNow(room.room_id, held.held_send_id);
        };
        const released = owner
          ? await withOutboxClientLock(owner, held.client_id, release)
          : await release();
        if (cancelled) return;
        if (!released) return;
        heldById.set(released.held_send_id, released);
        applyHeldSendFrame(released);
        if (released.state === "sent") {
          if (!(await projectSent(released))) schedule(heldSendId, 1_000);
        } else if (released.state === "releasing") {
          schedule(heldSendId, 1_000);
        }
      } catch {
        // The server ETA task + beat sweep remain authoritative. Retry once
        // this room is reopened rather than spinning while offline.
      }
    };

    void api.heldSends(room.room_id).then((res) => {
      if (cancelled) return;
      for (const held of res.held_sends) {
        heldById.set(held.held_send_id, held);
        applyHeldSendFrame(held);
        if (!heldSendMaySchedule(held)) continue;
        const serverHoldMs =
          Date.parse(heldSendDeadline(held)) -
          Date.parse(held.updated_at || held.created_at) +
          100;
        const delay = Number.isFinite(serverHoldMs)
          ? Math.min(
              HELD_SEND_RECOVERY_MAX_DELAY_MS,
              Math.max(0, serverHoldMs),
            )
          : 0;
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
      void (async () => {
        const owner = authStore.getCarbon()?.carbon_id;
        let preparedOperation: "event" | "held" | "media" = "event";
        try {
          if (owner) {
            const heldReleaseAt =
              typeof payload.content?.hold_release_at === "string"
                ? payload.content.hold_release_at
                : undefined;
            const prepared = await prepareManualOutboxRetry(owner, {
              roomId: room.room_id,
              clientId,
              operation: heldReleaseAt ? "held" : "event",
              type: payload.type,
              body: String(payload.content?.body ?? ""),
              content: payload.content ?? {},
              replyTo: payload.reply_to_event_id,
              releaseAt: heldReleaseAt,
              at: Number.isFinite(Date.parse(ev.created_at))
                ? Date.parse(ev.created_at)
                : Date.now(),
            });
            preparedOperation = prepared.operation ?? "event";
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "saved message could not be released");
          return;
        }

        // Only show a new pending attempt after the blocked row is durably
        // queued. A crash from this point is recoverable before any POST.
        setEvents((prev) =>
          prev.map((e) =>
            e._clientId === clientId
              ? {
                  ...e,
                  _status: "pending" as MessageStatus,
                  _sendTimeoutAt: new Date(
                    Date.now() + (e._sendTimeoutMs ?? sendTimeoutMs()),
                  ).toISOString(),
                }
              : e,
          ),
        );
        setPendingPreview(room.room_id, {
          clientId,
          text: outgoingPreviewText(payload),
          status: "waiting",
        });
        if (preparedOperation === "held" || preparedOperation === "media") {
          // prepareManualOutboxRetry woke the central durable flusher. It will
          // retry the operation-aware namespace and preserve held deadlines or
          // staged media; this UI must never reinterpret either as a plain POST.
          setEvents((prev) =>
            prev.map((event) =>
              event._clientId === clientId
                ? { ...event, _status: "retrying" as MessageStatus }
                : event,
            ),
          );
          return;
        }
        try {
          const real = await api.sendEvent(room.room_id, payload, clientId);
          // Authoritative acceptance updates UX first; local tombstone cleanup
          // is best-effort and cannot turn a sent message back into failure.
          onAck(clientId, real);
          if (owner) {
            void ackOutbox(owner, clientId, { roomId: room.room_id, event: real });
          }
        } catch (error) {
          onFail(clientId, error);
        }
      })();
    },
    [room.room_id, onAck, onFail],
  );

  const projectOutboxRevision = React.useCallback(
    (row: OutboxEntry, extraContent?: Record<string, unknown>) => {
      setEvents((current) =>
        current.map((item) =>
          item._clientId === row.clientId && item.event_id.startsWith("temp-")
            ? {
                ...item,
                type: (row.type ?? "m.text") as Event["type"],
                content:
                  row.type && row.type !== "m.text"
                    ? { ...(row.content ?? {}), ...(extraContent ?? {}) }
                    : { ...(row.content ?? {}), body: row.body, ...(extraContent ?? {}) },
                reply_to_event_id: row.replyTo ?? "",
                _status: restoredOutboxStatus(
                  row.state,
                  row.attempts ?? 0,
                ) as MessageStatus,
                _failure: row.failure,
                _nextAttemptAt: row.nextAttemptAt,
              }
            : item,
        ),
      );
      setPendingPreview(room.room_id, {
        clientId: row.clientId,
        text: outgoingPreviewText({
          type: (row.type ?? "m.text") as Event["type"],
          content:
            row.type && row.type !== "m.text"
              ? row.content
              : { ...(row.content ?? {}), body: row.body },
          reply_to_event_id: row.replyTo,
        }),
        status: row.state === "blocked" || row.state === "challenge" ? "failed" : "waiting",
      });
    },
    [room.room_id],
  );

  const releaseCorrection = React.useCallback(
    async (event: LocalEvent, action: CorrectionAction, patch: Parameters<typeof commitOutboxCorrection>[3] = {}) => {
      const owner = authStore.getCarbon()?.carbon_id;
      if (!owner || !event._clientId) throw new Error("The saved message is unavailable");
      const row = await commitOutboxCorrection(owner, event._clientId, action, {
        ...patch,
        state: "queued",
        nextAttemptAt: Date.now(),
        failure: undefined,
        challenge: undefined,
        lastError: undefined,
      });
      projectOutboxRevision(row);
      wakeOutboxRecovery(owner, row.clientId);
      return row;
    },
    [projectOutboxRevision],
  );

  const onCorrection = React.useCallback(
    (source: Event, action: CorrectionAction) => {
      const event = source as LocalEvent;
      const owner = authStore.getCarbon()?.carbon_id;
      const clientId = event._clientId;
      if (!owner || !clientId || !event.event_id.startsWith("temp-")) return;
      void (async () => {
        const durableRow = (await listOutbox(owner))
          .find((item) => item.clientId === clientId);
        if (!durableRow && event._heldSendId) {
          if (action === "discard_local") {
            const cancelled = await api.cancelHeldSend(room.room_id, event._heldSendId);
            applyHeldSendFrameRef.current(cancelled);
            return;
          }
          if (action === "remove_reply") {
            if (event._heldVersion == null) {
              throw new Error("The saved message version is unavailable");
            }
            const updated = await api.updateHeldSend(
              room.room_id,
              event._heldSendId,
              {
                base_version: event._heldVersion,
                reply_to_event_id: "",
              },
            );
            applyHeldSendFrameRef.current(updated);
            return;
          }
          if (action === "edit_message" || action === "review_input") {
            setPendingTextCorrection({
              event,
              action,
              text: String(event.content.body ?? ""),
            });
            return;
          }
          if (action === "copy_to_composer") {
            const text = String(event.content.body ?? event.content.caption ?? "");
            if (!(await setDraft(room.room_id, text))) {
              throw new Error("The composer copy could not be saved");
            }
            copyEventToComposer(event);
            toast.success("saved message copied to the composer");
            return;
          }
          if (action === "repair_session") {
            router.push("/auth/login?notice=session-expired");
            return;
          }
          if (action === "repair_device" && !(await ensureDeviceRegistration())) {
            toast.error("This device could not be repaired yet.");
            return;
          }
          if (action === "try_later" || action === "repair_device") {
            const released = await api.sendHeldNow(room.room_id, event._heldSendId);
            applyHeldSendFrameRef.current(released);
            return;
          }
          if (action === "request_access") {
            toast.info("Ask a room owner to restore your access. Your message stays saved here.");
            return;
          }
          if (action === "solve_challenge") {
            toast.info("Complete the verification panel on this device to release the saved message.");
            return;
          }
          if (action === "show_details" && event._failure) {
            toast.info(sendFailureMessage(event._failure));
            return;
          }
          throw new Error("That held-message correction is not available yet");
        }
        if (action === "discard_local") {
          const discarded = durableRow?.operation === "media"
            ? await discardMediaSend(owner, durableRow)
            : await discardOutbox(owner, clientId);
          if (!discarded) throw new Error("The discard could not be saved");
          clearPendingPreview(room.room_id, clientId);
          setEvents((current) => current.filter((item) => item._clientId !== clientId));
          return;
        }

        if (action === "remove_reply") {
          await releaseCorrection(event, action, { replyTo: undefined });
          return;
        }

        if (
          action === "try_later" ||
          action === "retry_transcription" ||
          action === "resume_upload"
        ) {
          await releaseCorrection(event, action);
          return;
        }

        if (action === "restart_upload") {
          const row = (await listOutbox(owner)).find((item) => item.clientId === clientId);
          if (!row?.media) throw new Error("The retained attachment is unavailable");
          const committed = await restartMediaUploadGeneration(owner, row);
          projectOutboxRevision(committed);
          wakeOutboxRecovery(owner, clientId);
          return;
        }

        // Marker-only actions still commit before opening another surface.
        await commitOutboxCorrection(owner, clientId, action);
        if (action === "edit_message" || action === "review_input") {
          setPendingTextCorrection({
            event,
            action,
            text: String(event.content.body ?? event.content.caption ?? ""),
          });
          return;
        }
        if (action === "replace_attachment") {
          setReplacementTarget(event);
          return;
        }
        if (action === "copy_to_composer") {
          const text = String(event.content.body ?? event.content.caption ?? "");
          if (!(await setDraft(room.room_id, text))) {
            throw new Error("The composer copy could not be saved");
          }
          copyEventToComposer(event);
          toast.success("saved message copied to the composer");
          return;
        }
        if (action === "repair_device") {
          if (await ensureDeviceRegistration()) {
            await releaseCorrection(event, action);
          } else {
            toast.error("This device could not be repaired yet.");
          }
          return;
        }
        if (action === "repair_session") {
          router.push("/auth/login?notice=session-expired");
          return;
        }
        if (action === "request_access") {
          toast.info("Ask a room owner to restore your access. Your message stays saved here.");
          return;
        }
        if (action === "upgrade_client") {
          toast.info("Update or reload this app, then return to release the saved message.");
          return;
        }
        if (action === "solve_challenge") {
          toast.info("Complete the verification panel to release this saved message.");
          return;
        }
        if (action === "show_details" && event._failure) {
          toast.info(sendFailureMessage(event._failure));
        }
      })().catch(() => {
        toast.error("That recovery action could not be saved. The message is still here.");
      });
    },
    [
      projectOutboxRevision,
      releaseCorrection,
      copyEventToComposer,
      room.room_id,
      router,
      setPendingTextCorrection,
      setReplacementTarget,
    ],
  );

  const confirmTextCorrection = React.useCallback(() => {
    const pending = pendingTextCorrection;
    if (!pending) return;
    void (async () => {
      const owner = authStore.getCarbon()?.carbon_id;
      const clientId = pending.event._clientId;
      if (!owner || !clientId) throw new Error("The saved message is unavailable");
      const current = (await listOutbox(owner)).find((row) => row.clientId === clientId);
      if (!current && pending.event._heldSendId && pending.event._heldVersion != null) {
        const content: Record<string, unknown> = {
          ...pending.event.content,
          body: pending.text,
          client_id: clientId,
        };
        delete content.hold_release_at;
        const updated = await api.updateHeldSend(
          room.room_id,
          pending.event._heldSendId,
          {
            base_version: pending.event._heldVersion,
            client_id: clientId,
            content,
          },
        );
        applyHeldSendFrameRef.current(updated);
        setPendingTextCorrection(null);
        return;
      }
      if (!current) throw new Error("The saved message is unavailable");
      const committed = await releaseCorrection(
        pending.event,
        pending.action,
        current.operation === "media" && current.media
          ? {
              body: pending.text,
              content: { ...(current.content ?? {}), caption: pending.text },
              media: {
                ...current.media,
                eventContent: {
                  ...(current.media.eventContent ?? {}),
                  caption: pending.text,
                },
              },
            }
          : {
              body: pending.text,
              content: { ...(current.content ?? {}), body: pending.text },
            },
      );
      projectOutboxRevision(committed);
      setPendingTextCorrection(null);
    })().catch(() => {
      toast.error("The edit could not be saved. The original message is still here.");
    });
  }, [
    pendingTextCorrection,
    projectOutboxRevision,
    releaseCorrection,
    room.room_id,
    setPendingTextCorrection,
  ]);

  const replaceAttachment = React.useCallback(
    (file: File | null) => {
      const event = replacementTarget;
      if (!event || !file) return;
      void (async () => {
        if (file.size <= 0) throw new Error("Choose a file that is not empty");
        const owner = authStore.getCarbon()?.carbon_id;
        const clientId = event._clientId;
        if (!owner || !clientId) throw new Error("The saved attachment is unavailable");
        const current = (await listOutbox(owner)).find((row) => row.clientId === clientId);
        if (!current?.media) throw new Error("The saved attachment is unavailable");
        const mime = file.type || "application/octet-stream";
        const kind = current.media.kind === "voice"
          ? "voice"
          : mime.startsWith("image/")
            ? "image"
            : "file";
        const committed = await replaceMediaOutboxSource(owner, current, {
          blob: file,
          filename: file.name,
          mime,
          kind,
        });
        projectOutboxRevision(committed, { local_url: URL.createObjectURL(file) });
        wakeOutboxRecovery(owner, clientId);
        setReplacementTarget(null);
      })().catch(() => {
        toast.error("The replacement could not be saved. The original attachment is still retained.");
      });
    },
    [projectOutboxRevision, replacementTarget, setReplacementTarget],
  );

  // Empty-room "Say Hi" — sends a plain "hi" using the optimistic send flow.
  const [sayingHi, setSayingHi] = React.useState(false);
  const sayHi = React.useCallback(async () => {
    if (sayingHi) return;
    setSayingHi(true);
    const clientId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c_${Date.now()}`;
    const payload: OptimisticPayload = { type: "m.text", content: { body: "hi" } };
    const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
    let optimisticAdded = false;
    try {
      if (outboxOwner) {
        await enqueueOutbox(outboxOwner, {
          roomId: room.room_id,
          clientId,
          body: "hi",
          content: payload.content,
          at: Date.now(),
        });
        onOptimisticAdd(clientId, payload);
        optimisticAdded = true;
      }
      const real = await api.sendEvent(room.room_id, payload, clientId);
      if (!optimisticAdded) {
        // Sessions without a local account namespace wait for authoritative
        // server acceptance before introducing a timeline row.
        onOptimisticAdd(clientId, payload);
      }
      onAck(clientId, real);
      if (outboxOwner) {
        void ackOutbox(outboxOwner, clientId, { roomId: room.room_id, event: real });
      }
    } catch (e) {
      if (optimisticAdded) onFail(clientId, e);
      else toast.error(e instanceof Error ? e.message : "Message couldn’t be saved");
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
      const outboxOwner = authStore.getCarbon()?.carbon_id ?? null;
      let optimisticAdded = false;
      try {
        if (outboxOwner) {
          await enqueueOutbox(outboxOwner, {
            roomId: room.room_id,
            clientId,
            body,
            replyTo: options?.replyToEventId,
            at: Date.now(),
          });
          onOptimisticAdd(clientId, payload);
          optimisticAdded = true;
        }
        const real = await api.sendEvent(room.room_id, payload, clientId);
        if (!optimisticAdded) onOptimisticAdd(clientId, payload);
        onAck(clientId, real);
        if (outboxOwner) {
          void ackOutbox(outboxOwner, clientId, { roomId: room.room_id, event: real });
        }
        track.messageSent({ room_id: room.room_id, message_type: "m.text", is_reply: Boolean(options?.replyToEventId) });
      } catch (e) {
        if (optimisticAdded) onFail(clientId, e);
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
    // Preserve the complete native drop batch and its OS-provided order. The
    // composer applies the shared attachment limit and stages every accepted
    // file through the same durable upload path as picker/paste attachments.
    setDroppedFiles(Array.from(e.dataTransfer.files));
  };

  // ----- Search filter -----
  const filteredEvents = (() => {
    // No active query (closed, or open-but-empty) → the normal loaded window.
    if (!search?.trim()) return visibleEvents;
    // Active query → server search results across the whole history, sorted
    // chronologically so the timeline (day bands, grouping) reads top→bottom.
    return ([...(searchResults ?? [])] as LocalEvent[]).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
  })();

  // Paint the durable local window immediately, then replace it with the
  // authoritative whole-history result when Glass responds.
  React.useEffect(() => {
    const q = search?.trim() ?? "";
    const generation = ++searchGenerationRef.current;
    let alive = true;
    if (!q) {
      searchCursorRef.current = null;
      queueMicrotask(() => {
        if (!alive || generation !== searchGenerationRef.current) return;
        setSearchResults(null);
        setSearchHasMore(false);
        setSearchLoading(false);
        setSearchNotice(null);
      });
      return () => {
        alive = false;
      };
    }
    searchCursorRef.current = null;
    queueMicrotask(() => {
      if (!alive || generation !== searchGenerationRef.current) return;
      setSearchResults(recentLocalSearch(events, q));
      setSearchHasMore(false);
      setSearchNotice(null);
      setSearchLoading(true);
    });
    const t = window.setTimeout(() => {
      api
        .search({ q, room: room.room_id, limit: SEARCH_INTERVAL })
        .then((r) => {
          if (!alive || generation !== searchGenerationRef.current) return;
          setSearchResults(r.results);
          setSearchHasMore(r.has_more);
          searchCursorRef.current = r.cursor;
          setSearchNotice(null);
        })
        .catch((error: unknown) => {
          if (!alive || generation !== searchGenerationRef.current) return;
          setSearchHasMore(false);
          searchCursorRef.current = null;
          if (error instanceof ApiError && error.status === 400) {
            setSearchResults([]);
            setSearchNotice("This search contains unsupported characters.");
          } else if (error instanceof ApiError && [429, 503].includes(error.status)) {
            setSearchNotice("Full-history search is temporarily busy. Recent saved matches remain available.");
          } else {
            setSearchNotice("Showing recent saved messages. Full-history search needs a connection.");
          }
        })
        .finally(() => {
          if (alive && generation === searchGenerationRef.current) setSearchLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // Search is intentionally restarted only for a new query/room. Live event
    // changes arrive in the next authoritative request and must not cause a
    // request storm while the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, room.room_id]);

  // Page through the signed keyset cursor. Repeating a cursor is harmless:
  // mergeSearchPage removes overlap by authoritative event identity.
  const loadMoreSearch = React.useCallback(async () => {
    const cursor = searchCursorRef.current;
    const generation = searchGenerationRef.current;
    if (!cursor || searchLoading || !searchHasMore) return;
    setSearchLoading(true);
    setSearchNotice(null);
    try {
      const r = await api.search({ cursor });
      if (generation !== searchGenerationRef.current) return;
      searchCursorRef.current = r.cursor;
      setSearchResults((prev) => mergeSearchPage(prev ?? [], r.results));
      setSearchHasMore(r.has_more);
    } catch (error: unknown) {
      if (generation !== searchGenerationRef.current) return;
      setSearchNotice(
        error instanceof ApiError && error.status === 410
          ? "This search expired. Reopen it to refresh the full result set."
          : "Could not load more results. Your current results are still available.",
      );
    } finally {
      if (generation === searchGenerationRef.current) setSearchLoading(false);
    }
  }, [searchLoading, searchHasMore]);
  // §2 — collapse attachment+text bundles: attachments sharing a `bundle_id`
  // with a text message are pinned onto that bubble instead of rendered as their
  // own rows. `displayRows` is the timeline minus those folded-in attachments;
  // `pinsByKey` maps the text bubble's render key to its attachment events.
  const { displayRows, pinsByKey } = React.useMemo(() => {
    const keyOf = (e: Event) => timelineRenderKey(e);
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
  // Freeze this anchor for the lifetime of the mounted room. Receipt refreshes
  // may advance the live boundary, but the visual divider must not jump while
  // the reader is paging. If the exact anchor was redacted, stream position is
  // the durable fallback.
  const [unreadBoundary] = React.useState(() => room.unread_boundary);
  const unreadDividerEventId = React.useMemo(
    () => selectUnreadDividerEventId(displayRows, unreadBoundary),
    [displayRows, unreadBoundary],
  );
  const cancelLatestHeld = () => {
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const event = visibleEvents[i] as LocalEvent;
      if (!isMyEvent(event, myUsername)) continue;
      if (!event.event_id.startsWith("temp-") || !event._clientId) continue;
      void onSelfDelete(event, pinsByKey.get(timelineRenderKey(event)) ?? []);
      return;
    }
  };
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
  // message's immutable local key is stable across the optimistic→server
  // swap, so identity beats timestamps here (wall-clock skew put the status
  // above the latest message). Record the newest message's key when a run
  // begins.
  const lastRowKey = displayRows.length
    ? timelineRenderKey(displayRows[displayRows.length - 1])
    : null;
  const [runAnchorKey, setRunAnchorKey] = React.useState<string | null>(null);
  // Capture the anchor ONCE, on the rising edge of "a run is active" — the
  // message that was latest when the silicon began working. Messages sent while
  // the run stays active must NOT move the anchor (a later message just creates
  // a new progress group-id); they fall below the status as a fresh turn.
  const runActiveNow = !search && shouldShowActiveProgress && !holdingMessage;
  const runAnchorGenerationRef = React.useRef(0);
  React.useEffect(() => {
    const generation = ++runAnchorGenerationRef.current;
    queueMicrotask(() => {
      if (runAnchorGenerationRef.current !== generation) return;
      if (!runActiveNow) {
        setRunAnchorKey(null);
        return;
      }
      setRunAnchorKey((prev) => prev ?? lastRowKey);
    });
    return () => {
      if (runAnchorGenerationRef.current === generation) {
        runAnchorGenerationRef.current += 1;
      }
    };
  }, [runActiveNow, lastRowKey]);

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
    const keyOf = (e: Row) => timelineRenderKey(e);
    const isSystem = (e: Row) => e.type === "m.system" || e.type === "m.session_marker";
    const partyOf = (e: Row): Party => (e.sender_kind === "silicon" ? "silicon" : "carbon");
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    };

    // Run anchors control progress placement only. Message rows always retain
    // Glass' chronological order; moving a late reply beside an older prompt
    // makes the newest message appear in the middle of the conversation.
    const present = new Set(displayRows.map((e) => e.event_id));
    const repliesByAnchor = new Map<string, Row[]>();
    for (const e of displayRows) {
      const anchor = e.run_anchor_event_id;
      if (e.sender_kind === "silicon" && anchor && present.has(anchor)) {
        const list = repliesByAnchor.get(anchor) ?? [];
        list.push(e);
        repliesByAnchor.set(anchor, list);
      }
    }
    const rows: Row[] = displayRows;

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
        const previous = cur?.events[cur.events.length - 1];
        if (!cur || cur.party !== p || !previous || !belongsToSameTimelinePanel(previous, e)) {
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
  React.useLayoutEffect(() => {
    timelineLengthRef.current = timelineItems.length;
  }, [timelineItems.length]);

  // Restore the exact event/pixel captured before a prepend. Stable keys alone
  // are insufficient when a page boundary merges two sender groups into one
  // virtual row, so the correction anchors to the actual event DOM node.
  React.useLayoutEffect(() => {
    const p = pendingPrependRef.current;
    if (p) {
      pendingPrependRef.current = null;
      const index = findVirtualAnchorIndex(
        timelineItems,
        p.eventId,
        (item) => item.kind === "panel"
          ? item.events.map((event) => event.event_id)
          : item.kind === "system"
            ? [item.event.event_id]
            : [],
      );
      if (index < 0) return;
      virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: "auto" });
      requestAnimationFrame(() => {
        const scroller = scrollerRef.current;
        const node = messageNodeRefs.current.get(p.eventId);
        if (!scroller || !node) return;
        const actual = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        virtuosoRef.current?.scrollBy({
          top: anchorPixelCorrection(actual, p.offset),
          behavior: "auto",
        });
      });
      return;
    }
    if (!textSelectionActiveRef.current && stickToBottomRef.current) {
      virtuosoRef.current?.autoscrollToBottom();
    }
  }, [timelineItems]);

  // Every room opens at the latest message. Repeating the snap across the first
  // few layout passes absorbs late font/media measurement without briefly
  // leaving the viewport stranded in the middle of the virtual list.
  const didInitialBottomRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!hydrated || timelineItems.length === 0) return;
    if (didInitialBottomRef.current === room.room_id) return;
    didInitialBottomRef.current = room.room_id;
    stickToBottomRef.current = true;
    const jump = () => {
      if (textSelectionActiveRef.current) return;
      const index = timelineLengthRef.current - 1;
      if (index >= 0) virtuosoRef.current?.scrollToIndex({ index, align: "end", behavior: "auto" });
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(jump));
    const timers = [80, 250, 600].map((ms) => window.setTimeout(jump, ms));
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [room.room_id, hydrated, timelineItems.length]);

  // Composer/reply/attachment banners resize the timeline viewport. Preserve
  // bottom-follow intent across those resizes; scrolling history disables it.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let height = scroller.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextHeight = scroller.clientHeight;
      if (nextHeight === height) return;
      height = nextHeight;
      if (stickToBottomRef.current && !textSelectionActiveRef.current) {
        requestAnimationFrame(() => scrollToBottom("auto"));
      }
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [hydrated, room.room_id, scrollToBottom]);

  const updateTimelineBottomState = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 120;
    stickToBottomRef.current = atBottom;
    setTimelineAtBottom(atBottom);
    if (atBottom) setUnseenBelow(0);
  }, []);

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
      if (!allowDraftNavigation(room.room_id)) return;
      setProfileOpen(false);
      setFocusSender(null);
      router.push(`/chat?room=${encodeURIComponent(destination.room_id)}`);
    },
    [allRooms, room.room_id, router],
  );

  // §2.7 — load the previous page of history (the API supports a `before`
  // cursor). Prepends older events; Virtuoso's firstItemIndex keeps the
  // viewport anchored (see the prepend effect above).
  const loadOlder = React.useCallback(async () => {
    if (loadingOlderRef.current || !hasMore) return;
    if (!historyCursor) return;
    if (!historyBoundaryEventId) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const requestedRoomId = room.room_id;
    try {
      const knownEventIds = new Set(
        events
          .filter((event) => !event.event_id.startsWith("temp-"))
          .map((event) => event.event_id),
      );
      let result: Awaited<ReturnType<typeof loadTimelineWindow>>;
      try {
        result = await loadTimelineWindow(
          room.room_id,
          historyCursor,
          undefined,
          historyBoundaryEventId,
          knownEventIds,
        );
      } catch (error) {
        const code =
          error instanceof ApiError && error.body && typeof error.body === "object" &&
          "code" in error.body
            ? String((error.body as { code?: unknown }).code ?? "")
            : "";
        if (!(error instanceof ApiError) || error.status !== 410 || code !== "cursor_expired") {
          throw error;
        }
        try {
          // A cursor TTL expiry is not a global retention gap. Restart this
          // room traversal immediately before the cursor's proven boundary,
          // without touching drafts, outbox, media, or sync cursors.
          result = await loadTimelineWindow(
            room.room_id,
            null,
            historyBoundaryEventId,
            undefined,
            knownEventIds,
          );
        } catch (anchorError) {
          if (!(anchorError instanceof ApiError) || anchorError.status !== 400) {
            throw anchorError;
          }
          // The anchor may have been redacted or access-filtered since it was
          // cached. Re-establish a fresh fixed traversal; stable event IDs make
          // the overlap idempotent and the next scroll reaches older rows.
          result = await loadTimelineWindow(
            room.room_id,
            null,
            undefined,
            undefined,
            knownEventIds,
          );
        }
      }
      const {
        events: older,
        hasMore: olderHasMore,
        cursor: olderCursor,
        boundaryEventId: olderBoundaryEventId,
      } = result;
      // Preserve the native Range if this request began before selection.
      // Applying the prepend after selection clears is lossless and avoids a
      // virtual-row re-key underneath the browser.
      await waitForTextSelectionEnd();
      if (activeRoomIdRef.current !== requestedRoomId) return;
      if (older.length === 0) {
        setHasMore(false);
        setHistoryCursor(null);
        setHistoryBoundaryEventId(null);
        return;
      }
      // Snapshot scroll metrics right before the prepend so the layout effect
      // can restore the exact viewport (older messages add height ABOVE).
      const addsTimelineRows = hasNovelHistoryRows(older, knownEventIds, isTimelineEvent);
      const el = scrollerRef.current;
      if (el && addsTimelineRows) {
        const viewportTop = el.getBoundingClientRect().top;
        const anchor = [...messageNodeRefs.current.entries()]
          .map(([eventId, node]) => ({
            eventId,
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
          }))
          .filter((item) => item.bottom > viewportTop)
          .sort((a, b) => a.top - b.top)[0];
        pendingPrependRef.current = anchor
          ? { eventId: anchor.eventId, offset: anchor.top - viewportTop }
          : null;
      }
      setEvents((prev) => {
        const finalized = older.map((event) => ({ ...event, is_final: true }));
        return mergeServerEvents(
          prev,
          finalized,
          myUsername,
          timelineOwner,
          timelineDevice,
        );
      });
      setHasMore(olderHasMore);
      setHistoryCursor(olderCursor);
      setHistoryBoundaryEventId(olderBoundaryEventId);
      reportHistoryHealthy();
    } catch (e) {
      reportHistoryFailure(e);
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [
    hasMore,
    historyCursor,
    historyBoundaryEventId,
    events,
    room.room_id,
    myUsername,
    timelineDevice,
    timelineOwner,
    reportHistoryFailure,
    reportHistoryHealthy,
    waitForTextSelectionEnd,
  ]);

  // `rangeChanged` can fire while the initial live request is still resolving,
  // when `hasMore` is false. If the cursor then appears while the viewport is
  // already parked at the top, Virtuoso has no range transition left to emit.
  // Recheck that edge whenever pagination becomes ready.
  React.useEffect(() => {
    if (!hydrated || textSelectionActive || !hasMore || loadingOlderRef.current) return;
    const scroller = scrollerRef.current;
    if (scroller && scroller.scrollTop <= 160) void loadOlder();
  }, [hasMore, hydrated, historyCursor, loadOlder, textSelectionActive]);

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
            mentionTargets={messageMentionTargets}
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
            const authoritative = hasAuthoritativeEventId(e);
            return (
              <React.Fragment key={timelineRenderKey(e)}>
                {renderedId === unreadDividerEventId ? (
                  <div
                    ref={unreadDividerNodeRef}
                    data-unread-divider="true"
                    role="separator"
                    aria-label="Unread messages"
                    className="my-3 flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-primary"
                  >
                    <span className="h-px flex-1 bg-primary/50" />
                    <span>Unread messages</span>
                    <span className="h-px flex-1 bg-primary/50" />
                  </div>
                ) : null}
                <div
                  ref={(node) => {
                    if (node) messageNodeRefs.current.set(renderedId, node);
                    else messageNodeRefs.current.delete(renderedId);
                  }}
                  data-event-id={renderedId}
                  data-stream-position={e.stream_position}
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
                  failure={e._failure}
                  failureMessage={
                    e._heldChallengeDeviceMismatch
                      ? "continue on the original device"
                      : undefined
                  }
                  onCorrection={
                    readOnly || e._heldChallengeDeviceMismatch
                      ? undefined
                      : onCorrection
                  }
                  holdCountdownPaused={holdingMessage}
                  senderPhotoUrl={photoFor(e.sender_kind, e.sender_handle)}
                  senderAsciiUrl={asciiFor(e.sender_kind, e.sender_handle)}
                  senderAvatarKind={e.sender_kind}
                  senderDisplayName={displayNameFor(e.sender_kind, e.sender_handle)}
                  onSenderClick={openSenderProfile}
                  onTakeBack={readOnly || !authoritative ? undefined : onTakeBack}
                  showSender={!sameAs(prev)}
                  showTime={!sameAs(next)}
                  reactions={reactionsByTarget.get(e.event_id) ?? undefined}
                  onReply={readOnly || !authoritative ? undefined : onReply}
                  onReact={readOnly || !authoritative ? undefined : onReact}
                  onForward={readOnly || !authoritative ? undefined : onForward}
                  onReport={
                    !authoritative || isMyEvent(e, myUsername) ||
                    (e.sender_kind !== "carbon" && e.sender_kind !== "silicon") ||
                    !(e.sender_public_id || (e.sender_kind === "carbon" && e.sender_handle))
                      ? undefined
                      : (target) => {
                          setReportReason("spam");
                          setReportDetails("");
                          setReportTarget(target);
                        }
                  }
                  onSelect={readOnly || !authoritative ? undefined : onSelect}
                  onEdit={readOnly || !canEditMessage(e) ? undefined : beginEdit}
                  selectMode={selectMode}
                  selected={authoritative && selectedEventIds.has(e.event_id)}
                  onToggleSelect={readOnly || !authoritative ? undefined : toggleSelect}
                  onRetry={readOnly ? undefined : retrySend}
                  onDelete={
                    readOnly || !canUnsendMessage(e)
                      ? undefined
                      : (target) =>
                          void onSelfDelete(target, pinsByKey.get(timelineRenderKey(e)) ?? [])
                  }
                  pinnedAttachments={pinsByKey.get(timelineRenderKey(e))}
                  mentionTargets={messageMentionTargets}
                  onMentionClick={openSenderProfile}
                />
                </div>
              </React.Fragment>
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
      onClick={() => {
        if (!allowDraftNavigation(room.room_id)) return;
        router.push(`/chat?room=${encodeURIComponent(recordingRoomId)}`);
      }}
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
                : chatConnectionStatus
                  ? chatConnectionStatus
                  : (formatActivities(activities) ?? carbonPresenceLabel ?? display.subtitle)}
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
        {/* Browser — open (or join) this silicon's cloud browser, left of crons. */}
        {peer?.kind === "silicon" && search === null && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setBrowserOpen(true)}
            aria-label="open this silicon's browser"
            title="open this silicon's browser"
          >
            <SiliconBrowserMark className="h-4 w-4" />
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

      {peer?.kind === "silicon" && (
        <SiliconBrowserDialog
          siliconId={peer.id}
          siliconName={contact?.name ?? peer.name}
          open={browserOpen}
          onOpenChange={setBrowserOpen}
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
      <div
        className="relative flex min-h-0 min-w-0 flex-1"
        data-timeline-selection-active={textSelectionActive ? "true" : undefined}
      >
      {searching ? (
        // Search results are a small, bounded set — a plain scroll area is fine
        // (no virtualization needed).
        <ScrollArea ref={scrollRootRef} className="flex-1" data-private>
          <div className="w-full px-6 py-4">
            {searchNotice ? (
              <div
                role="status"
                aria-live="polite"
                className="mb-3 border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-[11px] text-muted-foreground"
              >
                {searchNotice}
              </div>
            ) : null}
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
        <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">Connecting…</div>
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
        <Virtuoso
          key={room.room_id}
          ref={virtuosoRef}
          data={timelineItems}
          computeItemKey={(_index, item) => item.key}
          defaultItemHeight={96}
          increaseViewportBy={timelineViewportPadding(textSelectionActive)}
          alignToBottom
          initialTopMostItemIndex={{ index: "LAST", align: "end" }}
          followOutput={(isAtBottom) => isAtBottom ? "auto" : false}
          atBottomThreshold={120}
          atBottomStateChange={(atBottom) => {
            if (atBottom) {
              stickToBottomRef.current = true;
              setTimelineAtBottom(true);
              setUnseenBelow(0);
            }
          }}
          rangeChanged={({ startIndex }) => {
            if (shouldLoadOlderDuringRangeChange({
              selectionActive: textSelectionActive,
              startIndex,
              hasMore,
              loadingOlder,
            })) {
              void loadOlder();
            }
            markVisibleRead();
          }}
          scrollerRef={(ref) => {
            scrollerRef.current = ref instanceof HTMLElement ? ref as HTMLDivElement : null;
          }}
          data-private
          className="min-h-0 min-w-0 flex-1"
          onScroll={() => {
            updateTimelineBottomState();
            markVisibleRead();
          }}
          components={{
            Header: () => <ChatListHeader loadingOlder={loadingOlder} />,
            Footer: () => (
              <>
                {holdingNode ? <div className="px-6">{holdingNode}</div> : null}
                <div className="h-4" />
              </>
            ),
          }}
          itemContent={(_index, item) => (
            <div className="px-6" style={{ display: "flow-root" }}>
              {renderTimelineItem(item)}
            </div>
          )}
        />
      )}

      {/* Keep the affordance mounted so both its entrance and exit ease. */}
      <div
        className={cn(
          "absolute bottom-4 right-6 z-10 transition-all duration-200 ease-out",
          !timelineAtBottom && !searching
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-2 scale-95 opacity-0",
        )}
      >
        <button
          type="button"
          onClick={() => {
            requestBottomStick("smooth");
          }}
          aria-label={unseenBelow > 0
            ? `go to bottom, ${unseenBelow} new ${unseenBelow === 1 ? "message" : "messages"}`
            : "go to bottom"}
          className="relative grid h-10 w-10 place-items-center border border-foreground bg-foreground text-background shadow-sm transition-transform duration-200 ease-out hover:-translate-y-0.5"
        >
          <ArrowDown className="h-4 w-4" weight="bold" />
          {unseenBelow > 0 ? (
            <span className="absolute -right-2 -top-2 grid min-h-5 min-w-5 place-items-center border border-background bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
              {unseenBelow > 99 ? "99+" : unseenBelow}
            </span>
          ) : null}
        </button>
      </div>
      </div>

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
          {!plaintextSendAllowed && (
            <div className="flex items-center justify-center gap-2 border-t border-input bg-muted/40 px-6 py-3 text-xs text-muted-foreground">
              <WarningCircle className="h-3.5 w-3.5 text-destructive" />
              <span>
                This private encrypted room needs a newer E2EE-capable client. Your draft stays
                saved here, but plaintext sending is disabled.
              </span>
            </div>
          )}
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
            droppedFiles={droppedFiles}
            onDroppedFilesConsumed={() => setDroppedFiles([])}
            pendingAnnotationDraft={pendingAnnotationDraft}
            onAnnotationDraftConsumed={() => setPendingAnnotationDraft(null)}
            replyTo={replyTo}
            onClearReply={() => updateReplyDraft(null)}
            delayTextForSilicon={room.kind === "direct" && peer?.kind === "silicon"}
            onHoldStateChange={setHoldingMessage}
            cancelQueuedRef={cancelQueuedRef}
            clearHeldClientRef={clearHeldClientRef}
            onHeldSendUpdate={(held) => applyHeldSendFrameRef.current(held)}
            mentionCandidates={mentionCandidates}
            editingEvent={editingEvent}
            onEditComplete={() => setEditingEvent(null)}
            onPersistedEdit={persistEdit}
            onRequestEditLast={requestEditLast}
            copyDraft={composerCopy}
            onComposerCopyConsumed={() => setComposerCopy(null)}
            onCancelHeldLast={cancelLatestHeld}
            sendDisabled={siliconUnavailable || !plaintextSendAllowed}
            sendDisabledReason={
              !plaintextSendAllowed
                ? "Update to an E2EE-capable client before sending in this private room."
                : "This silicon is not available right now."
            }
          />
        </>
      )}

      {/* Visual hint while a file is hovering over the chat surface. */}
      <DropOverlay visible={isDropTarget} />

      {annotationSource && (
        <AnnotationStudio
          key={`${annotationSource.roomId}:${annotationSource.sourceMediaId}`}
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
        open={!!reportTarget}
        onOpenChange={(open) => {
          if (!open && !reportSubmitting) setReportTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report this message?</DialogTitle>
            <DialogDescription>
              The message and its sender are attached as private evidence. They are not notified
              that you submitted the report.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">Reason</span>
            <select
              value={reportReason}
              onChange={(event) => setReportReason(event.target.value as ModerationReportReason)}
              disabled={reportSubmitting}
              className="w-full border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="spam">Spam</option>
              <option value="harassment">Harassment</option>
              <option value="inappropriate">Inappropriate content</option>
              <option value="other">Something else</option>
            </select>
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-medium">Details (optional)</span>
            <textarea
              value={reportDetails}
              onChange={(event) => setReportDetails(event.target.value.slice(0, 1000))}
              disabled={reportSubmitting}
              rows={4}
              maxLength={1000}
              placeholder="Tell the safety team what happened."
              className="w-full resize-y border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="block text-right text-xs text-muted-foreground">
              {reportDetails.length}/1000
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={reportSubmitting}
              onClick={() => setReportTarget(null)}
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reportSubmitting}
              onClick={() => void submitModerationReport()}
            >
              {reportSubmitting ? "saving report…" : "submit report"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingTextCorrection}
        onOpenChange={(open) => !open && setPendingTextCorrection(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fix saved message</DialogTitle>
            <DialogDescription>
              Your original stays saved until this corrected version commits to the same send.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            <span className="font-medium">Message</span>
            <textarea
              value={pendingTextCorrection?.text ?? ""}
              onChange={(event) =>
                setPendingTextCorrection((current) =>
                  current ? { ...current, text: event.target.value } : current,
                )
              }
              rows={5}
              autoFocus
              className="w-full resize-y border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingTextCorrection(null)}>
              cancel
            </Button>
            <Button onClick={confirmTextCorrection}>save and retry</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!replacementTarget}
        onOpenChange={(open) => !open && setReplacementTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace saved attachment</DialogTitle>
            <DialogDescription>
              The replacement is copied into protected browser storage before this send resumes.
            </DialogDescription>
          </DialogHeader>
          <input
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              event.currentTarget.value = "";
              replaceAttachment(file);
            }}
            className="block w-full border border-input bg-background p-2 text-sm file:mr-3 file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground"
          />
          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setReplacementTarget(null)}>
              cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsend message?</DialogTitle>
            <DialogDescription>
              This removes it for everyone. It won’t be copied back into your draft.
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
/* eslint-enable react-hooks/preserve-manual-memoization */

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
  // Activity matches the sidebar: clock while waiting, one tick when delivered,
  // and two ticks only when read.
  if (entry.receipt) {
    const presentation = messageReceiptPresentation(
      entry.receipt === "waiting" ? "sent" : entry.receipt,
    );
    const receiptIcon = presentation.visual === "read"
      ? <Checks className="h-4 w-4 text-[#1A1A1A]" weight="bold" aria-hidden />
      : presentation.visual === "delivered" || presentation.visual === "sent"
        ? <Check className="h-4 w-4" weight="bold" aria-hidden />
        : <Clock className="h-4 w-4 opacity-60" aria-hidden />;
    return (
      <div className="my-2 flex w-full items-center justify-start gap-2">
        <div className="w-7 shrink-0">
          <IdAvatar seed={avatarSeed || "?"} src={avatarSrc} size={28} family={avatarFamily ?? "silicon"} />
        </div>
        <div className="min-w-0 max-w-[70%]">
          <span className="silicon-activity-line flex min-h-7 items-center text-sm">
            <span className="inline-flex min-w-0 max-w-full items-center gap-3 overflow-hidden">
              <span
                className="inline-flex items-center gap-1.5"
                role="status"
                aria-label={presentation.label}
              >
                {receiptIcon}
                <span className="silicon-activity-copy">{presentation.label}</span>
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
  const [initialTick] = React.useState(() =>
    randomProgressTick(progressLineOptions(entry.state, entry.note).length, -1),
  );
  const tickRef = React.useRef(initialTick);
  const [typed, setTyped] = React.useState("");
  const typedRef = React.useRef("");
  const pendingTargetRef = React.useRef<string | null>(null);
  const [target, setTarget] = React.useState(() =>
    formatProgressLine(entry.state, entry.note, initialTick),
  );
  const targetRef = React.useRef(target);
  const [phase, setPhase] = React.useState<"typing" | "holding" | "erasing">("typing");
  const holdMsRef = React.useRef(6500);
  const typedDoneAtRef = React.useRef(0);
  const transitionGenerationRef = React.useRef(0);

  React.useEffect(() => {
    typedRef.current = typed;
  }, [typed]);

  React.useEffect(() => {
    targetRef.current = target;
  }, [target]);

  React.useEffect(() => {
    const generation = ++transitionGenerationRef.current;
    const nextTick = randomProgressTick(
      progressLineOptions(entry.state, entry.note).length,
      tickRef.current,
    );
    tickRef.current = nextTick;
    const next = formatProgressLine(entry.state, entry.note, nextTick);
    const currentTyped = typedRef.current;
    const currentTarget = targetRef.current;
    const currentComplete = currentTyped === currentTarget && currentTarget.length > 0;
    let transition: (() => void) | null = null;

    if (currentTyped === next) {
      pendingTargetRef.current = null;
    } else if (currentTyped) {
      pendingTargetRef.current = next;
      if (currentComplete) {
        const typedDoneAt = typedDoneAtRef.current || Date.now();
        const remainingHold = MIN_PROGRESS_STATUS_MS - (Date.now() - typedDoneAt);
        if (remainingHold > 0) {
          holdMsRef.current = remainingHold;
          transition = () => setPhase("holding");
        } else {
          transition = () => setPhase("erasing");
        }
      }
    } else {
      pendingTargetRef.current = null;
      typedDoneAtRef.current = 0;
      transition = () => {
        if (currentTarget !== next) setTarget(next);
        setTyped("");
        setPhase("typing");
      };
    }

    if (transition) {
      queueMicrotask(() => {
        if (transitionGenerationRef.current === generation) transition();
      });
    }
    return () => {
      if (transitionGenerationRef.current === generation) {
        transitionGenerationRef.current += 1;
      }
    };
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
      const nextTick = randomProgressTick(
        progressLineOptions(entry.state, entry.note).length,
        tickRef.current,
      );
      tickRef.current = nextTick;
      typedDoneAtRef.current = 0;
      setTarget(formatProgressLine(entry.state, entry.note, nextTick));
      setPhase("typing");
    }
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [phase, typed, target, entry.state, entry.note]);

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

function progressLineOptions(state: ProgressState, noteValue: string): string[] {
  // The actual flow: the silicon's note if it sent one, else the real state.
  const note = meaningfulProgressNote(noteValue, state);
  if (note) return [sentenceCase(note)];
  return [progressStateLabel(state)];
}

function randomProgressTick(length: number, previous: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (next === previous) {
    next = (next + 1 + Math.floor(Math.random() * (length - 1))) % length;
  }
  return next;
}

function formatProgressLine(state: ProgressState, note: string, tick = 0): string {
  const lines = progressLineOptions(state, note);
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
  ownerId: string,
  currentDevice: string | null,
  directClientId?: string,
): LocalEvent[] {
  const reconciled = reconcileTimelineEvents(prev, server, {
    ownerId,
    currentDevice,
    directClientId,
    merge: (existing, incoming) => {
      const mine = Boolean(incoming.sender_handle && incoming.sender_handle === myUsername);
      return {
        ...incoming,
        _status: mine
          ? bestStatus(existing._status, serverDeliveryStatus(incoming))
          : existing._status,
        _sendTimeoutAt: existing._sendTimeoutAt,
        _sendTimeoutMs: existing._sendTimeoutMs,
      };
    },
  });
  return reconciled.map((event) => {
    if (
      event._status == null &&
      hasAuthoritativeEventId(event) &&
      event.sender_handle &&
      event.sender_handle === myUsername
    ) {
      return { ...event, _status: serverDeliveryStatus(event) };
    }
    return event;
  });
}
