"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowDown, CaretLeft, Clock, Eye, MagnifyingGlass, Microphone, WarningCircle, X } from "@phosphor-icons/react/dist/ssr";
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
import { observePresenceActivity, presenceIsOnline } from "@/lib/presence-state";
import { authStore, useAuth } from "@/lib/auth";
import { roomDisplay } from "@/lib/peers";
import {
  siliconMaintenancePeers,
  siliconMaintenanceRoomMessage,
  siliconPeerProjectionSignature,
} from "@/lib/silicon-maintenance";
import { vibrate } from "@/lib/sounds";
import {
  shouldPromptNotifications,
  markNotificationsAsked,
  closeBrowserNotification,
  removeNotificationByEvent,
  requestBrowserNotifications,
} from "@/lib/notifications";
import { projectRedactedEvent, projectRedactedWindow } from "@/lib/redaction-state";
import type {
  AnnotationDraft,
  Event,
  EventType,
  HeldSend,
  ProgressState,
  Room,
  TeamMembership,
  WsFrame,
} from "@/lib/types";
import { clearRoomProgress, getRoomProgress } from "@/lib/progress-cache";
import { preserveCanonicalTimelineOrder } from "@/lib/run-anchored-timeline";
import { parseWorkTimelineRecord } from "@/lib/work-update-validation";
import {
  workEventCountsAsUnread,
  workEventPreview,
} from "@/lib/work-update-presentation";
import {
  createWorkUpdateState,
  reduceWorkTimelineRecord,
  type WorkUpdateState,
} from "@/lib/work-update-state";
import { dedupeWorkTimelineEnvelopes } from "@/lib/work-timeline-dedupe";
import type {
  ManagerActivityGroup,
  WorkTimelineRecord,
} from "@/lib/work-update-types";
import {
  getManagerActivityState,
  recordManagerActivity,
  settleCachedManagerActivity,
  visibleCachedManagerActivities,
} from "@/lib/work-manager-activity-cache";
import {
  eventReplacesManagerActivity,
  MANAGER_ACTIVITY_STALE_MS,
  managerActivityReplacementEvent,
  placeManagerActivityGroups,
  presentedManagerActivityGroups,
  publicManagerActivityNote,
} from "@/lib/work-manager-activity";
import {
  appendRoomEventSnippet,
  readRoomEventSnippet,
  saveRoomEventSnippet,
} from "@/lib/room-snippet";
import {
  reconcileRoomTailProjection,
  seedTimelineWithRoomTail,
} from "@/lib/room-tail-projection";
import {
  setPendingPreview,
  updatePendingPreview,
  clearPendingPreview,
  failPendingPreview,
  markPendingPreviewAccepted,
} from "@/lib/pending-preview";
import { track } from "@/lib/analytics";
import {
  ackOutbox,
  cancelPendingOutbox,
  commitOutboxCorrection,
  discardOutbox,
  enqueueOutbox,
  listOutbox,
  outboxTerminalState,
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
  cancelPendingMediaSend,
  discardMediaSend,
  replaceMediaOutboxSource,
  restartMediaUploadGeneration,
} from "@/lib/media-send";
import { cancelPendingSendControl } from "@/lib/pending-send-control";
import { ensureDeviceRegistration } from "@/lib/device-registration";
import {
  isUnreadEligibleEvent,
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
import {
  DELAY_NEW_SILICON_TEXT_SENDS,
  SILICON_TEXT_HOLD_MS,
} from "@/lib/silicon-hold";
import { isGifMedia } from "@/lib/media-meta";
import { anchorPixelCorrection } from "@/lib/virtualization-anchor";
import { countNovelHistoryRows, hasNovelHistoryRows } from "@/lib/history-window";
import { belongsToSameTimelinePanel } from "@/lib/timeline-panel";
import {
  canApplyScheduledBottomScroll,
  isTimelineAtBottom,
  keyMovesTowardTimelineHistory,
  selectionTouchesTimeline,
  shouldPinOwnedTimelineTail,
  shouldLoadOlderNearTimelineTop,
  timelineTailIsVisible,
  touchMovesTowardTimelineHistory,
  wheelMovesTowardTimelineHistory,
} from "@/lib/timeline-text-selection";
import { authoritativeEditConflict } from "@/lib/edit-conflict";
import { reconcileReplyTarget } from "@/lib/reply-state";
import { chatConnectingCopy } from "@/lib/connection-status";
import { strongestMessageReceiptStatus } from "@/lib/message-receipt";
import { mergeSearchPage, recentLocalSearch } from "@/lib/reliable-search";
import {
  aggregateReactions,
  applyOwnReactionOverride,
  normalizeReactionEmoji,
  nextOwnReactionIntent,
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
  readRoomScrollMemory,
  rememberRoomScroll,
  type RoomScrollMemory,
} from "@/lib/room-scroll-memory";
import {
  queueRoomEventJump,
  takeRoomEventJump,
} from "@/lib/room-event-navigation";
import {
  canSendPlaintextToRoom,
  mergeDeliverySummaries,
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
import {
  WorkEventCard,
  WorkManagerActivityHistory,
} from "@/components/chat/work-updates";
import { sendTimeoutMs } from "@/lib/send-timeout";
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
  /** Immediately projects the accepted event into the sidebar. */
  onEventAccepted?: (event: Event) => void;
  /** A durable outgoing intent proves the open room is actively attended. */
  onSendIntent?: () => void;
  /** Flushes delivery acknowledgements after a history page is durably stored. */
  onHistoryStored?: () => void;
  /** Optional mobile-only return action for shells that embed RoomView outside
   * the normal /chat route, such as the Lords identity switcher. */
  onBack?: () => void;
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
  source: "server";
  /** §1.2 — determinate progress (0..100) when the silicon reports it. */
  pct?: number | null;
  /** §1.6 — public handle of whoever is actually working, so the progress
   *  avatar isn't a "most recent silicon sender" guess. */
  handle?: string | null;
  /** Carbon message that triggered this run; never used to reorder the UI. */
  anchorEventId?: string | null;
}

function progressStateForManagerKind(
  kind: import("@/lib/work-update-types").ManagerActivityKind,
): ProgressState {
  if (kind === "reading") return "reading_file";
  if (kind === "writing") return "writing_file";
  if (kind === "executing") return "executing";
  if (kind === "searching_web") return "searching_web";
  if (kind === "spawning_worker") return "spawning_worker";
  if (kind === "calling") return "calling";
  if (kind === "done") return "done";
  return "thinking";
}

function cachedManagerProgress(roomId: string): ProgressEntry | null {
  const groups = visibleCachedManagerActivities(roomId);
  const group = [...groups].reverse().find((candidate) => candidate.display === "active");
  const frame = group?.current;
  if (!group || !frame) return null;
  const updatedAt = Date.parse(group.updated_at);
  return {
    roomId,
    groupId: group.progress_group_id,
    state: progressStateForManagerKind(frame.kind),
    note: frame.note,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    source: "server",
    pct: frame.progress_pct,
  };
}

function managerProgressAfterFrame(
  roomId: string,
  current: ProgressEntry | null,
  incoming: ProgressEntry,
): ProgressEntry | null {
  const projected = cachedManagerProgress(roomId);
  if (!projected) return null;
  if (projected.groupId === incoming.groupId) return incoming;
  if (current?.groupId === projected.groupId) {
    return {
      ...projected,
      handle: current.handle,
      anchorEventId: current.anchorEventId,
    };
  }
  return projected;
}

function materializedWorkRecord(
  state: WorkUpdateState,
  incoming: WorkTimelineRecord,
): WorkTimelineRecord {
  try {
    const next = reduceWorkTimelineRecord(state, incoming);
    if (incoming.type === "m.work_task") {
      return { type: "m.work_task", task: next.tasks[incoming.task.task_id] };
    }
    return { type: "m.work_event", event: next.events[incoming.event.work_event_id] };
  } catch {
    // A producer that mutates an immutable identity cannot take down the chat;
    // retain the last coherent card while Glass rejects the bad revision.
    if (incoming.type === "m.work_task") {
      const current = state.tasks[incoming.task.task_id];
      return current ? { type: "m.work_task", task: current } : incoming;
    }
    const current = state.events[incoming.event.work_event_id];
    return current ? { type: "m.work_event", event: current } : incoming;
  }
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
  if (event.type === "m.work_task" || event.type === "m.work_event") {
    return workEventPreview(event) ?? "work update";
  }
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
// §1.1 — progress staleness. We keep showing the last live line as long as the
// silicon might still be working; only after a long silence do we collapse it to
// a quiet "Still working…" (with a dismiss, in case it died with no `done`).
// Backend search: hits per block (page) and the debounce before firing a query.
const SEARCH_INTERVAL = 40;
const SEARCH_DEBOUNCE_MS = 280;

// Keep older-history progress attached to the viewport instead of the timeline
// content. Short conversations are bottom-aligned, so a list child can sit far
// below the viewport top and never paint before the prepend completes.
function OlderHistoryLoadingOverlay({ loadingOlder }: { loadingOlder: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!loadingOlder}
      className={cn(
        "pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 border bg-background/95 px-3 py-1.5 shadow-sm backdrop-blur-sm transition-opacity",
        loadingOlder ? "opacity-100" : "opacity-0",
      )}
    >
      <span
        className="label-mono whitespace-nowrap text-[11px] text-muted-foreground"
      >
        Loading older messages…
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
// Keep a fast cached response visible for long enough to produce a real paint.
// This does not delay the request or the prepended messages themselves.
const OLDER_LOADING_MIN_MS = 180;
// The page-down arrow is an explicit navigation gesture, so it gets one short
// spatial transition. Automatic follow corrections remain instantaneous.
const PAGE_DOWN_ANIMATION_MS = 180;

function waitForOlderHistoryIndicatorPaint(): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallback);
      resolve();
    };
    // Two animation frames guarantee that the loading state committed in the
    // previous task received a real browser paint before a cached history page
    // can synchronously prepend. Background tabs use the bounded fallback.
    const fallback = window.setTimeout(finish, 100);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish);
    });
  });
}
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
function bestStatus(
  a: MessageStatus | undefined,
  b: MessageStatus | undefined,
): MessageStatus | undefined {
  return strongestMessageReceiptStatus(a, b);
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
  onEventAccepted,
  onSendIntent,
  onHistoryStored,
  onBack,
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
  // Transport phase changes are observational state, not room identity. Keep
  // the latest value available to failure reporting without making the
  // initial-history loader depend on every connecting/syncing/online tick.
  const socketStateRef = React.useRef(socketState);
  React.useLayoutEffect(() => {
    socketStateRef.current = socketState;
  }, [socketState]);
  // Device registration can rotate the access token immediately after boot.
  // That must not reopen the room or reclaim the reader's scroll position.
  const timelineDeviceRef = React.useRef(timelineDevice);
  React.useLayoutEffect(() => {
    timelineDeviceRef.current = timelineDevice;
  }, [timelineDevice]);
  const historyFailureBurstRef = React.useRef({ count: 0, lastAt: 0 });
  const reportHistoryFailure = React.useCallback((error: unknown) => {
    const owner = carbon?.carbon_id;
    if (!owner) return;
    const decision = classifySyncFailure(error, "history");
    if (decision.reason === "transient_failure") {
      // One aborted fetch, cache miss, or reconnect race does not mean the
      // conversation is corrupt. Keep serving the loaded timeline and let its
      // normal retry path recover. Escalate only a repeat burst while the main
      // socket itself is otherwise healthy.
      if (socketStateRef.current !== "online") return;
      const now = Date.now();
      const previous = historyFailureBurstRef.current;
      const count = now - previous.lastAt <= 20_000 ? previous.count + 1 : 1;
      historyFailureBurstRef.current = { count, lastAt: now };
      if (count < 3) return;
    }
    void reportSyncRecovery(owner, {
      phase: "degraded",
      reason: decision.reason,
      stream: "history",
      details: { ...decision.details, roomId: room.room_id },
    });
  }, [carbon?.carbon_id, room.room_id]);
  const reportHistoryHealthy = React.useCallback(() => {
    historyFailureBurstRef.current = { count: 0, lastAt: 0 };
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
  // RoomView is keyed by room id. Freeze the opening projection for the same
  // initial-paint epoch as the event state; later room updates arrive through
  // the normal socket/history reducers instead of restarting history loading.
  const [openedRoomProjection] = React.useState(room);
  const [openedScrollMemory] = React.useState(() => readRoomScrollMemory(room.room_id));
  const [events, setEvents] = React.useState<LocalEvent[]>(() =>
    seedTimelineWithRoomTail(
      openedRoomProjection,
      openedScrollMemory?.events.length
        ? openedScrollMemory.events
        : (readRoomEventSnippet(openedRoomProjection.room_id) ?? []),
    ).map((event) => {
      const local = event as LocalEvent;
      const cachedStatus = local._status;
      const fallbackStatus =
        !event.event_id.startsWith("temp-") &&
        !(local._projectedRoomTail === true) &&
        isMyEvent(event, myUsername)
          ? serverDeliveryStatus(event)
          : undefined;
      return {
        ...event,
        // The room handoff cache may contain an in-flight streamed message.
        // Preserve that fact so reopening cannot replace manager activity
        // before the matching event.final frame arrives.
        is_final: event.is_final !== false,
        _status: cachedStatus ?? fallbackStatus,
      };
    }),
  );
  const [workUpdateState, setWorkUpdateState] = React.useState(createWorkUpdateState);
  const [activeProgress, setActiveProgress] = React.useState<ProgressEntry | null>(null);
  const [managerActivityState, setManagerActivityState] = React.useState(
    getManagerActivityState,
  );
  const peers = React.useMemo(() => (Array.isArray(room.peers) ? room.peers : []), [room.peers]);
  // Direct 1-on-1 peer and its saved-contact record (if any) — drives the
  // header title (saved name vs @id), avatar, and the Save Contact button.
  const peer = room.kind === "direct" && peers.length === 1 ? peers[0] : null;
  const latestPeerActivityAt = React.useMemo(() => {
    if (peer?.kind !== "carbon") return "";
    const identities = new Set(
      [peer.handle, peer.id].map((identity) => identity.replace(/^@/, "")),
    );
    let latest = "";
    let latestMs = Number.NEGATIVE_INFINITY;
    const consider = (sender: string | null | undefined, at: string) => {
      if (!sender || !identities.has(sender.replace(/^@/, ""))) return;
      const parsed = Date.parse(at);
      if (!Number.isFinite(parsed) || parsed <= latestMs) return;
      latest = at;
      latestMs = parsed;
    };
    for (const event of events) consider(event.sender_handle, event.created_at);
    consider(room.last_event?.sender_handle, room.last_event?.at ?? "");
    return latest;
  }, [events, peer, room.last_event]);
  const carbonPresence = peer?.kind === "carbon"
    ? observePresenceActivity(peer.presence, latestPeerActivityAt)
    : undefined;
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
  const siliconPeers = React.useMemo(
    () => peers.filter((item) => item.kind === "silicon"),
    [peers],
  );
  const metadataSiliconProjectionSignature = React.useMemo(
    () => siliconPeerProjectionSignature(peers),
    [peers],
  );
  const [polledSiliconRoom, setPolledSiliconRoom] = React.useState<{
    roomId: string;
    metadataSignature: string;
    peers: typeof siliconPeers;
  } | null>(null);
  // A poll result only applies to the exact room projection it queried. A
  // websocket-driven phase/revision change invalidates an older in-flight poll
  // immediately, so polling repairs missed frames without masking live ones.
  const polledSiliconProjectionApplies =
    polledSiliconRoom?.roomId === room.room_id &&
    polledSiliconRoom.metadataSignature === metadataSiliconProjectionSignature;
  const effectiveSiliconPeers = polledSiliconProjectionApplies
    ? polledSiliconRoom.peers
    : siliconPeers;
  const effectiveDirectSilicon =
    peer?.kind === "silicon"
      ? effectiveSiliconPeers.find((item) => item.id === peer.id) ?? peer
      : null;
  const siliconConnectionState =
    effectiveDirectSilicon?.connection_state || "online";
  const activeSiliconMaintenancePeers = React.useMemo(
    () => siliconMaintenancePeers(effectiveSiliconPeers),
    [effectiveSiliconPeers],
  );
  const siliconMaintenanceActive = activeSiliconMaintenancePeers.length > 0;
  const siliconMaintenanceMessage = React.useMemo(
    () => siliconMaintenanceRoomMessage(effectiveSiliconPeers),
    [effectiveSiliconPeers],
  );
  const siliconUnavailable =
    peer?.kind === "silicon" &&
    !connectionStatePending &&
    siliconConnectionState !== "online" &&
    !siliconMaintenanceActive;
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
  React.useEffect(() => {
    if (siliconPeers.length === 0 || connectionStatePending) return;
    let alive = true;
    const poll = async () => {
      try {
        const next = await api.roomDetail(room.room_id);
        if (alive) {
          setPolledSiliconRoom({
            roomId: room.room_id,
            metadataSignature: metadataSiliconProjectionSignature,
            peers: next.peers.filter((item) => item.kind === "silicon"),
          });
        }
      } catch {
        /* keep the last authoritative projection and retry on the next tick */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [
    connectionStatePending,
    metadataSiliconProjectionSignature,
    room.room_id,
    siliconPeers.length,
  ]);

  // Selection ownership is imperative. Starting or ending a browser Range must
  // not schedule a React render: even a logically identical timeline render can
  // make the browser re-anchor the scroll container during a double-click.
  // Loaded message rows already stay mounted and retain stable event keys.
  const textSelectionActiveRef = React.useRef(false);
  const eventProjectionRef = React.useRef(events);
  const eventLookupRef = React.useRef(new Map(events.map((event) => [event.event_id, event])));
  React.useLayoutEffect(() => {
    eventProjectionRef.current = events;
    eventLookupRef.current = new Map(events.map((event) => [event.event_id, event]));
  }, [events]);
  React.useEffect(() => {
    const records = events
      .map((event) => parseWorkTimelineRecord(event.type, event.content))
      .filter((record): record is WorkTimelineRecord => {
        if (!record) return false;
        return record.type === "m.work_task"
          ? record.task.room_id === room.room_id
          : record.event.room_id === room.room_id;
      });
    if (records.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setWorkUpdateState((current) => {
        let next = current;
        for (const record of records) {
          try {
            next = reduceWorkTimelineRecord(next, record);
          } catch {
            // The validated card can still render; an identity mutation must not
            // erase the last coherent history already retained in this room.
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [events, room.room_id]);
  React.useEffect(() => {
    if (!events.some((event) => event.type === "m.progress")) return;
    const ordered = [...events].sort((left, right) =>
      left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
    );
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      let next = getManagerActivityState();
      let sawActivity = false;
      let pendingGroupId: string | null = null;
      for (let index = 0; index < ordered.length; index += 1) {
        const event = ordered[index];
        if (event.type === "m.progress") {
          const groupId = String(event.content.progress_group_id || event.event_id);
          next = recordManagerActivity(
            {
              ...event.content,
              room_id: room.room_id,
              progress_group_id: groupId,
              event_id: event.event_id,
            },
            {
              room_id: room.room_id,
              occurred_at: event.created_at,
              frame_id: event.event_id,
            },
          );
          sawActivity = true;
          const state = event.content.state ?? event.content.kind;
          if (state !== "done") pendingGroupId = groupId;
          const priorFinalMessage = state === "done"
            ? managerActivityReplacementEvent(ordered.slice(0, index), groupId)
            : null;
          if (priorFinalMessage) {
            next = settleCachedManagerActivity(room.room_id, {
              reason: "final_message",
              progress_group_id: groupId,
              occurred_at: event.created_at,
              final_message_event_id: priorFinalMessage.event_id,
            });
            if (pendingGroupId === groupId) pendingGroupId = null;
          } else if (state === "done") {
            pendingGroupId = groupId;
          }
        } else if (
          sawActivity &&
          eventReplacesManagerActivity(event)
        ) {
          const explicitGroupId =
            typeof event.content.progress_group_id === "string"
              ? event.content.progress_group_id
              : null;
          const selectedGroupId: string | null = explicitGroupId ?? pendingGroupId;
          next = settleCachedManagerActivity(room.room_id, {
            reason: "final_message",
            progress_group_id: selectedGroupId,
            occurred_at: event.created_at,
            final_message_event_id: event.event_id,
          });
          if (selectedGroupId === pendingGroupId) pendingGroupId = null;
        }
      }
      if (cancelled) return;
      setManagerActivityState(next);
      const reconstructedProgress = cachedManagerProgress(room.room_id);
      if (!reconstructedProgress) clearRoomProgress(room.room_id);
      setActiveProgress(reconstructedProgress);
    });
    return () => {
      cancelled = true;
    };
  }, [events, room.room_id]);
  // While a desired-state mutation is in flight, this projection wins over
  // delayed/out-of-order WS echoes. Requests for the same reaction are chained
  // so rapid cross-device-style toggles converge in click order.
  const [reactionOverrides, setReactionOverrides] = React.useState<Record<string, boolean>>({});
  // State paints the optimistic projection; the ref is the synchronous source
  // of truth between rapid clicks that happen before React can render again.
  const reactionOverridesRef = React.useRef<Record<string, boolean>>({});
  const reactionGenerationRef = React.useRef(new Map<string, number>());
  const reactionChainsRef = React.useRef(new Map<string, Promise<void>>());
  const reactionRoomRef = React.useRef(room.room_id);
  React.useEffect(() => {
    reactionRoomRef.current = room.room_id;
    reactionOverridesRef.current = {};
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
  // §2.5 — true once the live fetch resolves. Cached authoritative rows can be
  // read before this point when they are visibly rendered; hydration still
  // controls history/pagination readiness.
  const [hydrated, setHydrated] = React.useState(false);
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
  // Visual state for the page-down control. Bottom-follow ownership remains a
  // separate hard latch: seeing the newest message hides the arrow but does
  // not silently give programmatic scroll control back to the app.
  const [timelineAtBottom, setTimelineAtBottom] = React.useState(true);
  const timelineTailVisibleRef = React.useRef(true);
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
  // History is paged, but every loaded row stays mounted so prepends do not
  // recycle the nodes owned by a native text Range.
  const scrollRootRef = React.useRef<HTMLDivElement | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const timelineContentRef = React.useRef<HTMLDivElement | null>(null);
  const timelineTailRef = React.useRef<HTMLDivElement | null>(null);
  const timelineInteractionRef = React.useRef<HTMLDivElement | null>(null);
  const pendingRoomScrollRestoreRef = React.useRef<RoomScrollMemory | null>(
    openedScrollMemory && !openedScrollMemory.atBottom ? openedScrollMemory : null,
  );
  // Selection is tracked imperatively so `selectstart` never schedules a
  // React render or changes timeline geometry underneath the native Range.
  const activeRoomIdRef = React.useRef(room.room_id);
  React.useLayoutEffect(() => {
    activeRoomIdRef.current = room.room_id;
  }, [room.room_id]);
  const selectionGestureRef = React.useRef(false);
  const updateTextSelectionActive = React.useCallback((active: boolean) => {
    if (textSelectionActiveRef.current === active) return;
    textSelectionActiveRef.current = active;
    if (active) {
      timelineInteractionRef.current?.setAttribute("data-timeline-selection-active", "true");
    } else {
      timelineInteractionRef.current?.removeAttribute("data-timeline-selection-active");
    }
  }, []);
  const clearTimelineTextSelection = React.useCallback(() => {
    selectionGestureRef.current = false;
    window.getSelection()?.removeAllRanges();
    updateTextSelectionActive(false);
  }, [updateTextSelectionActive]);
  // Tracks whether the user is parked at the bottom — gates "stick to bottom".
  const stickToBottomRef = React.useRef(openedScrollMemory?.atBottom ?? true);
  // A newly opened room owns one initial trip to the authoritative tail. Cache
  // hydration and native scroll restoration may emit passive scroll events
  // before that tail commits; those events must not strand reload in history.
  const initialBottomPendingRef = React.useRef(
    !openedScrollMemory || openedScrollMemory.atBottom,
  );
  // Every manual interaction advances this epoch. Delayed resize/send frames
  // must still own the same epoch before they may mutate scrollTop.
  const scrollOwnershipEpochRef = React.useRef(0);
  const pendingBottomScrollFrameRef = React.useRef<number | null>(null);
  const bottomAnimationFrameRef = React.useRef<number | null>(null);
  const lastTouchClientYRef = React.useRef<number | null>(null);
  const scrollbarGestureRef = React.useRef<{ lastScrollTop: number } | null>(null);
  // A user-directed trip toward newer messages may explicitly renew follow
  // ownership once it reaches the physical tail. Passive layout scrolls never
  // set this flag, so media/reaction resizing cannot steal reader control.
  const returningToBottomRef = React.useRef(false);

  // RoomView is keyed by room identity, so its layout-effect cleanup runs while
  // the outgoing room's DOM and mounted rows are still measurable. Remember a
  // stable event/pixel anchor plus the loaded projection; reopening within an
  // hour can render that exact window before the network round-trip completes.
  React.useLayoutEffect(() => {
    return () => {
      const scroller = scrollerRef.current;
      const projectedEvents = eventProjectionRef.current;
      if (!scroller) {
        rememberRoomScroll(room.room_id, {
          anchorEventId: null,
          anchorOffset: 0,
          scrollTop: 0,
          atBottom: true,
          events: projectedEvents,
        });
        return;
      }
      const viewport = scroller.getBoundingClientRect();
      // Cleanup intentionally samples the latest message-row registry; a copy
      // from effect setup would describe the room's first paint, not its exit.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const anchor = [...messageNodeRefs.current.entries()]
        .filter(([, node]) => node.isConnected)
        .map(([eventId, node]) => {
          const rect = node.getBoundingClientRect();
          return { eventId, top: rect.top, bottom: rect.bottom };
        })
        .filter((candidate) => candidate.bottom > viewport.top && candidate.top < viewport.bottom)
        .sort((left, right) => left.top - right.top)[0];
      rememberRoomScroll(room.room_id, {
        anchorEventId: anchor?.eventId ?? null,
        anchorOffset: anchor ? anchor.top - viewport.top : 0,
        scrollTop: scroller.scrollTop,
        atBottom: isTimelineAtBottom({
          scrollHeight: scroller.scrollHeight,
          scrollTop: scroller.scrollTop,
          clientHeight: scroller.clientHeight,
        }),
        events: projectedEvents,
      });
    };
  }, [room.room_id]);
  // The first visible event and its exact viewport pixel remain authoritative
  // while a prepended page finishes sizing. Older media, previews, fonts, and
  // sender regrouping can all change height after the first React commit.
  const historyViewportAnchorRef = React.useRef<{
    eventId: string | null;
    offset: number;
    scrollTop: number;
    scrollHeight: number;
    awaitingCommit: boolean;
  } | null>(null);
  const clearHistoryViewportAnchor = React.useCallback((force = false) => {
    // Once a response has been accepted, its prepend and first layout
    // correction are one atomic visual commit. A wheel event in the few
    // milliseconds between them must not discard the anchor and expose the
    // absolute scrollTop of the newly taller document.
    if (!force && historyViewportAnchorRef.current?.awaitingCommit) return;
    historyViewportAnchorRef.current = null;
  }, []);
  const captureHistoryViewportAnchor = React.useCallback((incoming: Event[]) => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    const knownEventIds = new Set(messageNodeRefs.current.keys());
    if (!hasNovelHistoryRows(incoming, knownEventIds, isTimelineEvent)) return false;
    const viewportTop = scroller.getBoundingClientRect().top;
    const anchor = [...messageNodeRefs.current.entries()]
      .map(([eventId, node]) => ({
        eventId,
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
      }))
      .filter((item) => item.bottom > viewportTop)
      .sort((a, b) => a.top - b.top)[0];
    historyViewportAnchorRef.current = {
      eventId: anchor?.eventId ?? null,
      offset: anchor ? anchor.top - viewportTop : 0,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      awaitingCommit: true,
    };
    return true;
  }, []);
  const preserveHistoryViewportAnchor = React.useCallback((committed = false) => {
    const anchor = historyViewportAnchorRef.current;
    const scroller = scrollerRef.current;
    if (!anchor || !scroller) return false;
    const node = anchor.eventId
      ? messageNodeRefs.current.get(anchor.eventId)
      : null;
    if (node?.isConnected) {
      const actual = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += anchorPixelCorrection(actual, anchor.offset);
    } else {
      // A ref may be briefly unavailable when a sender group is re-keyed. The
      // height delta is an exact fallback until the stable event ref reattaches.
      scroller.scrollTop =
        anchor.scrollTop + (scroller.scrollHeight - anchor.scrollHeight);
    }
    anchor.scrollTop = scroller.scrollTop;
    anchor.scrollHeight = scroller.scrollHeight;
    // ResizeObserver may run for an unrelated header/media resize between
    // capturing the anchor and React committing the prepended rows. It may
    // correct the viewport, but only the timeline layout commit can release
    // the guard that prevents wheel/pointer handlers from clearing the anchor.
    if (committed) anchor.awaitingCommit = false;
    return true;
  }, []);
  const cancelPendingBottomScroll = React.useCallback(() => {
    if (pendingBottomScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(pendingBottomScrollFrameRef.current);
    pendingBottomScrollFrameRef.current = null;
  }, []);
  const cancelBottomAnimation = React.useCallback(() => {
    if (bottomAnimationFrameRef.current === null) return;
    window.cancelAnimationFrame(bottomAnimationFrameRef.current);
    bottomAnimationFrameRef.current = null;
  }, []);
  const releaseBottomStick = React.useCallback(() => {
    initialBottomPendingRef.current = false;
    stickToBottomRef.current = false;
    returningToBottomRef.current = false;
    scrollOwnershipEpochRef.current += 1;
    // Explicit reader input always wins, including during the narrow window
    // between accepting an older-history page and committing its rows. Leaving
    // an awaiting anchor alive here lets its later correction undo the user's
    // wheel/drag and makes the scroller feel locked.
    clearHistoryViewportAnchor(true);
    cancelPendingBottomScroll();
    cancelBottomAnimation();
  }, [cancelBottomAnimation, cancelPendingBottomScroll, clearHistoryViewportAnchor]);

  const scrollToBottom = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || bottomAnimationFrameRef.current !== null) return;
    // Instant assignment has no browser animation that can keep fighting a
    // wheel or touch gesture after the reader takes ownership.
    scroller.scrollTop = scroller.scrollHeight;
  }, []);

  const animateToBottom = React.useCallback(() => {
    cancelPendingBottomScroll();
    cancelBottomAnimation();
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const startTop = scroller.scrollTop;
    const initialTarget = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (
      initialTarget - startTop <= 1 ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    const startedAt = performance.now();
    const step = (now: number) => {
      if (!stickToBottomRef.current || textSelectionActiveRef.current) {
        bottomAnimationFrameRef.current = null;
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - startedAt) / PAGE_DOWN_ANIMATION_MS));
      const eased = 1 - Math.pow(1 - progress, 3);
      // Re-read the target every frame so a message or media resize during the
      // short flight is included instead of leaving the arrow one row short.
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = startTop + (target - startTop) * eased;
      if (progress < 1) {
        bottomAnimationFrameRef.current = window.requestAnimationFrame(step);
      } else {
        bottomAnimationFrameRef.current = null;
        scroller.scrollTop = scroller.scrollHeight;
      }
    };
    bottomAnimationFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelBottomAnimation, cancelPendingBottomScroll]);

  const scheduleBottomScroll = React.useCallback(() => {
    cancelPendingBottomScroll();
    const scheduledEpoch = scrollOwnershipEpochRef.current;
    pendingBottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingBottomScrollFrameRef.current = null;
      if (!canApplyScheduledBottomScroll({
        scheduledEpoch,
        currentEpoch: scrollOwnershipEpochRef.current,
        followingBottom: stickToBottomRef.current,
        selectionActive: textSelectionActiveRef.current,
      })) return;
      scrollToBottom();
    });
  }, [cancelPendingBottomScroll, scrollToBottom]);

  const activateBottomFollowFromArrow = React.useCallback(() => {
    // A double-click leaves a persistent browser Range. It must not disable the
    // explicit page-down control; clear it and let the user's click win.
    clearTimelineTextSelection();
    clearHistoryViewportAnchor(true);
    initialBottomPendingRef.current = false;
    scrollOwnershipEpochRef.current += 1;
    stickToBottomRef.current = true;
    timelineTailVisibleRef.current = true;
    setTimelineAtBottom(true);
    setUnseenBelow(0);
    animateToBottom();
  }, [animateToBottom, clearHistoryViewportAnchor, clearTimelineTextSelection]);

  const acquireBottomFollowAtCurrentTail = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      textSelectionActiveRef.current ||
      !isTimelineAtBottom({
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
      })
    ) return false;
    clearHistoryViewportAnchor(true);
    initialBottomPendingRef.current = false;
    returningToBottomRef.current = false;
    if (!stickToBottomRef.current) scrollOwnershipEpochRef.current += 1;
    stickToBottomRef.current = true;
    timelineTailVisibleRef.current = true;
    setTimelineAtBottom(true);
    setUnseenBelow(0);
    return true;
  }, [clearHistoryViewportAnchor]);

  const keepOwnedBottomPinned = React.useCallback(() => {
    if (!shouldPinOwnedTimelineTail({
      followingBottom: stickToBottomRef.current,
      selectionActive: textSelectionActiveRef.current,
    })) return false;
    timelineTailVisibleRef.current = true;
    setTimelineAtBottom(true);
    setUnseenBelow(0);
    if (bottomAnimationFrameRef.current !== null) return true;
    scheduleBottomScroll();
    return true;
  }, [scheduleBottomScroll]);

  // Pause structural history prepends and bottom-follow while a native Range
  // owns timeline text. Pointer-up alone must not release the guard because
  // the selected range remains live and copyable after the drag ends.
  React.useEffect(() => {
    const root = timelineInteractionRef.current;
    if (!root) return;

    const hasTimelineSelection = () => selectionTouchesTimeline(window.getSelection(), root);
    const onSelectStart = (event: globalThis.Event) => {
      const target = event.target;
      if (!(target instanceof Node) || !root.contains(target)) return;
      // `selectstart` also fires for an ordinary click. Do not freeze the event
      // projection until the browser confirms that the Range actually spans
      // text.
      selectionGestureRef.current = true;
    };
    const onSelectionChange = () => {
      const selectionActive = hasTimelineSelection();
      if (selectionActive && !textSelectionActiveRef.current) {
        // A real native selection now owns the viewport until the reader
        // explicitly returns to the end. Heartbeats and resizes cannot pull it.
        releaseBottomStick();
      }
      if (selectionGestureRef.current) {
        if (selectionActive) updateTextSelectionActive(true);
        return;
      }
      updateTextSelectionActive(selectionActive);
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
  }, [releaseBottomStick, room.room_id, updateTextSelectionActive]);

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
  const persistHistoryEvents = React.useCallback(
    async (history: Event[]) => {
      if (!history.length || timelineOwner === "session") return;
      await storeEvents(
        timelineOwner,
        history.map((event) => ({ roomId: room.room_id, event })),
      );
      // Device-aware Glass nodes only mark delivery after this durable commit.
      // Rendering a history page is never enough evidence on its own.
      onHistoryStored?.();
    },
    [onHistoryStored, room.room_id, timelineOwner],
  );
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
    const roomOpenTimelineDevice = timelineDeviceRef.current;
    // Room navigation starts a fresh bottom-follow epoch. No frame scheduled
    // by the previous room is allowed to move the new room's viewport.
    scrollOwnershipEpochRef.current += 1;
    cancelPendingBottomScroll();
    cancelBottomAnimation();
    const restoringRememberedPosition = Boolean(
      openedScrollMemory && !openedScrollMemory.atBottom,
    );
    pendingRoomScrollRestoreRef.current = restoringRememberedPosition
      ? openedScrollMemory
      : null;
    initialBottomPendingRef.current = !restoringRememberedPosition;
    stickToBottomRef.current = !restoringRememberedPosition;
    const roomOpenScrollEpoch = scrollOwnershipEpochRef.current;
    clearHistoryViewportAnchor(true);
    const cachedEvents = seedTimelineWithRoomTail(
      openedRoomProjection,
      openedScrollMemory?.events.length
        ? openedScrollMemory.events
        : (readRoomEventSnippet(roomId) ?? []),
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect -- room changes require one atomic pre-paint reset so stale timeline/outbox state never appears in the next room.
    setLoading(!cachedEvents.some(isTimelineEvent));
    setHydrated(false);
    // The handoff cache can contain a currently streaming message. Preserve
    // its authoritative final bit so it cannot prematurely replace a live
    // manager-activity run while this room opens.
    setEvents(
      cachedEvents.map((e) => {
        const local = e as LocalEvent;
        const cachedStatus = local._status;
        const fallbackStatus =
          !e.event_id.startsWith("temp-") && isMyEvent(e, myUsername)
            ? serverDeliveryStatus(e)
            : undefined;
        return {
          ...e,
          is_final: e.is_final !== false,
          _status: cachedStatus ?? fallbackStatus,
        };
      }),
    );
    // Restore an in-flight silicon progress line captured at the page level
    // while this room was closed, so reopening a chat where work is still
    // running shows progress immediately instead of waiting for the next frame.
    setActiveProgress(getRoomProgress(roomId) ?? cachedManagerProgress(roomId));
    setManagerActivityState(getManagerActivityState());
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
    timelineTailVisibleRef.current = !restoringRememberedPosition;
    setTimelineAtBottom(!restoringRememberedPosition);
    deltaBufferRef.current.clear();
    firstContactRef.current = false;
    let durableCacheAvailable = false;
    const cacheOwner = authStore.getCarbon()?.carbon_id;
    const commitInitialTimelineRows = async (incoming: Event[]) => {
      if (!mounted || incoming.length === 0) return;
      // The initial snippet paints synchronously, but IndexedDB and the first
      // authoritative page can arrive after the reader has already started
      // scrolling. Treat those late older rows exactly like every subsequent
      // prepend: paint progress first, then commit and restore one event/pixel
      // atomically. This closes the one unguarded "first page" jump.
      const protectReaderPosition =
        !stickToBottomRef.current &&
        hasNovelHistoryRows(
          incoming,
          new Set(messageNodeRefs.current.keys()),
          isTimelineEvent,
        );
      let ownsOlderIndicator = false;
      let indicatorVisibleAt = performance.now();
      if (protectReaderPosition) {
        if (!loadingOlderRef.current) {
          loadingOlderRef.current = true;
          ownsOlderIndicator = true;
          setLoadingOlder(true);
          await waitForOlderHistoryIndicatorPaint();
          indicatorVisibleAt = performance.now();
          if (!mounted) return;
        }
        captureHistoryViewportAnchor(incoming);
      }
      flushSync(() => {
        setEvents((prev) =>
          mergeServerEvents(
            prev,
            incoming,
            roomId,
            myUsername,
            timelineOwner,
            roomOpenTimelineDevice,
          ),
        );
      });
      if (protectReaderPosition) preserveHistoryViewportAnchor(true);
      if (ownsOlderIndicator) {
        const remainingIndicatorMs = Math.max(
          0,
          OLDER_LOADING_MIN_MS - (performance.now() - indicatorVisibleAt),
        );
        if (remainingIndicatorMs > 0) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, remainingIndicatorMs);
          });
        }
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    };
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
          .filter((entry) => {
            if (
              entry.roomId !== roomId ||
              terminalCancellations.has(entry.clientId) ||
              (entry.operation === "media" && entry.media?.phase === "acquiring")
            ) {
              return false;
            }
            // The authoritative event may have landed before this slower
            // IndexedDB read completed. Never restore its stale outbox row as
            // a failed sidebar preview after acceptance.
            if (readTimelineIdentity(cacheOwner, entry.clientId)?.eventId) {
              markPendingPreviewAccepted(roomId, entry.clientId);
              return false;
            }
            return true;
          })
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
                    roomOpenTimelineDevice,
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
            at: Date.parse(row.created_at),
          });
        }
        setEvents((prev) =>
          mergeServerEvents(
            prev,
            pending,
            roomId,
            myUsername,
            timelineOwner,
            roomOpenTimelineDevice,
          ),
        );
        setLoading(false);
      }).catch(() => undefined);
      void loadStoredRoomEvents(cacheOwner, roomId, 100).then(async (stored) => {
        if (!mounted || stored.length === 0) return;
        durableCacheAvailable = true;
        await commitInitialTimelineRows(stored);
        setLoading(false);
      }).catch(() => undefined);
    }
    const finishInitialBottomPosition = () => {
      if (
        !mounted ||
        !initialBottomPendingRef.current ||
        !stickToBottomRef.current ||
        scrollOwnershipEpochRef.current !== roomOpenScrollEpoch
      ) return;
      scheduleBottomScroll();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (
            mounted &&
            initialBottomPendingRef.current &&
            stickToBottomRef.current &&
            scrollOwnershipEpochRef.current === roomOpenScrollEpoch
          ) {
            initialBottomPendingRef.current = false;
          }
        });
      });
    };
    loadTimelineWindow(roomId)
      .then(async ({ events: evs, hasMore, cursor, boundaryEventId }) => {
        if (!mounted) return;
        reportHistoryHealthy();
        // Reconcile the full authoritative window so read/delivered ticks and
        // an in-flight event's final bit both survive hydration.
        const finalized = evs.map((e) => ({ ...e, is_final: e.is_final !== false }));
        await commitInitialTimelineRows(finalized);
        void persistHistoryEvents(finalized).catch(() => undefined);
        if (!mounted) return;
        setHasMore(hasMore);
        setHistoryCursor(cursor);
        setHistoryBoundaryEventId(boundaryEventId);
        setHydrated(true); // §2.5 — live data is in; auto-read may now run
        setLoading(false);
        finishInitialBottomPosition();
      })
      .catch((e) => {
        if (!mounted) return;
        reportHistoryFailure(e);
        if (!cachedEvents.some(isTimelineEvent) && !durableCacheAvailable) {
          toast.error(e instanceof ApiError ? e.message : String(e));
        }
        setLoading(false);
        finishInitialBottomPosition();
      });
    return () => {
      mounted = false;
      cancelPendingBottomScroll();
      cancelBottomAnimation();
    };
  }, [
    cancelBottomAnimation,
    cancelPendingBottomScroll,
    clearHistoryViewportAnchor,
    openedRoomProjection,
    openedScrollMemory,
    room.room_id,
    myUsername,
    reportHistoryFailure,
    reportHistoryHealthy,
    captureHistoryViewportAnchor,
    preserveHistoryViewportAnchor,
    persistHistoryEvents,
    scheduleBottomScroll,
    setEvents,
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
  }, [carbon?.carbon_id, room.room_id, setEvents]);

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
          void persistHistoryEvents(evs).catch(() => undefined);
          setEvents((prev) =>
            mergeServerEvents(
              prev,
              evs,
              room.room_id,
              myUsername,
              timelineOwner,
              timelineDevice,
            ),
          );
          // §1.7 — after a (re)connect, resync the Stemcell progress line from
          // the cache. If the task finished, the cache was cleared by a final
          // message; a done run without a final message retains its expandable
          // activity history.
          setManagerActivityState(getManagerActivityState());
          setActiveProgress(
            getRoomProgress(room.room_id) ?? cachedManagerProgress(room.room_id),
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
    persistHistoryEvents,
    setEvents,
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
        at: Number.isFinite(Date.parse(held.created_at))
          ? Date.parse(held.created_at)
          : Date.now(),
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
        const groupId = String(incoming.content.progress_group_id || incoming.event_id);
        let nextManagerActivity = recordManagerActivity(
          {
            ...incoming.content,
            room_id: room.room_id,
            progress_group_id: groupId,
            event_id: incoming.event_id,
          },
          {
            room_id: room.room_id,
            occurred_at: incoming.created_at,
            frame_id: incoming.event_id,
          },
        );
        const priorFinalMessage = state === "done"
          ? managerActivityReplacementEvent(
              [
                ...eventProjectionRef.current,
                ...recentServerEventRef.current.values(),
              ],
              groupId,
            )
          : null;
        if (priorFinalMessage) {
          nextManagerActivity = settleCachedManagerActivity(room.room_id, {
            reason: "final_message",
            progress_group_id: groupId,
            occurred_at: incoming.created_at,
            final_message_event_id: priorFinalMessage.event_id,
          });
        }
        setManagerActivityState(nextManagerActivity);
        const incomingProgress: ProgressEntry = {
          roomId: room.room_id,
          groupId,
          state,
          note: String(incoming.content.note || ""),
          updatedAt: Date.now(),
          source: "server",
          pct: numOrNull(incoming.content.progress_pct),
          handle: incoming.sender_handle,
          anchorEventId: incoming.content.run_anchor_event_id
            ? String(incoming.content.run_anchor_event_id)
            : null,
        };
        setActiveProgress((current) =>
          managerProgressAfterFrame(room.room_id, current, incomingProgress)
        );
        return;
      }
      // Count genuinely new incoming messages while the user is reading
      // history. Existing-event updates (edits/finalization) do not badge.
      if (
        !updatesExisting &&
        !mine &&
        (PROGRESS_MESSAGE_TYPES.has(incoming.type) || workEventCountsAsUnread(incoming)) &&
        !stickToBottomRef.current
      ) {
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
      if (!updatesExisting && !mine && eventReplacesManagerActivity(merged)) {
        const settled = settleCachedManagerActivity(room.room_id, {
          reason: "final_message",
          progress_group_id:
            typeof merged.content.progress_group_id === "string"
              ? merged.content.progress_group_id
              : null,
          occurred_at:
            incoming.is_final === false ? new Date().toISOString() : merged.created_at,
          final_message_event_id: merged.event_id,
        });
        setManagerActivityState(settled);
        setActiveProgress(cachedManagerProgress(room.room_id));
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
          room.room_id,
          myUsername,
          timelineOwner,
          timelineDevice,
        );
      });
    } else if (f.type === "delivery_receipt") {
      if (!f.member_handle || f.member_handle !== myUsername) {
        const delivered = new Set(f.event_ids);
        setEvents((prev) =>
          prev.map((event) => {
            if (!delivered.has(event.event_id) || event.sender_handle !== myUsername) {
              return event;
            }
            const incomingSummary = f.deliveries?.[event.event_id];
            const summary = incomingSummary
              ? mergeDeliverySummaries(event.delivery, incomingSummary)!
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
      const pendingEvent = eventLookupRef.current.get(f.event_id) ??
        recentServerEventRef.current.get(f.event_id);
      if (pendingEvent) {
        const finalizedEvent = { ...pendingEvent, is_final: true };
        recentServerEventRef.current.set(f.event_id, finalizedEvent);
        if (eventReplacesManagerActivity(finalizedEvent)) {
          const settled = settleCachedManagerActivity(room.room_id, {
            reason: "final_message",
            progress_group_id:
              typeof finalizedEvent.content.progress_group_id === "string"
                ? finalizedEvent.content.progress_group_id
                : null,
            occurred_at: new Date().toISOString(),
            final_message_event_id: finalizedEvent.event_id,
          });
          setManagerActivityState(settled);
          setActiveProgress(cachedManagerProgress(room.room_id));
        }
      }
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
      setEvents((prev) => {
        const cutoffIdx = prev.findIndex((e) => e.event_id === f.event_id);
        let changed = false;
        const updated = prev.map((e, i) => {
          const incomingSummary = f.deliveries?.[e.event_id];
          const covered = incomingSummary != null || (cutoffIdx >= 0 && i <= cutoffIdx);
          if (covered && e.sender_handle === myUsername && e._status !== "read") {
            const summary = incomingSummary
              ? mergeDeliverySummaries(e.delivery, incomingSummary)!
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
    } else if (f.type === "thread_read_receipt") {
      if (f.member_handle && f.member_handle === myUsername) {
        return;
      }
      setEvents((previous) => {
        let changed = false;
        const next = previous.map((event) => {
          const incoming = f.deliveries?.[event.event_id];
          if (!incoming || event.sender_handle !== myUsername) return event;
          const summary = mergeDeliverySummaries(event.delivery, incoming)!;
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
        const occurredAt = new Date().toISOString();
        const nextManagerActivity = recordManagerActivity(f, {
          room_id: room.room_id,
          occurred_at: occurredAt,
        });
        setManagerActivityState(nextManagerActivity);
        const incomingProgress: ProgressEntry = {
          roomId: room.room_id,
          groupId: f.progress_group_id,
          state: f.state as ProgressState,
          note: f.note || "",
          updatedAt: Date.now(),
          source: "server",
          pct: numOrNull(f.progress_pct),
          handle: f.member_handle ?? null,
          anchorEventId: f.run_anchor_event_id ?? null,
        };
        setActiveProgress((current) =>
          managerProgressAfterFrame(room.room_id, current, incomingProgress)
        );
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
  // Install the listener before rereading the page-owned handoff cache. That
  // closes the only remaining mount race: a frame can land after the initial
  // layout read but before this passive effect, updating the sidebar while the
  // open timeline has no listener yet. The page writes every accepted event to
  // this cache before fan-out, so the post-subscribe merge covers everything
  // before registration and the listener covers everything after it.
  React.useEffect(() => {
    const unsubscribe = socketSubscribe((f) => frameHandlerRef.current(f));
    const handoff = readRoomEventSnippet(room.room_id) ?? [];
    if (handoff.length > 0) {
      setEvents((current) =>
        mergeServerEvents(
          current,
          handoff,
          room.room_id,
          myUsername,
          timelineOwner,
          timelineDeviceRef.current,
        ),
      );
    }
    return unsubscribe;
  }, [myUsername, room.room_id, setEvents, socketSubscribe, timelineOwner]);

  // §1.1 — while a progress line is showing, advance a 1s tick so we can detect
  // staleness (the silicon crashed / backend restarted with no `done` frame).
  React.useEffect(() => {
    if (!activeProgress) return;
    const id = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeProgress]);

  // ----- Scroll + auto-read -----
  // ChatPage owns the immediate read-on-open transition so the sidebar clears
  // before this timeline mounts. Later arrivals still require actual viewport
  // exposure before advancing the read boundary.
  const committedReadPositionRef = React.useRef(room.unread_boundary.last_read_stream_position);
  const pendingReadPositionRef = React.useRef(0);
  const committedReadVectorRef = React.useRef(room.unread_boundary.last_read_stream_vector);
  const readEventRequestsRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    committedReadPositionRef.current = Math.max(
      committedReadPositionRef.current,
      room.unread_boundary.last_read_stream_position,
    );
    const incoming = room.unread_boundary.last_read_stream_vector;
    if (!incoming) return;
    const current = committedReadVectorRef.current;
    const floor = Math.max(current?.floor ?? 0, incoming.floor);
    const writers: Record<string, number> = {};
    const names = new Set([
      ...Object.keys(current?.writers ?? {}),
      ...Object.keys(incoming.writers),
    ]);
    for (const writer of names) {
      const position = Math.max(
        current?.writers[writer] ?? current?.floor ?? 0,
        incoming.writers[writer] ?? incoming.floor,
      );
      if (position > floor) writers[writer] = position;
    }
    committedReadVectorRef.current = { floor, writers };
  }, [
    room.unread_boundary.last_read_stream_position,
    room.unread_boundary.last_read_stream_vector,
  ]);
  const commitReadPosition = React.useCallback((
    eventId: string | null,
    streamPosition: number,
    streamWriter?: string,
    forceLocal = false,
  ) => {
    if (readOnly || !Number.isSafeInteger(streamPosition)) return;
    if (eventId && readEventRequestsRef.current.has(eventId)) return;
    const vector = committedReadVectorRef.current;
    const alreadyRead = streamWriter && vector
      ? streamPosition <= (vector.writers[streamWriter] ?? vector.floor)
      : streamPosition <= Math.max(
          committedReadPositionRef.current,
          pendingReadPositionRef.current,
        );
    if (!forceLocal && alreadyRead) return;
    if (eventId) {
      readEventRequestsRef.current.add(eventId);
      if (readEventRequestsRef.current.size > 1_024) {
        const stale = Array.from(readEventRequestsRef.current).slice(0, 256);
        for (const id of stale) readEventRequestsRef.current.delete(id);
      }
    }
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
      if (streamWriter) {
        const current = committedReadVectorRef.current;
        const floor = current?.floor ?? 0;
        const currentPosition = current?.writers[streamWriter] ?? floor;
        if (streamPosition > currentPosition) {
          committedReadVectorRef.current = {
            floor,
            writers: { ...(current?.writers ?? {}), [streamWriter]: streamPosition },
          };
        }
      }
      if (pendingReadPositionRef.current === streamPosition) pendingReadPositionRef.current = 0;
    }).catch(() => {
      if (eventId) readEventRequestsRef.current.delete(eventId);
      if (pendingReadPositionRef.current === streamPosition) pendingReadPositionRef.current = 0;
    });
  }, [onReadThrough, readOnly, room.room_id]);

  const commitReadTarget = React.useCallback((target: Event) => {
    if (!hasAuthoritativeEventId(target) || !Number.isSafeInteger(target.stream_position)) return;
    commitReadPosition(target.event_id, Number(target.stream_position), target.stream_writer);
  }, [commitReadPosition]);

  const markVisibleRead = React.useCallback(() => {
    if (readOnly) return;
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const viewport = scroller.getBoundingClientRect();
    const candidates: Array<{ event: Event; top: number; bottom: number; height: number }> = [];
    for (const [eventId, node] of messageNodeRefs.current) {
      const event = eventLookupRef.current.get(eventId);
      if (
        !event ||
        !hasAuthoritativeEventId(event) ||
        !isUnreadEligibleEvent(event)
      ) continue;
      const rect = node.getBoundingClientRect();
      candidates.push({ event, top: rect.top, bottom: rect.bottom, height: rect.height });
    }
    const target = selectVisibleReadTarget(
      candidates,
      viewport,
      myUsername,
      Math.max(committedReadPositionRef.current, pendingReadPositionRef.current),
      committedReadVectorRef.current,
    );
    if (!target) return;
    commitReadTarget(target);
  }, [commitReadTarget, myUsername, readOnly]);

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

  // A redaction can collapse a large row to a tiny tombstone. If the reader was
  // already at the bottom, settle after the DOM commit. Readers scrolled into
  // history are left exactly where they are.
  const settleTimelineAfterUnsend = React.useCallback(() => {
    if (!stickToBottomRef.current || textSelectionActiveRef.current) return;
    window.requestAnimationFrame(() => {
      if (!stickToBottomRef.current || textSelectionActiveRef.current) return;
      scrollToBottom();
    });
  }, [scrollToBottom]);

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
      const previousStatus = (ev as LocalEvent)._status;
      setEvents((prev) =>
        prev.map((event) =>
          event._clientId === clientId
            ? { ...event, _status: "retrying" as MessageStatus }
            : event,
        ),
      );
      const result = cancel ? await cancel(clientId) : "not-held";
      if (result === "failed") {
        setEvents((prev) =>
          prev.map((event) =>
            event._clientId === clientId
              ? { ...event, _status: previousStatus }
              : event,
          ),
        );
        return;
      }
      if (result === "not-held") {
        const owner = authStore.getCarbon()?.carbon_id ?? null;
        if (!owner) {
          setEvents((prev) =>
            prev.map((event) =>
              event._clientId === clientId
                ? { ...event, _status: previousStatus }
                : event,
            ),
          );
          return;
        }
        // Abort first: the recovery worker may currently hold the client lock
        // around a multipart XHR or event POST. Aborting releases that lock;
        // the discard tombstone then prevents every tab from replaying it.
        cancelPendingSendControl(owner, clientId);
        const cancelled = await withOutboxClientLock(owner, clientId, async () => {
          const current = (await listOutbox(owner)).find(
            (entry) => entry.clientId === clientId,
          );
          if (!current) {
            return (await outboxTerminalState(owner, clientId)) === "discarded"
              ? "cancelled" as const
              : "settled" as const;
          }
          const committed = current.operation === "media"
            ? await cancelPendingMediaSend(owner, current)
            : await cancelPendingOutbox(owner, clientId);
          return committed ? "cancelled" as const : "failed" as const;
        });
        if (cancelled === "settled") {
          // Acceptance won the race. Project the authoritative event instead
          // of claiming a cancellation the server never confirmed.
          void loadTimelineWindow(room.room_id).then(({ events: authoritative }) => {
            setEvents((prev) =>
              mergeServerEvents(
                prev,
                authoritative,
                room.room_id,
                myUsername,
                timelineOwner,
                timelineDevice,
              ),
            );
          }).catch(() => undefined);
          return;
        }
        if (cancelled === "failed") {
          setEvents((prev) =>
            prev.map((event) =>
              event._clientId === clientId
                ? { ...event, _status: previousStatus }
                : event,
            ),
          );
          toast.error("The cancel request could not be saved. The message is still queued.");
          return;
        }
      }
      if (result === "sent") {
        // The server won the release race. Replace the temp row from
        // authoritative history instead of pretending the delete succeeded.
        void loadTimelineWindow(room.room_id).then(({ events: authoritative }) => {
          setEvents((prev) =>
            mergeServerEvents(
              prev,
              authoritative,
              room.room_id,
              myUsername,
              timelineOwner,
              timelineDevice,
            ),
          );
        }).catch(() => undefined);
        return;
      }
      if (result !== "cancelled" && result !== "not-held") return;
      setHoldingMessage(false);
      setEditingEvent((cur) => (cur?.event_id === ev.event_id ? null : cur));
      const localUrl = ev.content.local_url;
      if (typeof localUrl === "string" && localUrl.startsWith("blob:")) {
        URL.revokeObjectURL(localUrl);
      }
      clearPendingPreview(room.room_id, clientId);
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
    const emoji = normalizeReactionEmoji(rawEmoji);
    const key = reactionIntentKey(ev.event_id, emoji);
    const desired = nextOwnReactionIntent(
      eventProjectionRef.current,
      ev.event_id,
      emoji,
      myUsername,
      reactionOverridesRef.current[key],
    );
    const nextOverrides = { ...reactionOverridesRef.current, [key]: desired };
    reactionOverridesRef.current = nextOverrides;
    setReactionOverrides(nextOverrides);
    // Returning to the physical tail by hand is an explicit follow gesture.
    // Renew it before the reaction chip changes row height.
    acquireBottomFollowAtCurrentTail();
    keepOwnedBottomPinned();

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
          const next = { ...reactionOverridesRef.current };
          delete next[key];
          reactionOverridesRef.current = next;
          setReactionOverrides(next);
        }
      })
      .catch((error) => {
        if (
          reactionRoomRef.current !== roomId ||
          reactionGenerationRef.current.get(key) !== generation
        ) return;
        const next = { ...reactionOverridesRef.current };
        delete next[key];
        reactionOverridesRef.current = next;
        setReactionOverrides(next);
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
  };

  const roomIncludesSilicon = peers.some((p) => p.kind === "silicon");
  const directRoomIncludesSilicon = room.kind === "direct" && roomIncludesSilicon;
  const canUnsendMessage = React.useCallback(
    (ev: LocalEvent | Event) => {
      if (!isMyEvent(ev, myUsername)) return false;
      if (ev.redacted_at) return false;
      const local = ev as LocalEvent;
      // A failed local row never reached the server, so there is nothing to
      // unsend. Its recovery surface owns retry and discard instead.
      if (local._status === "failed" || local._failure) return false;
      const isHeldOrPending = ev.event_id.startsWith("temp-") && Boolean(local._clientId);
      if (isHeldOrPending) return true;
      // Group chats use the same sender/read-window rule as Carbon ↔ Carbon
      // chats, even when a Silicon is also a member. Only a direct Silicon
      // conversation keeps its stricter no-unsend rule.
      if (directRoomIncludesSilicon) return false;
      if (typeof ev.can_unsend === "boolean") return ev.can_unsend;
      return local._status !== "read";
    },
    [directRoomIncludesSilicon, myUsername],
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
      const optimistic = withEditedText(snapshot ?? ev, body, editedAt);
      setEvents((prev) =>
        prev.map((item) =>
          item.event_id === ev.event_id ? withEditedText(item, body, editedAt) : item,
        ),
      );
      onEventAccepted?.(optimistic);
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
        onEventAccepted?.(real);
      } catch (e) {
        const authoritative = authoritativeEditConflict(e, ev.event_id);
        if (authoritative) {
          setEvents((prev) => prev.map((item) =>
            item.event_id === authoritative.event_id
              ? { ...authoritative, _clientId: item._clientId, _status: item._status }
              : item,
          ));
          onEventAccepted?.(authoritative);
          // Keep the replacement text in the composer, but advance the base
          // snapshot so a deliberate retry compares against the current row.
          setEditingEvent(authoritative);
          toast.error("This message changed on another device. Your edit is still here; review and save again.");
        } else if (snapshot) {
          setEvents((prev) => prev.map((item) => (item.event_id === snapshot.event_id ? snapshot : item)));
          onEventAccepted?.(snapshot);
          toast.error(e instanceof ApiError ? e.message : String(e));
        } else {
          toast.error(e instanceof ApiError ? e.message : String(e));
        }
        throw e;
      }
    },
    [events, onEventAccepted, setEditingEvent, setEvents],
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

  const renderedEvents = events;

  // Aggregate reactions: target_event_id → { emoji → [sender_handle] }
  const reactionsByTarget = React.useMemo(() => {
    const map = aggregateReactions(renderedEvents);
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
  }, [renderedEvents, myUsername, reactionOverrides]);

  // Visible events drop reactions (they render as chips under the target) and
  // deleted/redacted messages (hidden entirely — no "message deleted" row).
  // ALL progress events stay out of the timeline (live ones render as the
  // transient ProgressLine instead). Letting done-progress through used to
  // break the (sender, minute) run.
  const visibleEvents = React.useMemo(
    () => renderedEvents.filter(isTimelineEvent),
    [renderedEvents],
  );

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
    for (const e of renderedEvents) m.set(e.event_id, e);
    return m;
  }, [renderedEvents]);

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
      // A reply/search jump transfers ownership away from bottom-follow. Keep
      // it instantaneous so subsequent reader input cannot race a browser
      // smooth-scroll animation or a delayed second correction.
      releaseBottomStick();
      node.scrollIntoView({ block: "center", behavior: "auto" });
      node.focus({ preventScroll: true });
      setHighlightedEventId(renderedId);
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedEventId((cur) => (cur === renderedId ? null : cur));
      }, 2300);
      return true;
    },
    [releaseBottomStick, renderedEventIdFor],
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

  /* eslint-disable react-hooks/immutability -- The history cursor and anchor below are callback-local primitives. React's immutability rule incorrectly taints them as the `room` prop after api.historyPage(). */
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
        let lookupCursor: string | undefined =
          priorState?.status === "continue" && priorState.cursor
            ? priorState.cursor
            : "";
        let lookupAnchor: string | undefined = lookupCursor ? undefined : loadedOldest;
        let traversal: HistoryTraversal = {
          throughEventId:
            priorState?.status === "continue"
              ? priorState.throughEventId
              : undefined,
          seenEventIds: new Set<string>(),
          oldestEventId:
            priorState?.status === "continue"
              ? priorState.oldestEventId
              : lookupAnchor,
        };
        let found: Event | null = null;
        const seenCursors = new Set<string>();
        const deadline = Date.now() + 5000;
        let pages = 0;
        let recoveredExpiredCursor = false;
        let recoveredRejectedAnchor = false;
        while ((lookupCursor !== undefined || lookupAnchor) && pages < 15 && Date.now() < deadline) {
          if (lookupCursor && seenCursors.has(lookupCursor)) {
            throw new SyncIntegrityError(
              "history",
              "page_invariant",
              "We couldn’t open that message. Try again.",
              { roomId: room.room_id },
            );
          }
          if (lookupCursor) seenCursors.add(lookupCursor);
          let page;
          try {
            page = await api.historyPage(
              room.room_id,
              lookupCursor ?? "",
              PAGE_SIZE,
              "backward",
              lookupCursor ? undefined : lookupAnchor,
            );
          } catch (error) {
            const code =
              error instanceof ApiError && error.body && typeof error.body === "object" &&
              "code" in error.body
                ? String((error.body as { code?: unknown }).code ?? "")
                : "";
            if (
              !recoveredRejectedAnchor &&
              !lookupCursor &&
              lookupAnchor &&
              error instanceof ApiError &&
              error.status === 400
            ) {
              recoveredRejectedAnchor = true;
              lookupAnchor = undefined;
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
            lookupCursor = "";
            lookupAnchor = events.find((e) => !e.event_id.startsWith("temp-"))?.event_id;
            traversal = {
              throughEventId: undefined,
              seenEventIds: new Set<string>(),
              oldestEventId: lookupAnchor,
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
            lookupCursor = undefined;
            break;
          }
          setEvents((prev) => {
            const finalized = older.map((event) => ({
              ...event,
              is_final: event.is_final !== false,
            }));
            return mergeServerEvents(
              prev,
              finalized,
              room.room_id,
              myUsername,
              timelineOwner,
              timelineDevice,
            );
          });
          found = older.find((e) => e.event_id === eventId) ?? null;
          if (found) break;
          if (!page.has_more || !page.cursor) {
            setHasMore(false);
            lookupCursor = undefined;
            break;
          }
          lookupCursor = page.cursor;
          lookupAnchor = undefined;
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
            [eventId]: lookupCursor
              ? {
                  status: "continue",
                  cursor: lookupCursor,
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
      setEvents,
    ],
  );
  /* eslint-enable react-hooks/immutability */

  React.useEffect(() => {
    const eventId = takeRoomEventJump(room.room_id);
    if (!eventId) return;
    const frame = window.requestAnimationFrame(() => {
      void jumpToReplyTarget(eventId);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [jumpToReplyTarget, room.room_id]);

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
      // Reaching this point means the user has committed an outgoing intent.
      // Sending from an open room proves the currently-known
      // inbound tail was attended, so clear its badge before painting the
      // optimistic row. A later concurrent inbound event can still become
      // unread through the normal websocket reducer.
      onSendIntent?.();
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
        at: nowMs,
      });
      // No progress is synthesized here. The activity row appears only after
      // an actual Stemcell progress frame arrives.
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
      onSendIntent,
      room.room_id,
      setEvents,
      timelineDevice,
      timelineOwner,
    ],
  );

  const onAck = React.useCallback((clientId: string, real: Event) => {
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
    onEventAccepted?.(accepted);
    // Keep the accepted text in the sidebar until its room projection catches
    // this exact event. Clearing first can expose the previous message for a
    // render (or indefinitely when a slower room snapshot races the ack).
    markPendingPreviewAccepted(room.room_id, clientId, {
      eventId: accepted.event_id,
      at: accepted.created_at,
    });
    appendRoomEventSnippet(room.room_id, {
      ...accepted,
      _status: "sent",
    } as LocalEvent);
    // A direct response is the one additional trusted binding source when an
    // older Glass server omits transaction_id. The reconciler collapses a WS
    // echo that raced ahead of this response into the original local row.
    setEvents((prev) =>
      mergeServerEvents(
        prev,
        [accepted],
        room.room_id,
        myUsername,
        timelineOwner,
        timelineDevice,
        clientId,
      ),
    );
    if (real.delivery_state === "queued_for_maintenance") {
      const queuedFor = real.maintenance_recipients?.length
        ? real.maintenance_recipients
        : real.maintenance
          ? [real.maintenance]
          : [];
      const names = queuedFor
        .map((recipient) => recipient.name)
        .filter((name): name is string => Boolean(name));
      toast.info("Message safely queued", {
        id: `maintenance-queued:${real.event_id}`,
        description:
          names.length === 1
            ? `${names[0]} is updating. ${
              real.delivery_acknowledgement ||
              "You do not need to resend this message."
            }`
            : real.delivery_acknowledgement ||
              "Silicon is updating. You do not need to resend this message.",
      });
    }
  }, [
    room.room_id,
    myUsername,
    setEvents,
    timelineDevice,
    timelineOwner,
    onEventAccepted,
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
    [room.room_id, setEvents],
  );

  const onFail = React.useCallback(
    (clientId: string, err: unknown) => {
      const current = events.find((event) => event._clientId === clientId);
      // A response/socket acceptance and a local request failure can race. An
      // authoritative id always wins: do not persist, render, or preview the
      // late failure after Glass has accepted this exact transaction.
      if (
        readTimelineIdentity(timelineOwner, clientId)?.eventId ||
        (current && hasAuthoritativeEventId(current))
      ) {
        markPendingPreviewAccepted(room.room_id, clientId);
        setEvents((prev) =>
          prev.map((event) =>
            event._clientId === clientId
              ? { ...event, _failure: undefined, _nextAttemptAt: undefined }
              : event,
          ),
        );
        return;
      }
      const owner = authStore.getCarbon()?.carbon_id;
      if (owner) void persistOutboxFailure(owner, clientId, err).catch(() => false);
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
        prev.map((event) => {
          if (event._clientId !== clientId) return event;
          // Acceptance may have committed since the callback captured
          // `events`; re-check inside the state update as the final guard.
          if (hasAuthoritativeEventId(event)) {
            return { ...event, _failure: undefined, _nextAttemptAt: undefined };
          }
          return {
                ...event,
                _status: statusAfterSendFailure(
                  event._status,
                  status,
                  event.event_id,
                ) as MessageStatus | undefined,
                _failure: classified.failure,
                _nextAttemptAt: classified.failure.nextAttemptAt,
              };
        }),
      );
      if ((status === "failed" || status === "challenge") && failureChangesVisibleState) {
        failPendingPreview(room.room_id, clientId);
      }
      setActiveProgress((prev) => (prev?.groupId === `local:${clientId}` ? null : prev));
      if (status === "failed" && failureChangesVisibleState) {
        toast.error(sendFailureMessage(classified.failure));
      }
    },
    [events, room.room_id, setEvents, timelineOwner],
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
  }, [events, room.room_id, setEvents]);

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
          at: Date.now(),
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
    [room.room_id, onAck, onFail, setEvents],
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
        at: row.at,
      });
    },
    [room.room_id, setEvents],
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
            toast.info("Session renewal will keep retrying automatically.");
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
          const localUrl = event.content.local_url;
          if (typeof localUrl === "string" && localUrl.startsWith("blob:")) {
            URL.revokeObjectURL(localUrl);
          }
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
          toast.info("Session renewal will keep retrying automatically.");
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
      setEvents,
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
  const filteredEvents = React.useMemo(() => {
    // No active query (closed, or open-but-empty) → the normal loaded window.
    if (!search?.trim()) return visibleEvents;
    // Active query → server search results across the whole history, sorted
    // chronologically so the timeline (day bands, grouping) reads top→bottom.
    return ([...(searchResults ?? [])] as LocalEvent[]).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
  }, [search, searchResults, visibleEvents]);

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
  const canonicalDisplayRows = React.useMemo(
    () => dedupeWorkTimelineEnvelopes(displayRows),
    [displayRows],
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
  // Show the progress line whenever there's active progress for this room. We
  // no longer suppress it just because the latest visible event is from a
  // silicon: progress is cleared the moment a real message lands (both locally
  // and in the page-level cache), so a lingering entry genuinely means work is
  // still in flight — including inter-silicon chats where every message is a
  // silicon, and multi-step tasks that post then keep working.
  const progressStaleMs = activeProgress ? progressNow - activeProgress.updatedAt : 0;
  const shouldShowActiveProgress =
    !search &&
    activeProgress?.roomId === room.room_id &&
    progressStaleMs < MANAGER_ACTIVITY_STALE_MS;
  const managerActivityGroups = React.useMemo(
    () => presentedManagerActivityGroups(
      managerActivityState,
      room.room_id,
      { asOfMs: progressNow },
    ),
    [managerActivityState, progressNow, room.room_id],
  );
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
  const progressAvatarSrc = React.useMemo(() => {
    if (!progressAvatarHandle) return headerPhoto;
    return photoFor("silicon", progressAvatarHandle) ?? headerPhoto;
  }, [progressAvatarHandle, photoFor, headerPhoto]);
  const displayedManagerGroups = React.useMemo(
    () => !search && !holdingMessage ? managerActivityGroups : [],
    [holdingMessage, managerActivityGroups, search],
  );
  const managerPlacement = React.useMemo(
    () => placeManagerActivityGroups(
      displayedManagerGroups,
      canonicalDisplayRows,
    ),
    [canonicalDisplayRows, displayedManagerGroups],
  );

  // Fold the authoritative timeline into sender panels without moving durable
  // events. Manager activity is an ephemeral overlay rather than a stream row,
  // so weave an unmatched run in at its first activity timestamp. This keeps
  // durable work it initiated (for example a Silicon call) below its parent
  // activity while retaining the canonical order of all server events.
  const timelineItems = React.useMemo(() => {
    type Party = "carbon" | "silicon";
    type Row = (typeof displayRows)[number];
    type Item =
      | { kind: "panel"; party: Party; events: Row[]; key: string; dayLabel: string | null }
      | { kind: "system"; event: Row; key: string; dayLabel: string | null }
      | {
          kind: "manager";
          group: ManagerActivityGroup;
          key: string;
          dayLabel: string | null;
        }
      | { kind: "progress"; key: string; dayLabel: string | null };
    const keyOf = (e: Row) => timelineRenderKey(e);
    const isSystem = (e: Row) => e.type === "m.system" || e.type === "m.session_marker";
    const partyOf = (e: Row): Party => (e.sender_kind === "silicon" ? "silicon" : "carbon");
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    };

    const rows: Row[] = preserveCanonicalTimelineOrder(canonicalDisplayRows);

    const runActive = !search && shouldShowActiveProgress && !holdingMessage;

    const raw: Array<{ item: Item; iso: string }> = [];
    let cur: { party: Party; events: Row[] } | null = null;
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
    };
    const pushManager = (
      group: ManagerActivityGroup,
      fallbackIso: string,
    ) => {
      flush();
      raw.push({
        item: {
          kind: "manager",
          group,
          key: `manager:${group.room_id}:${group.progress_group_id}`,
          dayLabel: null,
        },
        iso: group.history[0]?.occurred_at ?? fallbackIso,
      });
    };
    const trailingManagers = managerPlacement.trailing.map((group, index) => ({
      group,
      index,
      iso: group.history[0]?.occurred_at ?? group.updated_at,
    })).sort((left, right) => {
      const leftAt = Date.parse(left.iso);
      const rightAt = Date.parse(right.iso);
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
        return leftAt - rightAt;
      }
      if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) {
        return Number.isFinite(leftAt) ? -1 : 1;
      }
      return left.index - right.index;
    });
    let nextManagerIndex = 0;
    const pushManagersThrough = (iso: string) => {
      const eventAt = Date.parse(iso);
      if (!Number.isFinite(eventAt)) return;
      while (nextManagerIndex < trailingManagers.length) {
        const manager = trailingManagers[nextManagerIndex];
        const managerAt = Date.parse(manager.iso);
        if (!Number.isFinite(managerAt) || managerAt > eventAt) break;
        pushManager(manager.group, manager.iso || iso);
        nextManagerIndex += 1;
      }
    };
    for (const e of rows) {
      pushManagersThrough(e.created_at);
      lastIso = e.created_at;
      if (isSystem(e)) {
        flush();
        raw.push({ item: { kind: "system", event: e, key: keyOf(e), dayLabel: null }, iso: e.created_at });
      } else {
        const p = partyOf(e);
        const previous = cur?.events[cur.events.length - 1];
        if (
          !cur ||
          cur.party !== p ||
          !previous ||
          !belongsToSameTimelinePanel(previous, e, cur.events[0])
        ) {
          flush();
          cur = { party: p, events: [] };
        }
        cur.events.push(e);
      }
    }
    flush();
    while (nextManagerIndex < trailingManagers.length) {
      const manager = trailingManagers[nextManagerIndex];
      pushManager(manager.group, manager.iso || lastIso);
      nextManagerIndex += 1;
    }
    // Legacy live Stemcell activity has no normalized manager group.
    if (runActive && displayedManagerGroups.length === 0) pushProgress(lastIso);
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
    canonicalDisplayRows,
    search,
    shouldShowActiveProgress,
    holdingMessage,
    displayedManagerGroups,
    managerPlacement,
  ]);

  // Keep every loaded row mounted. Message panels have dynamic heights (media,
  // link previews, edits and progress rows), so recycling them from estimates
  // can move the viewport when a row is measured or an ordinary click rerenders.
  // History remains paged; stable mounted nodes keep scroll and selections exact.
  React.useLayoutEffect(() => {
    const remembered = pendingRoomScrollRestoreRef.current;
    const scroller = scrollerRef.current;
    if (!remembered || !scroller || timelineItems.length === 0 || search?.trim()) return;

    const frame = window.requestAnimationFrame(() => {
      if (pendingRoomScrollRestoreRef.current !== remembered) return;
      const node = remembered.anchorEventId
        ? messageNodeRefs.current.get(remembered.anchorEventId)
        : null;
      if (node?.isConnected) {
        const actualOffset =
          node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.scrollTop += actualOffset - remembered.anchorOffset;
      } else {
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.min(remembered.scrollTop, maxTop);
      }
      pendingRoomScrollRestoreRef.current = null;
      initialBottomPendingRef.current = false;
      stickToBottomRef.current = false;
      timelineTailVisibleRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [search, timelineItems]);

  // The visual tail is authoritative for the page-down arrow. The last chat
  // message may be followed by any number of manager/progress/work-update rows,
  // and a room can temporarily contain those rows without a message at all.
  const renderedTimelineTailIsVisible = React.useCallback(() => {
    const scroller = scrollerRef.current;
    const tail = timelineTailRef.current;
    if (!scroller || !tail) return false;
    const viewport = scroller.getBoundingClientRect();
    const marker = tail.getBoundingClientRect();
    return timelineTailIsVisible({
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      tailTop: marker.top,
      tailBottom: marker.bottom,
    });
  }, []);

  // Restore the exact event/pixel captured before a prepend. Keep the anchor
  // alive after this first pre-paint correction: late media/preview sizing is
  // corrected by the ResizeObserver below until the reader takes control.
  React.useLayoutEffect(() => {
    if (preserveHistoryViewportAnchor(true)) return;
    if (shouldPinOwnedTimelineTail({
      followingBottom: stickToBottomRef.current,
      selectionActive: textSelectionActiveRef.current,
    })) {
      scrollToBottom();
    }
  }, [preserveHistoryViewportAnchor, scrollToBottom, timelineItems]);

  // Composer banners, fonts, and media can resize either the viewport or its
  // contents. Preserve bottom-follow intent without timed repeat-jumps on
  // initial load; scrolling into history disables the correction immediately.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    const content = timelineContentRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    let viewportHeight = scroller.clientHeight;
    let contentHeight = scroller.scrollHeight;
    const observer = new ResizeObserver(() => {
      const nextViewportHeight = scroller.clientHeight;
      const nextContentHeight = scroller.scrollHeight;
      if (nextViewportHeight === viewportHeight && nextContentHeight === contentHeight) return;
      viewportHeight = nextViewportHeight;
      contentHeight = nextContentHeight;
      if (preserveHistoryViewportAnchor()) {
        const tailVisible = renderedTimelineTailIsVisible();
        timelineTailVisibleRef.current = tailVisible;
        setTimelineAtBottom(tailVisible);
        return;
      }
      if (shouldPinOwnedTimelineTail({
        followingBottom: stickToBottomRef.current,
        selectionActive: textSelectionActiveRef.current,
      })) {
        keepOwnedBottomPinned();
      } else {
        const tailVisible = renderedTimelineTailIsVisible();
        timelineTailVisibleRef.current = tailVisible;
        setTimelineAtBottom(tailVisible);
      }
    });
    observer.observe(scroller);
    if (content) observer.observe(content);
    return () => {
      cancelPendingBottomScroll();
      observer.disconnect();
    };
  }, [
    cancelPendingBottomScroll,
    hydrated,
    renderedTimelineTailIsVisible,
    preserveHistoryViewportAnchor,
    room.room_id,
    keepOwnedBottomPinned,
    timelineItems.length,
  ]);

  const updateTimelineBottomState = React.useCallback(() => {
    // Scroll events can be generated by message/media/reaction/card geometry,
    // browser anchoring, or our own correction. They are not evidence of user
    // intent and therefore must never revoke bottom-follow ownership. Wheel,
    // touch, pointer, keyboard, and selection handlers do that synchronously.
    const tailVisible = renderedTimelineTailIsVisible();
    timelineTailVisibleRef.current = tailVisible;
    setTimelineAtBottom(tailVisible);
    if (tailVisible) setUnseenBelow(0);
  }, [renderedTimelineTailIsVisible]);

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

  const seeProfileAttachmentInChat = React.useCallback(
    (eventId: string, targetRoomId: string) => {
      setProfileOpen(false);
      setFocusSender(null);
      if (targetRoomId === room.room_id) {
        void jumpToReplyTarget(eventId);
        return;
      }
      queueRoomEventJump(targetRoomId, eventId);
      router.push(`/chat?room=${encodeURIComponent(targetRoomId)}`);
    },
    [jumpToReplyTarget, room.room_id, router],
  );

  // §2.7 — load the previous page of history (the API supports a `before`
  // cursor). Prepends older events; the stable event/pixel snapshot keeps the
  // viewport anchored (see the prepend effect above).
  const loadOlder = React.useCallback(async () => {
    if (loadingOlderRef.current || !hasMore) return;
    if (!historyCursor) return;
    if (!historyBoundaryEventId) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const requestedRoomId = room.room_id;
    let indicatorVisibleAt = performance.now();
    try {
      await waitForOlderHistoryIndicatorPaint();
      indicatorVisibleAt = performance.now();
      if (activeRoomIdRef.current !== requestedRoomId) return;
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
      if (activeRoomIdRef.current !== requestedRoomId) return;
      if (older.length === 0) {
        setHasMore(false);
        setHistoryCursor(null);
        setHistoryBoundaryEventId(null);
        return;
      }
      // Snapshot scroll metrics right before the prepend so the layout effect
      // can restore the exact viewport (older messages add height ABOVE).
      captureHistoryViewportAnchor(older);
      // Commit the prepend and restore its saved event/pixel in one browser
      // task. No intermediate paint can expose the absolute top of the newly
      // taller document, even when the page came from IndexedDB or memory.
      flushSync(() => {
        setEvents((prev) => {
          const finalized = older.map((event) => ({
            ...event,
            is_final: event.is_final !== false,
          }));
          return mergeServerEvents(
            prev,
            finalized,
            room.room_id,
            myUsername,
            timelineOwner,
            timelineDevice,
          );
        });
        setHasMore(olderHasMore);
        setHistoryCursor(olderCursor);
        setHistoryBoundaryEventId(olderBoundaryEventId);
      });
      preserveHistoryViewportAnchor(true);
      reportHistoryHealthy();
      void persistHistoryEvents(older).catch(() => undefined);
    } catch (e) {
      reportHistoryFailure(e);
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      const remainingIndicatorMs = Math.max(
        0,
        OLDER_LOADING_MIN_MS - (performance.now() - indicatorVisibleAt),
      );
      if (remainingIndicatorMs > 0) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, remainingIndicatorMs);
        });
      }
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
    captureHistoryViewportAnchor,
    persistHistoryEvents,
    preserveHistoryViewportAnchor,
    setEvents,
  ]);

  // If the history cursor arrives while the viewport is already parked at the
  // top, no scroll event remains to trigger the first prepend. Recheck that
  // edge whenever pagination becomes ready or a page finishes.
  React.useEffect(() => {
    const scroller = scrollerRef.current;
    if (!hydrated || !scroller) return;
    if (shouldLoadOlderNearTimelineTop({
      scrollTop: scroller.scrollTop,
      hasMore,
      loadingOlder: loadingOlderRef.current,
    })) {
      void loadOlder();
    }
  }, [hasMore, hydrated, historyCursor, loadOlder, loadingOlder]);

  // One timeline item's content (day band + body). Shared by the main history
  // list and the bounded search-results list.
  type TimelineRow = (typeof timelineItems)[number];
  const renderTimelineItem = (item: TimelineRow): React.ReactNode => {
    const dayBand = item.dayLabel ? (
      <div className="py-1 text-center text-[10px] text-muted-foreground">{item.dayLabel}</div>
    ) : null;
    if (item.kind === "system") {
      return (
        <>
          {dayBand}
          <div
            ref={(node) => {
              if (node) messageNodeRefs.current.set(item.event.event_id, node);
              else messageNodeRefs.current.delete(item.event.event_id);
            }}
            data-event-id={item.event.event_id}
            data-stream-position={item.event.stream_position}
          >
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
          </div>
        </>
      );
    }
    if (item.kind === "manager") {
      return (
        <>
          {dayBand}
          <div className="my-3">
            <WorkManagerActivityHistory
              group={item.group}
              avatarSeed={
                (progressAvatarHandle
                  ? peerByHandle.get(progressAvatarHandle)?.id
                  : null) ||
                progressAvatarHandle ||
                headerSeed
              }
              avatarSrc={progressAvatarSrc}
              avatarAsciiSrc={
                progressAvatarHandle
                  ? asciiFor("silicon", progressAvatarHandle) ?? headerAscii
                  : headerAscii
              }
              avatarFamily={
                (progressAvatarHandle
                  ? peerByHandle.get(progressAvatarHandle)?.kind
                  : null) ?? "silicon"
              }
            />
          </div>
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
                const settled = settleCachedManagerActivity(room.room_id, {
                  reason: "dismissed",
                  progress_group_id: activeProgress.groupId,
                  occurred_at: new Date().toISOString(),
                });
                setManagerActivityState(settled);
                clearRoomProgress(room.room_id);
                setActiveProgress(cachedManagerProgress(room.room_id));
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
            const renderedId = e.event_id;
            const attachedManagerGroups =
              managerPlacement.attachedToEvent.get(renderedId) ?? [];
            const authoritative = hasAuthoritativeEventId(e);
            const parsedWorkCandidate = parseWorkTimelineRecord(e.type, e.content);
            const parsedWork = parsedWorkCandidate && (
              parsedWorkCandidate.type === "m.work_task"
                ? parsedWorkCandidate.task.room_id === room.room_id
                : parsedWorkCandidate.event.room_id === room.room_id
            )
              ? parsedWorkCandidate
              : null;
            const workRecord = parsedWork
              ? materializedWorkRecord(workUpdateState, parsedWork)
              : null;
            const workEventIsMine = isMyEvent(e, myUsername);
            const showWorkUpdateAvatar =
              workRecord !== null &&
              !workEventIsMine &&
              e.sender_kind === "silicon";
            return (
              <React.Fragment key={timelineRenderKey(e)}>
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
                {workRecord ? (
                  <div
                    className={cn(
                      "flex w-full items-start",
                      workEventIsMine ? "justify-end" : "justify-start",
                      showWorkUpdateAvatar && "gap-2",
                    )}
                  >
                    {showWorkUpdateAvatar ? (
                      <IdAvatar
                        seed={e.sender_public_id || e.sender_handle || "?"}
                        src={photoFor(e.sender_kind, e.sender_handle)}
                        asciiSrc={asciiFor(e.sender_kind, e.sender_handle)}
                        size={28}
                        family="silicon"
                        className="mt-0.5"
                      />
                    ) : null}
                    <WorkEventCard
                      event={workRecord}
                      task={
                        workRecord.type === "m.work_event" && workRecord.event.task_id
                          ? workUpdateState.tasks[workRecord.event.task_id]
                          : undefined
                      }
                      onReply={
                        readOnly || !authoritative || workRecord.type !== "m.work_event" ||
                          workRecord.event.kind !== "blocker"
                          ? undefined
                          : () => onReply(e)
                      }
                    />
                  </div>
                ) : (
                <MessageBubble
                  event={e}
                  isMine={isMyEvent(e, myUsername)}
                  managerActivity={
                    attachedManagerGroups.length ? (
                      <div className="space-y-1">
                        {attachedManagerGroups.map((group) => (
                          <WorkManagerActivityHistory
                            key={`${group.room_id}:${group.progress_group_id}`}
                            group={group}
                            className="max-w-none"
                          />
                        ))}
                      </div>
                    ) : undefined
                  }
                  myHandle={myUsername}
                  roomId={room.room_id}
                  onAttachAnnotations={readOnly ? undefined : onAttachAnnotations}
                  onOpenAnnotation={readOnly ? undefined : onOpenAnnotation}
                  replyToEvent={e.reply_to_event_id ? eventById.get(e.reply_to_event_id) : undefined}
                  onJumpToEvent={jumpToReplyTarget}
                  replyJumpState={e.reply_to_event_id ? replyJumpState[e.reply_to_event_id] : undefined}
                  isDirect={room.kind === "direct"}
                  status={isMyEvent(e, myUsername)
                    ? bestStatus(
                        bestStatus(e._status, e.delivery?.state),
                        room.last_event?.event_id === e.event_id
                          ? room.last_event.delivery?.state
                          : undefined,
                      )
                    : e._status}
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
                  showSender={j === 0}
                  showTime={j === item.events.length - 1}
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
                )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </>
    );
  };

  // The composer's "holding…" pre-send state — rendered at the timeline tail.
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
      <header
        className={cn(
          "group/header relative z-10 flex h-[68px] items-center gap-3 border-b bg-elevated pr-6 shadow-[0_2px_12px_-6px_rgba(60,50,36,0.14)]",
          onBack ? "pl-3 md:pl-6" : "pl-6",
        )}
      >
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="grid h-9 w-9 shrink-0 place-items-center transition-colors hover:bg-accent md:hidden"
            aria-label="back to conversations"
          >
            <CaretLeft className="h-4 w-4" weight="bold" />
          </button>
        ) : null}
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
        currentCarbon={carbon}
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
        onSeeInChat={seeProfileAttachmentInChat}
      />

      {/* data-private masks all message text out of PostHog session replays
          (see instrumentation-client.ts maskTextSelector). */}
      <div
        ref={timelineInteractionRef}
        className="relative flex min-h-0 min-w-0 flex-1"
      >
      {searching ? (
        // Search results are a small, bounded set with their own plain scroll area.
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
        <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">Loading…</div>
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
        <div
          key={room.room_id}
          ref={(node) => {
            scrollerRef.current = node;
          }}
          data-private
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none] [overscroll-behavior-y:contain]"
          onPointerDownCapture={(event) => {
            if (event.button === 0 && event.target === event.currentTarget) {
              // A pointer on the bare surface includes scrollbar interaction,
              // but merely pressing it is not an upward-scroll intent. Keep an
              // arrow-acquired follow epoch until the scrollbar actually moves
              // toward history.
              scrollbarGestureRef.current = {
                lastScrollTop: event.currentTarget.scrollTop,
              };
              cancelPendingBottomScroll();
            }
          }}
          onPointerUpCapture={() => {
            scrollbarGestureRef.current = null;
          }}
          onPointerCancelCapture={() => {
            scrollbarGestureRef.current = null;
          }}
          onWheelCapture={(event) => {
            clearHistoryViewportAnchor(true);
            // A wheel gesture owns the viewport immediately. Even a downward
            // gesture can arrive while the page-down animation is still
            // writing scrollTop; stop that writer before native scrolling.
            cancelBottomAnimation();
            cancelPendingBottomScroll();
            if (
              initialBottomPendingRef.current ||
              wheelMovesTowardTimelineHistory(event.deltaY)
            ) {
              releaseBottomStick();
            } else {
              returningToBottomRef.current = event.deltaY > 0;
            }
          }}
          onTouchStartCapture={(event) => {
            clearHistoryViewportAnchor(true);
            cancelBottomAnimation();
            if (initialBottomPendingRef.current) releaseBottomStick();
            else cancelPendingBottomScroll();
            returningToBottomRef.current = false;
            lastTouchClientYRef.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchMoveCapture={(event) => {
            const currentY = event.touches[0]?.clientY;
            const previousY = lastTouchClientYRef.current;
            if (
              currentY !== undefined &&
              previousY !== null &&
              touchMovesTowardTimelineHistory(previousY, currentY)
            ) {
              releaseBottomStick();
            } else {
              returningToBottomRef.current =
                currentY !== undefined &&
                previousY !== null &&
                previousY - currentY > 1;
              cancelPendingBottomScroll();
            }
            lastTouchClientYRef.current = currentY ?? null;
          }}
          onTouchEndCapture={() => {
            lastTouchClientYRef.current = null;
          }}
          onTouchCancelCapture={() => {
            lastTouchClientYRef.current = null;
          }}
          onKeyDownCapture={(event) => {
            const scrollKey = [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key);
            if (scrollKey) {
              clearHistoryViewportAnchor(true);
              cancelBottomAnimation();
              cancelPendingBottomScroll();
            }
            if (
              initialBottomPendingRef.current ||
              keyMovesTowardTimelineHistory(event.key, event.shiftKey)
            ) {
              releaseBottomStick();
            } else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) {
              returningToBottomRef.current = true;
            }
          }}
          onScroll={(event) => {
            const scroller = event.currentTarget;
            const scrollbarGesture = scrollbarGestureRef.current;
            if (scrollbarGesture) {
              if (scroller.scrollTop < scrollbarGesture.lastScrollTop - 1) {
                releaseBottomStick();
              }
              scrollbarGesture.lastScrollTop = scroller.scrollTop;
            }
            if (returningToBottomRef.current) acquireBottomFollowAtCurrentTail();
            updateTimelineBottomState();
            if (shouldLoadOlderNearTimelineTop({
              scrollTop: scroller.scrollTop,
              hasMore,
              loadingOlder: loadingOlderRef.current,
            })) {
              void loadOlder();
            }
            markVisibleRead();
          }}
        >
          <div ref={timelineContentRef} className="flex min-h-full flex-col justify-end">
            <div className="w-full shrink-0">
              {timelineItems.map((item) => (
                <div key={item.key} className="px-6" style={{ display: "flow-root" }}>
                  {renderTimelineItem(item)}
                </div>
              ))}
            </div>
            {holdingNode ? <div className="px-6">{holdingNode}</div> : null}
            <div ref={timelineTailRef} data-timeline-tail className="h-4 shrink-0" />
          </div>
        </div>
      )}

      {!searching && filteredEvents.length > 0 ? (
        <OlderHistoryLoadingOverlay loadingOlder={loadingOlder} />
      ) : null}

      {/* Keep the affordance mounted so both its entrance and exit ease. */}
      <div
        className={cn(
          "timeline-page-down absolute bottom-4 right-6 z-10 transition-all duration-200 ease-out",
          !timelineAtBottom && !searching
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-2 scale-95 opacity-0",
        )}
      >
        <button
          type="button"
          onClick={() => {
            activateBottomFollowFromArrow();
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
          {siliconMaintenanceActive && (
            <div
              className="flex items-center justify-center gap-2 border-t border-input bg-muted/40 px-6 py-3 text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <WarningCircle
                className="h-3.5 w-3.5 text-amber-500"
                aria-hidden="true"
              />
              <span>{siliconMaintenanceMessage}</span>
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
            delayTextForSilicon={
              DELAY_NEW_SILICON_TEXT_SENDS &&
              room.kind === "direct" &&
              peer?.kind === "silicon"
            }
            voiceTranscriptionDeliveryGate={
              room.kind === "direct" && peer?.kind === "silicon"
            }
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
            onLayoutChange={keepOwnedBottomPinned}
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
  // §1.1 — keep the last live line going while the silicon might still be
  // working (no "no update for Ns" countdown). Only after a long silence do we
  // collapse to a quiet "Still working…" with a dismiss, in case it died with no
  // `done` frame.
  const dead = staleMs >= MANAGER_ACTIVITY_STALE_MS;
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
  const note = publicManagerActivityNote(noteValue, state);
  if (note) return [note];
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
    case "reading":
      return "Reading";
    case "reading_file":
      return "Reading file";
    case "writing":
      return "Writing";
    case "writing_file":
      return "Writing file";
    case "executing":
      return "Executing command";
    case "searching_web":
      return "Searching web";
    case "spawning_worker":
      return "Spawning worker";
    case "calling":
      return "Calling";
    case "done":
      return "Wrapping up";
    case "thinking":
    default:
      return "Working";
  }
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
  roomId: string,
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
      const revised = reconcileRoomTailProjection(existing, incoming);
      const mine = Boolean(revised.sender_handle && revised.sender_handle === myUsername);
      const accepted = hasAuthoritativeEventId(revised);
      return {
        ...revised,
        delivery: mine
          ? mergeDeliverySummaries(existing.delivery, revised.delivery)
          : revised.delivery,
        _status: mine
          ? bestStatus(existing._status, serverDeliveryStatus(revised))
          : existing._status,
        // Attempt-local failures and retry timers must disappear as soon as
        // this row has an authoritative id. Keeping them created the impossible
        // UI state "read/delivered, but failed — sign in".
        _failure: accepted ? undefined : existing._failure,
        _nextAttemptAt: accepted ? undefined : existing._nextAttemptAt,
        _heldChallengeDeviceMismatch: accepted
          ? undefined
          : existing._heldChallengeDeviceMismatch,
        _sendTimeoutAt: accepted ? undefined : existing._sendTimeoutAt,
        _sendTimeoutMs: existing._sendTimeoutMs,
      };
    },
  });
  const merged = reconciled.map((event) => {
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
  const acceptedClientIds = merged
    .filter(
      (event) =>
        hasAuthoritativeEventId(event) &&
        event._clientId &&
        event.sender_handle === myUsername,
    )
    .map((event) => event._clientId as string);
  if (acceptedClientIds.length > 0) {
    // Do not update the sidebar's external store from inside React's state
    // updater. Reconcile it immediately after this update commits instead.
    queueMicrotask(() => {
      for (const clientId of acceptedClientIds) {
        markPendingPreviewAccepted(roomId, clientId);
      }
    });
  }
  return merged;
}
