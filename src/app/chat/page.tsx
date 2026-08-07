"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CircleNotch, MagnifyingGlass, Plus } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { api, ApiError, type GlobalNotificationPreferences } from "@/lib/api";
import { authStore, useAuth } from "@/lib/auth";
import {
  addNotification,
  closeBrowserNotification,
  markRoomNotificationsRead,
  removeNotificationByEvent,
  NOTIFICATION_NAVIGATE_EVENT,
  reportUnreadBadge,
  showBrowserNotification,
  userPresent,
} from "@/lib/notifications";
import { roomDisplay } from "@/lib/peers";
import { playReceived, playReceivedSilicon } from "@/lib/sounds";
import {
  isGenuinelyNewLiveEvent,
  shouldPlayReceivedSound,
} from "@/lib/live-event-notification";
import type {
  AccountSyncUpdate,
  Contact,
  DraftState,
  Event,
  HeldSend,
  ProgressState,
  Room,
  TeamMembership,
  WsFrame,
} from "@/lib/types";
import { clearRoomProgress, getRoomProgress, setRoomProgress } from "@/lib/progress-cache";
import {
  recordManagerActivity,
  settleCachedManagerActivity,
  visibleCachedManagerActivities,
} from "@/lib/work-manager-activity-cache";
import { eventReplacesManagerActivity } from "@/lib/work-manager-activity";
import {
  isResolvedWorkBlocker,
  workEventCountsAsUnread,
  workEventPreview,
  workNotificationTier,
} from "@/lib/work-update-presentation";
import { eventReplayRevisionKey } from "@/lib/event-revision";
import {
  appendRoomEventSnippet,
  readRoomEventSnippet,
  saveRoomEventSnippet,
} from "@/lib/room-snippet";
import { evictCachedMedia } from "@/lib/media-cache";
import { isGifMedia } from "@/lib/media-meta";
import { projectRedactedWindow } from "@/lib/redaction-state";
import {
  mergeRoomReceiptProjection,
  normalizeRoom,
  normalizeRooms,
  replaceRoomsPreservingReceiptFacts,
} from "@/lib/room-shape";
import {
  compareRoomListRows,
  projectArchivedRoomListEntry,
  roomVisibleInArchiveView,
} from "@/lib/room-list-projection";
import {
  retractRoomUnreadEvent,
  roomOpenReadTarget,
  roomProjectsEventAsUnread,
} from "@/lib/unread-boundary";
import { useChatSocket } from "@/lib/ws";
import { mergePresence, observePresenceActivity } from "@/lib/presence-state";
import { readReceiptCoversEvent } from "@/lib/message-receipt";
import {
  mergeDeliverySummaries,
  normalizeDeliverySummary,
} from "@/lib/delivery-state";
import { useTeams } from "@/lib/use-teams";
import { contactKey, useContacts } from "@/lib/use-contacts";
import {
  loadCachedRooms,
  saveCachedRooms,
  loadCachedMemberships,
  saveCachedMemberships,
} from "@/lib/sidebar-cache";
import { dropPendingPreview } from "@/lib/pending-preview";
import {
  allowDraftNavigation,
  applyServerDraft,
  loadAllServerDrafts,
  migrateLegacyDrafts,
  reconcileServerDraftManifest,
} from "@/lib/drafts";
import {
  clearPendingAccountReplay,
  completeDeliveryAcknowledgements,
  commitPendingAccountProjection,
  commitInitialSyncBundle,
  readAccountProjections,
  readInitialSyncBundle,
  readPendingAccountReplay,
  pruneReachableTimelineCache,
  rebuildReachableChatCache,
  storeEvents,
  loadStoredRoomEvents,
  pendingDeliveryAcknowledgements,
  updateInitialRoomProjection,
  updateStoredEventDeliveries,
  type PendingAccountReplay,
  type InitialSyncAccountData,
  type SyncRecoveryRecord,
} from "@/lib/chat-store";
import { probeApiConnectivity } from "@/lib/connectivity-classifier";
import { shouldRunDurableSync } from "@/lib/durable-sync-policy";
import {
  clearSyncCursors,
  getSyncCheckpoint,
  type SyncCheckpoint,
} from "@/lib/sync-cursors";
import {
  isNonBlankString,
  streamVectorEqual,
  streamVectorAdvanced,
  streamVectorBeforeOrEqual,
  streamVectorIncludes,
  SyncIntegrityError,
  validateAccountSyncPage,
  validateEventSyncPage,
  validateHistoryPage,
  validateInitialAccountManifest,
  validateInitialContinuity,
  validateInitialRoomNotificationProjection,
  type SyncStream,
} from "@/lib/sync-integrity";
import { startClientReliabilityTelemetry } from "@/lib/reliability-telemetry";
import {
  parseToolSetupAccountState,
  TOOL_SETUP_STATE_EVENT,
} from "@/lib/tool-setup";
import { isToolSetupRequestId } from "@/lib/tool-setup-request";
import { ToolSetupDialog } from "@/components/chat/tool-setup-dialog";

const DEFAULT_GLOBAL_NOTIFICATIONS: GlobalNotificationPreferences = {
  enabled: true,
  paused_until: "",
  quiet_hours: {
    enabled: false, timezone: "UTC", start: "22:00", end: "07:00",
    weekdays: [0, 1, 2, 3, 4, 5, 6], allow_mentions: true, allow_keywords: true,
  },
  keywords: [],
};

function localNotificationPolicy(
  room: Room,
  event: Event,
  ownerId: string,
  global: GlobalNotificationPreferences,
): { allowed: boolean; preview: boolean; sound: boolean } {
  // Observed rooms are read-only ambient context. They must never emit an
  // in-app sound, browser notification, or toast regardless of saved defaults.
  if (room.observed) return { allowed: false, preview: false, sound: false };
  const roomPolicy = room.notification_preferences;
  const preview = roomPolicy?.show_preview ?? true;
  const sound = roomPolicy?.sound ?? true;
  const now = new Date();
  if (!global.enabled) return { allowed: false, preview, sound };
  if (global.paused_until && Date.parse(global.paused_until) > now.getTime()) {
    return { allowed: false, preview, sound };
  }
  if (roomPolicy?.mode === "mute" &&
      (!roomPolicy.mute_until || Date.parse(roomPolicy.mute_until) > now.getTime())) {
    return { allowed: false, preview, sound };
  }
  const content = event.content as Record<string, unknown>;
  const mentions = Array.isArray(content?.mentions) ? content.mentions : [];
  const mentioned = mentions.some((value) => value === ownerId || value === `@${ownerId}`);
  const text = String(content?.body ?? content?.caption ?? "").normalize("NFKC").toLocaleLowerCase();
  const keyword = global.keywords.some((value) => {
    const needle = value.normalize("NFKC").trim().toLocaleLowerCase();
    if (!needle) return false;
    const at = text.indexOf(needle);
    if (at < 0) return false;
    const word = /[\p{L}\p{N}_]/u;
    return !word.test(text[at - 1] ?? "") && !word.test(text[at + needle.length] ?? "");
  });
  if (roomPolicy?.mode === "mentions" && !mentioned && !keyword) {
    return { allowed: false, preview, sound };
  }
  const quiet = global.quiet_hours;
  if (quiet.enabled) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: quiet.timezone,
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)?.value ?? "";
    const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday"));
    const clock = `${part("hour")}:${part("minute")}`;
    const overnight = quiet.start > quiet.end;
    const active = overnight
      ? (quiet.weekdays.includes(day) && clock >= quiet.start) ||
        (quiet.weekdays.includes((day + 6) % 7) && clock < quiet.end)
      : quiet.weekdays.includes(day) && clock >= quiet.start && clock < quiet.end;
    const exception = (mentioned && quiet.allow_mentions) || (keyword && quiet.allow_keywords);
    if (active && !exception) return { allowed: false, preview, sound };
  }
  return { allowed: true, preview, sound };
}
import {
  classifySyncFailure,
  reportSyncRecovered,
  reportSyncRecovery,
  shouldSurfaceSyncRecovery,
  syncRecoveryState,
  SYNC_RECOVERY_EVENT,
} from "@/lib/sync-recovery";
import {
  ackOutbox,
  listOutbox,
  type OutboxEntry,
} from "@/lib/outbox";
import { recoveredSiliconHoldSeconds } from "@/lib/silicon-hold";
import {
  garbageCollectHeldCancellations,
  findHeldCancellationEvent,
  listHeldCancellations,
  markHeldCancellationProjected,
  maySendHeldOutbox,
  reconcileHeldCancellation,
  withOutboxClientLock,
  type HeldCancellation,
} from "@/lib/held-cancellation";
import {
  acknowledgeMediaSend,
  prepareMediaOutboxPayload,
  sweepAcknowledgedMediaCleanup,
} from "@/lib/media-send";
import { beginPendingSendControl } from "@/lib/pending-send-control";
import {
  ABUSE_CHALLENGE_SOLVED_EVENT,
} from "@/lib/abuse-challenge-store";
import {
  nextOutboxWakeAt,
  OUTBOX_RETRY_SCHEDULED_EVENT,
  persistOutboxFailure,
  persistHeldOutboxState,
  settleResolvingOutboxFailure,
  shouldFlushOutbox,
  type OutboxWakeSignal,
} from "@/lib/outbox-recovery";
import {
  acceptedEvent,
  acceptedHeldSend,
  heldSendRequiringAttention,
  isAmbiguousSendFailure,
} from "@/lib/operation-recovery";
import { decorateDirectAcceptedTimelineEvent } from "@/lib/timeline-identity";
import {
  currentStorageIssue,
  STORAGE_HEALTH_EVENT,
  type StorageHealthIssue,
} from "@/lib/storage-health";
import {
  currentSessionIssue,
  SESSION_HEALTH_EVENT,
  type SessionHealthIssue,
} from "@/lib/session-health";
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

// Normal message types that count toward unread. Durable work events are
// classified from their kind below: milestones/blockers/terminal results count,
// while task snapshots, worker groups, and calls stay in-chat only.
const COUNTABLE_TYPES = new Set([
  "m.text",
  "m.image",
  "m.file",
  "m.album",
  "m.voice",
  "m.tts",
  "m.remote_browser",
]);

function isCountableEvent(ev: Event): boolean {
  if (ev.redacted_at) return false;
  if (ev.type === "m.work_task" || ev.type === "m.work_event") {
    return workEventCountsAsUnread(ev);
  }
  return COUNTABLE_TYPES.has(ev.type);
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
      if (isGifMedia(c.mime, c.filename)) return cap ? `GIF · ${cap}` : "GIF";
      return cap || "photo";
    }
    case "m.file": {
      const name = String(c.filename ?? "").trim();
      const cap = String(c.caption ?? "").trim();
      return name || cap || "attachment";
    }
    case "m.album": {
      const cap = String(c.caption ?? "").trim();
      const count = Array.isArray(c.items) ? c.items.length : 0;
      return cap || (count > 0 ? `${count} attachments` : "attachments");
    }
    case "m.voice":
      return "voice note";
    case "m.remote_browser":
      return "Silicon Browser link";
    case "m.tts": {
      const t = String(c.text ?? "").trim();
      return t ? t.slice(0, 80) : "audio";
    }
    case "m.work_task":
    case "m.work_event":
      return workEventPreview(ev);
    default:
      return null;
  }
}

function notificationBody(ev: Event): string {
  const preview = eventPreview(ev) ?? "New message";
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

function eventNotificationTier(ev: Event) {
  if (ev.type === "m.work_task" || ev.type === "m.work_event") {
    return workNotificationTier(ev);
  }
  return isCountableEvent(ev) ? "push" as const : "none" as const;
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
import { useChatConnectionBanner } from "@/components/chat/chat-connection-banner";
import { CommandMenu } from "@/components/chat/command-menu";
import { KeymapCheatsheet } from "@/components/chat/keymap-cheatsheet";
import {
  TeamFilterBar,
  TeamSlider,
  EMPTY_FILTERS,
  OTHERS_TAB,
  OBSERVING_TAB,
  type ChatFilters,
} from "@/components/teams/team-filter-bar";
import { TeamPanel } from "@/components/teams/team-panel";
import { PaymentBanner } from "@/components/teams/payment-banner";

// Resizable sidebar bounds + storage. Width persists across reloads.
const SB_DEFAULT = 320;
const SB_MIN = 240;
const SB_MAX = 560;
const SB_STORAGE = "silicon-interface:sidebar-width";
// Shared empty set so rooms with no resolved team return a stable reference.
const EMPTY_SLUGS: ReadonlySet<string> = new Set<string>();
const REMOTE_SYNC_STREAMS = ["events", "account", "initial"] as const;
type SyncBarrierContext = { generation: number; signal: AbortSignal };

// Persist which folder is drilled-into, per team, so a reload (or team switch)
// reopens it instead of dropping back to the top-level list.
const OPEN_FOLDER_KEY = "silicon-interface:open-folder";
function loadOpenFolder(ownerId: string | null, teamSlug: string | null): string | null {
  if (typeof window === "undefined" || !ownerId || !teamSlug) return null;
  try {
    const raw = window.localStorage.getItem(`${OPEN_FOLDER_KEY}:${ownerId}`);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return map[teamSlug] ?? null;
  } catch {
    return null;
  }
}
function saveOpenFolder(ownerId: string | null, teamSlug: string | null, groupId: string | null) {
  if (typeof window === "undefined" || !ownerId || !teamSlug) return;
  try {
    const key = `${OPEN_FOLDER_KEY}:${ownerId}`;
    const raw = window.localStorage.getItem(key);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (groupId) map[teamSlug] = groupId;
    else delete map[teamSlug];
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* storage unavailable — ignore */
  }
}

function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SB_DEFAULT;
  try {
    const v = Number(window.localStorage.getItem(SB_STORAGE));
    return Number.isFinite(v) && v >= SB_MIN && v <= SB_MAX ? v : SB_DEFAULT;
  } catch {
    return SB_DEFAULT;
  }
}

// Persist the sidebar filters (team selection, unread, kinds) so a reload keeps
// whatever the user was filtered to.
const FILTERS_STORAGE = "silicon-interface:chat-filters";
function loadFilters(): ChatFilters {
  if (typeof window === "undefined") return EMPTY_FILTERS;
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE);
    if (!raw) return EMPTY_FILTERS;
    const f = JSON.parse(raw) as Partial<ChatFilters>;
    return {
      unread: !!f.unread,
      kinds: Array.isArray(f.kinds) ? f.kinds.filter((k) => k === "carbon" || k === "silicon") : [],
      teams: Array.isArray(f.teams) ? f.teams.filter((t) => typeof t === "string") : [],
    };
  } catch {
    return EMPTY_FILTERS;
  }
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
  React.useEffect(() => {
    startClientReliabilityTelemetry();
  }, []);
  const lastSafeChatUrlRef = React.useRef(
    typeof window === "undefined"
      ? "/chat"
      : `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  // Same-route URL updates via the History API (Next syncs these into
  // useSearchParams) so opening a chat / switching views never triggers a full
  // navigation — which, once the route cache went stale, was hard-reloading the
  // whole page instead of just swapping the open chat.
  const allowDurableNavigation = React.useCallback(() => {
    return allowDraftNavigation();
  }, []);
  const navigate = React.useCallback((url: string) => {
    if (!allowDurableNavigation()) return;
    window.history.pushState(null, "", url);
    lastSafeChatUrlRef.current = url;
  }, [allowDurableNavigation]);
  React.useEffect(() => {
    const guardBrowserHistory = () => {
      if (allowDurableNavigation()) {
        lastSafeChatUrlRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        return;
      }
      // popstate fires after the browser changes the URL. Put the last safe
      // entry back synchronously so a failed dual-store draft never unmounts
      // with its only remaining copy in React memory.
      window.history.pushState(null, "", lastSafeChatUrlRef.current);
    };
    window.addEventListener("popstate", guardBrowserHistory);
    return () => window.removeEventListener("popstate", guardBrowserHistory);
  }, [allowDurableNavigation]);
  const [storageIssue, setStorageIssue] = React.useState<StorageHealthIssue | null>(
    () => currentStorageIssue(),
  );
  const [timelineRebuildBusy, setTimelineRebuildBusy] = React.useState(false);
  const [timelineRebuildError, setTimelineRebuildError] = React.useState<string | null>(null);
  const [syncRecoverySnapshot, setSyncRecoverySnapshot] = React.useState<{
    ownerId: string | null;
    record: SyncRecoveryRecord | null;
  }>({ ownerId: null, record: null });
  React.useEffect(() => {
    const onIssue = (event: globalThis.Event) => {
      setStorageIssue((event as CustomEvent<StorageHealthIssue | null>).detail);
    };
    window.addEventListener(STORAGE_HEALTH_EVENT, onIssue);
    return () => window.removeEventListener(STORAGE_HEALTH_EVENT, onIssue);
  }, []);
  const [sessionIssue, setSessionIssue] = React.useState<SessionHealthIssue | null>(
    () => currentSessionIssue(),
  );
  React.useEffect(() => {
    const onSession = (event: globalThis.Event) => {
      setSessionIssue((event as CustomEvent<SessionHealthIssue | null>).detail);
    };
    window.addEventListener(SESSION_HEALTH_EVENT, onSession);
    return () => window.removeEventListener(SESSION_HEALTH_EVENT, onSession);
  }, []);
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get("room");
  const callbackSetupRequestId = isToolSetupRequestId(search.get("extend_request"))
    ? search.get("extend_request")!
    : "";
  const [dismissedSetupRequestId, setDismissedSetupRequestId] = React.useState("");
  const callbackSetupOpen =
    Boolean(callbackSetupRequestId)
    && dismissedSetupRequestId !== callbackSetupRequestId;
  const teamViewSlug = search.get("team");
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [loading, setLoading] = React.useState(true);
  // Mirror the total unread count to the desktop wrapper's Dock/taskbar badge.
  // No-op in plain browsers (the wrapper injects the hook this feeds).
  React.useEffect(() => {
    const total = rooms.reduce(
      (n, r) => (r.observed ? n : n + (r.unread_count ?? (r.unread ? 1 : 0))),
      0,
    );
    reportUnreadBadge(total);
  }, [rooms]);
  // §1d — roomId → expiry timestamp for rooms with a silicon mid-task. Drives a
  // faint sidebar "working…" shimmer even when the room isn't open.
  const [workingRooms, setWorkingRooms] = React.useState<Record<string, number>>({});
  // roomId → latest progress note, shown live in the sidebar row's preview line.
  const [workingNotes, setWorkingNotes] = React.useState<Record<string, string>>({});
  const markRoomWorking = React.useCallback(
    (roomId: string, working: boolean, note?: string) => {
      setWorkingRooms((prev) => {
        if (working) return { ...prev, [roomId]: Date.now() + 45_000 };
        if (!(roomId in prev)) return prev;
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setWorkingNotes((prev) => {
        if (working) {
          const text = (note ?? "").trim();
          if (prev[roomId] === text) return prev;
          return { ...prev, [roomId]: text };
        }
        if (!(roomId in prev)) return prev;
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
    },
    [],
  );
  const reconcileRoomManagerActivity = React.useCallback((roomId: string) => {
    const groups = visibleCachedManagerActivities(roomId);
    const group = [...groups].reverse().find((candidate) => candidate.display === "active");
    const frame = group?.current;
    markRoomWorking(
      roomId,
      Boolean(group),
      frame?.note ?? "",
    );
    // The legacy cache represents one live run. Settled history belongs only
    // to the manager-activity projection and must never revive room progress.
    if (!group || getRoomProgress(roomId)?.groupId !== group.progress_group_id) {
      clearRoomProgress(roomId);
    }
    return group;
  }, [markRoomWorking]);
  // Sweep expired entries so a silicon that died without a `done` stops shimmering.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];
      setWorkingRooms((prev) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v > now) next[k] = v;
          else {
            changed = true;
            expired.push(k);
          }
        }
        return changed ? next : prev;
      });
      if (expired.length) {
        setWorkingNotes((prev) => {
          if (!expired.some((k) => k in prev)) return prev;
          const next = { ...prev };
          for (const k of expired) delete next[k];
          return next;
        });
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, []);
  const workingRoomIds = React.useMemo(() => new Set(Object.keys(workingRooms)), [workingRooms]);
  const [peerActivity, setPeerActivity] = React.useState<
    Record<string, { note: string; expiresAt: number }>
  >({});
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setPeerActivity((prev) => {
        const next = Object.fromEntries(
          Object.entries(prev).filter(([, value]) => value.expiresAt > now),
        );
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  const peerActivityNotes = React.useMemo(
    () => Object.fromEntries(Object.entries(peerActivity).map(([roomId, value]) => [roomId, value.note])),
    [peerActivity],
  );
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<ChatFilters>(loadFilters);
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
  // `quiet` marks a frame replayed from the events/sync backfill (not live):
  // it must update last_event/unread/snippets like any other frame, but skip
  // sounds, notifications, and toasts — the user shouldn't get a burst of
  // pings for messages that arrived while the socket was down. Subscribers
  // (the open RoomView) get quiet frames too; their handling is idempotent
  // by event_id/client_id, so a replayed duplicate is a no-op there.
  const pageFrameRef = React.useRef<(f: WsFrame, opts?: { quiet?: boolean }) => void>(() => {});
  const seenEventKeysRef = React.useRef(new Set<string>());
  const seenEventOrderRef = React.useRef<string[]>([]);
  // Revision dedup above preserves meaningful edits/finalizations. Sound,
  // unread, and notification decisions need the stricter immutable event
  // identity so a reconnect replay cannot masquerade as a new message.
  const seenLiveEventIdentitiesRef = React.useRef(new Set<string>());
  const seenLiveEventIdentityOrderRef = React.useRef<string[]>([]);
  // A silicon streaming m.text is visible work-in-progress, not yet a received
  // message. Hold its signaling metadata until Glass commits event.final so
  // progress/delta traffic can never produce a message sound or OS alert.
  const pendingFinalSignalsRef = React.useRef(new Map<
    string,
    { event: Event; quiet: boolean }
  >());
  const finalizedBeforeEventRef = React.useRef(new Set<string>());
  const dispatchFrame = React.useCallback((f: WsFrame, opts?: { quiet?: boolean }) => {
    if (
      (f.type === "delivery_receipt" ||
        f.type === "read_receipt" ||
        f.type === "thread_read_receipt") &&
      f.deliveries
    ) {
      const owner = authStore.getCarbon()?.carbon_id;
      if (owner) void updateStoredEventDeliveries(owner, f.deliveries).catch(() => undefined);
    }
    if (f.type === "event") {
      const key = eventReplayRevisionKey(f.event);
      if (seenEventKeysRef.current.has(key)) return;
      seenEventKeysRef.current.add(key);
      seenEventOrderRef.current.push(key);
      if (seenEventOrderRef.current.length > 5_000) {
        const stale = seenEventOrderRef.current.splice(0, 1_000);
        for (const item of stale) seenEventKeysRef.current.delete(item);
      }
    }
    // The open room is the latency-sensitive consumer. Let its mounted
    // listener paint the frame before sidebar projection/cache work; when no
    // listener exists yet, the page handler below writes the same event into
    // the handoff cache for the room that is about to mount.
    for (const fn of frameListenersRef.current) fn(f);
    pageFrameRef.current(f, opts);
  }, []);
  const barrierRef = React.useRef<(
    hello: Extract<WsFrame, { type: "hello" }>,
    context: SyncBarrierContext,
  ) => Promise<void>>(async () => {
    throw new Error("sync handler unavailable");
  });
  const outboxWakeRef = React.useRef<(signal: OutboxWakeSignal) => void>(() => {});
  const durableFrameQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  const deliveryAckInflightRef = React.useRef(new Map<string, Promise<void>>());
  const flushDeliveryAcknowledgements = React.useCallback((owner: string, traceparent = "") => {
    const existing = deliveryAckInflightRef.current.get(owner);
    if (existing) return existing;
    const run = (async () => {
      // Drain a bounded number of batches per wake. The retry effect below
      // continues after failures/reloads without blocking message sync.
      for (let batch = 0; batch < 20; batch += 1) {
        const eventIds = await pendingDeliveryAcknowledgements(owner, 500);
        if (!eventIds.length) return;
        await api.acknowledgeDelivered(eventIds, batch === 0 ? traceparent : "");
        await completeDeliveryAcknowledgements(owner, eventIds);
      }
    })().finally(() => {
      deliveryAckInflightRef.current.delete(owner);
    });
    deliveryAckInflightRef.current.set(owner, run);
    return run;
  }, []);
  const onLiveFrame = React.useCallback(
    (frame: WsFrame) => {
      // Realtime rendering must never wait for IndexedDB. A blocked/slow
      // browser transaction previously held this frame—and every receipt,
      // final, and message queued behind it—out of both the sidebar and the
      // open timeline for seconds. Render the already-authoritative socket
      // frame synchronously; keep only persistence and its delivery ack in the
      // ordered durability lane below.
      dispatchFrame(frame);
      const owner = authStore.getCarbon()?.carbon_id;
      if (frame.type !== "event" || !owner) return;
      durableFrameQueueRef.current = durableFrameQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          let durable = false;
          try {
            await storeEvents(owner, [{ roomId: frame.room_id, event: frame.event }]);
            durable = true;
          } catch {
            appendRoomEventSnippet(frame.room_id, frame.event);
          }
          if (durable) {
            void flushDeliveryAcknowledgements(owner, frame.traceparent).catch(() => undefined);
          }
        });
    },
    [dispatchFrame, flushDeliveryAcknowledgements],
  );
  const socket = useChatSocket({
    onFrame: onLiveFrame,
    onBarrier: (hello, context) => barrierRef.current(hello, context),
  });
  const { setConnection, setGlobalIssue } = useChatConnectionBanner();
  React.useEffect(() => {
    setConnection(socket.applicationState, socket.reconnect);
  }, [setConnection, socket.applicationState, socket.reconnect]);
  const { teams } = useTeams();
  const { carbon } = useAuth();
  const ownerId = carbon?.carbon_id ?? null;
  React.useEffect(() => {
    if (!ownerId) return;
    const flush = () => void flushDeliveryAcknowledgements(ownerId).catch(() => undefined);
    flush();
    // A failed POST leaves the durable journal untouched. Retry quietly while
    // this account is open and immediately when the browser regains network.
    const interval = window.setInterval(flush, 5_000);
    window.addEventListener("online", flush);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", flush);
    };
  }, [flushDeliveryAcknowledgements, ownerId, socket.ready]);
  React.useEffect(() => {
    if (!ownerId || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const receiveRedaction = (message: MessageEvent) => {
      const data = message.data as Record<string, unknown> | null;
      if (!data || data.type !== "silicon-redaction-sync" || data.ownerId !== ownerId ||
          typeof data.roomId !== "string" || typeof data.eventId !== "string") return;
      dispatchFrame({
        type: "take_back",
        room_id: data.roomId,
        event_ids: [data.eventId],
        by_kind: "system",
        by_id: null,
      });
    };
    navigator.serviceWorker.addEventListener("message", receiveRedaction);
    return () => navigator.serviceWorker.removeEventListener("message", receiveRedaction);
  }, [dispatchFrame, ownerId]);
  const rebuildTimelineCache = React.useCallback(async () => {
    if (!ownerId || timelineRebuildBusy) return;
    setTimelineRebuildBusy(true);
    setTimelineRebuildError(null);
    try {
      const connectivity = await probeApiConnectivity();
      if (connectivity !== "reachable") {
        throw new Error(
          connectivity === "captive"
            ? "Sign in to this network, then try again."
            : "We can’t connect yet. Your chats are still safe.",
        );
      }
      await rebuildReachableChatCache(ownerId, true);
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setTimelineRebuildError(
        message === "Sign in to this network, then try again." ||
          message === "We can’t connect yet. Your chats are still safe."
          ? message
          : "We couldn’t refresh your chats. Please try again.",
      );
      setTimelineRebuildBusy(false);
    }
  }, [ownerId, timelineRebuildBusy]);
  React.useEffect(() => {
    if (!ownerId || socket.state !== "online" || !navigator.storage?.estimate) return;
    let cancelled = false;
    const run = async () => {
      const estimate = await navigator.storage.estimate();
      if (cancelled) return;
      await pruneReachableTimelineCache(ownerId, {
        // `online` is reached only after the exact Glass health/ticket/socket
        // path and authoritative sync barrier have succeeded.
        reachable: true,
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0,
      });
    };
    const timer = window.setTimeout(() => void run().catch(() => undefined), 2_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ownerId, socket.state]);
  const globalNotificationsRef = React.useRef<GlobalNotificationPreferences>(
    DEFAULT_GLOBAL_NOTIFICATIONS,
  );
  React.useEffect(() => {
    if (!ownerId) {
      globalNotificationsRef.current = DEFAULT_GLOBAL_NOTIFICATIONS;
      return;
    }
    void api.chatPreferences().then((value) => {
      globalNotificationsRef.current = value.notifications;
    }).catch(() => undefined);
    const onPreferences = (event: globalThis.Event) => {
      const value = (event as CustomEvent<{ notifications?: GlobalNotificationPreferences }>).detail;
      if (value?.notifications) globalNotificationsRef.current = value.notifications;
    };
    window.addEventListener("silicon:chat-preferences", onPreferences);
    return () => window.removeEventListener("silicon:chat-preferences", onPreferences);
  }, [ownerId]);
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready.then((registration) => {
      registration.active?.postMessage({
        type: "silicon-active-notification-owner",
        ownerId: ownerId ?? "",
      });
    });
  }, [ownerId]);
  const syncRecovery = syncRecoverySnapshot.ownerId === ownerId
    ? syncRecoverySnapshot.record
    : null;
  React.useEffect(() => {
    let alive = true;
    if (ownerId) {
      void syncRecoveryState(ownerId).then((record) => {
        if (!alive) return;
        setSyncRecoverySnapshot({
          ownerId,
          record: record?.phase === "recovered" ? null : record,
        });
      }).catch(() => undefined);
    }
    const onRecovery = (event: globalThis.Event) => {
      const record = (event as CustomEvent<SyncRecoveryRecord>).detail;
      if (!record || record.ownerId !== ownerId) return;
      setSyncRecoverySnapshot({
        ownerId,
        record: record.phase === "recovered" ? null : record,
      });
    };
    window.addEventListener(SYNC_RECOVERY_EVENT, onRecovery);
    return () => {
      alive = false;
      window.removeEventListener(SYNC_RECOVERY_EVENT, onRecovery);
    };
  }, [ownerId]);
  React.useEffect(() => {
    // An ended session is the only condition here that no amount of waiting or
    // retrying resolves, so it outranks storage and sync copy. Nothing local is
    // deleted and the composer keeps queueing — the owner is simply told which
    // action restores sync.
    if (sessionIssue) {
      setGlobalIssue({
        kind: "session",
        message: "Your session expired. Sign in to sync new messages.",
        retry: () => router.push("/auth/login"),
        retryLabel: "Sign in",
        assertive: true,
      });
      return;
    }
    // Durable outbox/media/draft degradation is already represented on the
    // affected message or composer and remains safely retryable. A global
    // outage banner for those transient local retries was noisy and misleading.
    // Keep the header for truly blocked storage and timeline-wide recovery.
    if (
      storageIssue &&
      (storageIssue.severity === "blocked" || storageIssue.area === "timeline")
    ) {
      setGlobalIssue({
        kind: "storage",
        message: timelineRebuildBusy
          ? "Refreshing your chats…"
          : timelineRebuildError === "Sign in to this network, then try again." ||
              timelineRebuildError === "We can’t connect yet. Your chats are still safe."
            ? timelineRebuildError
            : timelineRebuildError
              ? "We couldn’t refresh your chats. Please try again."
              : storageIssue.severity === "blocked"
                ? "We can’t save changes in this browser right now"
                : "Saving is taking longer than usual",
        retry:
          storageIssue.area === "timeline" && !timelineRebuildBusy && ownerId
            ? () => void rebuildTimelineCache()
            : null,
        assertive: storageIssue.severity === "blocked",
      });
      return;
    }
    if (syncRecovery && shouldSurfaceSyncRecovery(syncRecovery)) {
      setGlobalIssue({
        kind: "catching_up",
        message:
          syncRecovery.phase === "degraded"
            ? "We’re having trouble updating your chats"
            : "Your chats are catching up…",
        retry: syncRecovery.phase === "degraded" ? socket.reconnect : null,
        assertive: syncRecovery.phase === "degraded",
      });
      return;
    }
    setGlobalIssue(null);
  }, [
    ownerId,
    rebuildTimelineCache,
    router,
    sessionIssue,
    setGlobalIssue,
    socket.reconnect,
    storageIssue,
    syncRecovery,
    timelineRebuildBusy,
    timelineRebuildError,
  ]);
  React.useEffect(() => () => setGlobalIssue(null), [setGlobalIssue]);
  const contacts = useContacts(ownerId);
  const myUsername = carbon?.username ?? null;
  const selectedRoom = rooms.find((r) => r.room_id === selected);
  const [roomDetailRefreshing, setRoomDetailRefreshing] = React.useState<string | null>(null);
  const hasObservedRooms = rooms.some((r) => r.observed);

  // A direct chat started by id carries no team_slug from the backend, so it
  // would land in "Others" even when its peer is on one of my teams. Load each
  // of my teams' rosters and build `${kind}:${public_id}` → set-of-team-slugs
  // (keyed by carbon_id/silicon_id, not name, so renames and name collisions
  // don't misfile chats), so a room can be placed under every team its peers
  // belong to (a person can be on several).
  // Hydrate the membership map from cache synchronously so a direct chat is
  // placed in the right team tab on first paint, rather than flashing in
  // "Others" until the rosters refetch.
  const [peerTeams, setPeerTeams] = React.useState<Map<string, Set<string>>>(
    () => loadCachedMemberships(ownerId) ?? new Map(),
  );
  React.useEffect(() => {
    let alive = true;
    if (!teams.length) {
      queueMicrotask(() => {
        if (alive) setPeerTeams(new Map());
      });
      return () => {
        alive = false;
      };
    }
    // Re-seed from cache when the owner changes (e.g. account switch) before the
    // fresh fetch lands.
    const cached = loadCachedMemberships(ownerId);
    if (cached) {
      queueMicrotask(() => {
        if (alive) setPeerTeams(cached);
      });
    }
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
          if (!m.member_public_id) continue;
          const key = `${m.member_kind}:${m.member_public_id}`;
          let set = map.get(key);
          if (!set) {
            set = new Set();
            map.set(key, set);
          }
          set.add(slug);
        }
      }
      setPeerTeams(map);
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
      for (const p of Array.isArray(r.peers) ? r.peers : []) {
        const s = peerTeams.get(`${p.kind}:${p.id}`);
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

  // Teams band ordering — most-recent activity first, live: the max
  // last_event.at across a team's rooms decides its slot, so a new message
  // (which patches that room's last_event in place) bumps its team to the
  // front immediately. Teams with no room activity keep their relative server
  // order, after the active ones. ISO timestamps sort lexicographically.
  const orderedTeams = React.useMemo(() => {
    const latestByTeam = new Map<string, string>();
    for (const r of rooms) {
      const at = r.last_event?.at ?? r.updated_at ?? "";
      if (!at) continue;
      for (const slug of roomTeams(r.room_id)) {
        const cur = latestByTeam.get(slug);
        if (!cur || at > cur) latestByTeam.set(slug, at);
      }
    }
    return teams
      .map((t, i) => ({ t, i, at: latestByTeam.get(t.slug) ?? "" }))
      .sort((a, b) => (a.at === b.at ? a.i - b.i : b.at.localeCompare(a.at)))
      .map((x) => x.t);
  }, [teams, rooms, roomTeams]);

  // A non-observed room that belongs to no team is an "Other"; observed rooms
  // are a separate "Observing" filter regardless of team.
  const hasOtherRooms = rooms.some((r) => !r.observed && roomTeams(r.room_id).size === 0);

  // Teams are a multi-select FILTER (not sections): none selected → show all.
  // Folders/grouping only make sense for a single team, so a single team chip
  // (with no Others/Observing) still activates that team's folder view.
  const selectedTeamSlugs = React.useMemo(
    () => filters.teams.filter((t) => teams.some((tm) => tm.slug === t)),
    [filters.teams, teams],
  );
  const wantOthers = filters.teams.includes(OTHERS_TAB);
  const wantObserving = filters.teams.includes(OBSERVING_TAB);
  const activeTeamSlug =
    selectedTeamSlugs.length === 1 && !wantOthers && !wantObserving
      ? selectedTeamSlugs[0]
      : null;
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

  // Deep-link: `/chat?teams=slug1,slug2` pre-selects those team filter chips
  // (used by the invite page's "View team"). Applied once per distinct param.
  const teamsParam = search.get("teams");
  const appliedTeamsParamRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!teamsParam) return;
    const slugs = teamsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!slugs.length) return;
    let alive = true;
    queueMicrotask(() => {
      if (!alive || appliedTeamsParamRef.current === teamsParam) return;
      appliedTeamsParamRef.current = teamsParam;
      setFilters((f) => ({ ...f, teams: slugs }));
    });
    return () => {
      alive = false;
    };
  }, [teamsParam]);

  // Persist the sidebar filters so a reload restores them.
  React.useEffect(() => {
    try {
      window.localStorage.setItem(FILTERS_STORAGE, JSON.stringify(filters));
    } catch {
      /* quota / unavailable — non-fatal */
    }
  }, [filters]);

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
  const roomsCacheReadyRef = React.useRef(false);
  // Guards group persistence so the initial load for a new owner doesn't echo
  // back an empty array before the stored groups are read in.
  const groupsOwnerRef = React.useRef<string | null>(null);

  const upsertRoom = React.useCallback((room: Room) => {
    validateInitialRoomNotificationProjection(room);
    const normalized = normalizeRoom(room);
    if (!normalized) return;
    setRooms((prev) => {
      const idx = prev.findIndex((r) => r.room_id === normalized.room_id);
      if (idx === -1) return [...prev, normalized];
      const next = prev.slice();
      next[idx] = mergeRoomReceiptProjection(prev[idx], {
        ...prev[idx],
        ...normalized,
      });
      return next;
    });
  }, []);

  const openRoom = React.useCallback(
    (room: Room) => {
      upsertRoom(room);
      navigate(`/chat?room=${encodeURIComponent(room.room_id)}`);
    },
    [navigate, upsertRoom],
  );

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
        if (roomId !== selected) navigate(`/chat?room=${roomId}`);
        hoverTimerRef.current = null;
      }, 1200);
    },
    [navigate, selected],
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
  const [showArchivedRooms, setShowArchivedRooms] = React.useState(false);
  // Coalesce concurrent refreshes: a sync backfill can dispatch many frames
  // for rooms we don't know yet, and each unknown-room frame asks for a
  // refetch — one in-flight /rooms/ request serves them all.
  const refreshInflightRef = React.useRef<Promise<void> | null>(null);
  const refreshRoomsAuthoritatively = React.useCallback(async (
    signal?: AbortSignal,
    requireDurable = false,
  ) => {
    const rawRooms = await api.rooms(signal);
    if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
    if (!Array.isArray(rawRooms)) {
      throw new SyncIntegrityError(
        "account",
        "page_invariant",
        "Authoritative room projection is not an array.",
      );
    }
    for (const rawRoom of rawRooms) {
      validateInitialRoomNotificationProjection(rawRoom as Room);
    }
    const normalizedRooms = normalizeRooms(rawRooms);
    if (rawRooms.length > 0 && normalizedRooms.length !== rawRooms.length) {
      throw new SyncIntegrityError(
        "account",
        "page_invariant",
        "Authoritative room projection contains malformed rows.",
      );
    }
    const next = replaceRoomsPreservingReceiptFacts(roomsRef.current, normalizedRooms);
    await migrateLegacyDrafts(next.map((room) => room.room_id));
    if (ownerId) {
      const persisted = await updateInitialRoomProjection(ownerId, next, signal);
      if (requireDurable && !persisted) {
        throw new SyncIntegrityError(
          "account",
          "page_invariant",
          "Room state has no durable initial projection.",
        );
      }
      saveCachedRooms(ownerId, next);
    }
    if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
    setRooms((current) => replaceRoomsPreservingReceiptFacts(current, next));
  }, [ownerId]);
  const refresh = React.useCallback(async () => {
    if (refreshInflightRef.current) return refreshInflightRef.current;
    const run = (async () => {
      setRefreshing(true);
      try {
        await refreshRoomsAuthoritatively();
        if (ownerId) void reportSyncRecovered(ownerId, undefined, ["account"]);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError") && ownerId) {
          const failure = classifySyncFailure(e, "account");
          void reportSyncRecovery(ownerId, {
            phase: failure.action === "resnapshot" ? "rebuilding" : "degraded",
            reason: failure.reason,
            stream: failure.stream,
            details: failure.details,
          });
        }
      } finally {
        roomsCacheOwnerRef.current = ownerId;
        roomsCacheReadyRef.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    })();
    refreshInflightRef.current = run;
    try {
      await run;
    } finally {
      refreshInflightRef.current = null;
    }
  }, [ownerId, refreshRoomsAuthoritatively]);

  const projectRoomRead = React.useCallback((roomId: string, streamPosition: number) => {
    if (ownerId) markRoomNotificationsRead(ownerId, roomId);
    setRooms((prev) => {
      let changed = false;
      const next = prev.map((candidate) => {
        if (candidate.room_id !== roomId) return candidate;
        const nextPosition = Math.max(
          candidate.unread_boundary.last_read_stream_position,
          streamPosition,
        );
        if (
          !candidate.unread &&
          (candidate.unread_count ?? 0) === 0 &&
          candidate.unread_boundary.unread_count === 0 &&
          candidate.unread_boundary.first_unread_event_id === null &&
          candidate.unread_boundary.first_unread_stream_position === null &&
          candidate.unread_boundary.first_unread_stream_writer === null &&
          nextPosition === candidate.unread_boundary.last_read_stream_position
        ) return candidate;
        changed = true;
        return {
          ...candidate,
          unread: false,
          unread_count: 0,
          unread_boundary: {
            ...candidate.unread_boundary,
            last_read_stream_position: nextPosition,
            first_unread_event_id: null,
            first_unread_stream_position: null,
            first_unread_stream_writer: null,
            unread_count: 0,
          },
        };
      });
      return changed ? next : prev;
    });
  }, [ownerId]);

  const projectAcceptedRoomEvent = React.useCallback((roomId: string, event: Event) => {
    const preview = eventPreview(event);
    if (preview === null) return;
    setRooms((current) => current.map((candidate) => {
      if (candidate.room_id !== roomId) return candidate;
      const last = candidate.last_event;
      const sameEvent = last?.event_id === event.event_id;
      const incomingEditVersion = Number.isSafeInteger(event.edit_version)
        ? Number(event.edit_version)
        : 0;
      const projectedEditVersion = Number.isSafeInteger(last?.edit_version)
        ? Number(last?.edit_version)
        : 0;
      if (sameEvent && incomingEditVersion < projectedEditVersion) return candidate;
      const delivery = sameEvent
        ? mergeDeliverySummaries(last?.delivery, event.delivery)
        : (event.delivery ?? undefined);
      const streamPosition = Number.isSafeInteger(event.stream_position)
        ? Number(event.stream_position)
        : candidate.list_projection.activity_stream_position;
      let throughVector = candidate.list_projection.through_stream_vector;
      if (throughVector && event.stream_writer && Number.isSafeInteger(event.stream_position)) {
        try {
          throughVector = streamVectorAdvanced(
            throughVector,
            event.stream_writer,
            Number(event.stream_position),
          );
        } catch {
          // The next authoritative room refresh repairs malformed legacy
          // vector metadata; the accepted event still updates the visible row.
        }
      }
      return mergeRoomReceiptProjection(candidate, {
        ...candidate,
        last_event: {
          event_id: event.event_id,
          preview,
          at: event.created_at,
          sender_handle: event.sender_handle,
          sender_kind: event.sender_kind,
          type: event.type,
          ...(delivery ? { delivery } : {}),
          read: delivery?.state === "read",
          stream_position: event.stream_position,
          stream_writer: event.stream_writer,
          edit_version: incomingEditVersion,
          edited_at: event.edited_at,
        },
        list_projection: {
          ...candidate.list_projection,
          // Activity identifies this exact last event. In a multi-writer room
          // a newer event can have a smaller per-writer position, so taking a
          // scalar max here creates an impossible projection and makes the
          // next authoritative refresh fail integrity validation.
          activity_stream_position: streamPosition,
          through_stream_position: Math.max(
            candidate.list_projection.through_stream_position,
            streamPosition,
          ),
          ...(throughVector ? { through_stream_vector: throughVector } : {}),
          activity_at: event.created_at,
        },
      });
    }));
  }, []);

  // Opening a room is the read gesture. Clear its local projection before the
  // first room paint, then persist the same boundary without waiting for
  // timeline history or a visibility observer.
  const openReadRequestsRef = React.useRef(new Set<string>());
  const readOpenedSelectionRef = React.useRef<string | null>(null);
  const markRoomReadImmediately = React.useCallback((roomId: string, projectedRoom?: Room) => {
    const room = projectedRoom ?? roomsRef.current.find((candidate) => candidate.room_id === roomId);
    if (!room) return false;
    const target = roomOpenReadTarget(room);
    if (!target) return false;
    projectRoomRead(roomId, target.streamPosition);
    if (!target.eventId) return true;

    const requestKey = `${roomId}:${target.eventId}:${target.streamPosition}`;
    if (openReadRequestsRef.current.has(requestKey)) return true;
    openReadRequestsRef.current.add(requestKey);
    if (openReadRequestsRef.current.size > 512) {
      const stale = Array.from(openReadRequestsRef.current).slice(0, 256);
      for (const key of stale) openReadRequestsRef.current.delete(key);
    }
    void api.read(roomId, target.eventId).catch(() => {
      openReadRequestsRef.current.delete(requestKey);
      if (selectedRef.current === roomId) readOpenedSelectionRef.current = null;
      void refresh();
    });
    return true;
  }, [projectRoomRead, refresh]);

  React.useLayoutEffect(() => {
    if (!selected) {
      readOpenedSelectionRef.current = null;
      return;
    }
    if (!selectedRoom || readOpenedSelectionRef.current === selected) return;
    if (markRoomReadImmediately(selected)) readOpenedSelectionRef.current = selected;
  }, [markRoomReadImmediately, selected, selectedRoom]);

  React.useEffect(() => {
    roomsCacheOwnerRef.current = null;
    roomsCacheReadyRef.current = false;
    const cached = ownerId ? loadCachedRooms(ownerId) : null;
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      if (cached) {
        roomsCacheReadyRef.current = true;
        setRooms(cached);
        setLoading(false);
      } else {
        setRooms([]);
        setLoading(true);
      }
    });
    void refresh();
    return () => {
      alive = false;
    };
  }, [ownerId, refresh]);

  React.useEffect(() => {
    if (!ownerId || !roomsCacheReadyRef.current || roomsCacheOwnerRef.current !== ownerId) return;
    saveCachedRooms(ownerId, rooms);
  }, [ownerId, rooms]);

  React.useEffect(() => {
    let alive = true;
    if (!selected) {
      queueMicrotask(() => {
        if (alive) setRoomDetailRefreshing(null);
      });
      return () => {
        alive = false;
      };
    }
    queueMicrotask(() => {
      if (alive) setRoomDetailRefreshing(selected);
    });
    api
      .roomDetail(selected)
      .then((room) => {
        if (!alive) return;
        upsertRoom(room);
        if (selectedRef.current === selected) {
          const normalized = normalizeRoom(room);
          if (normalized) markRoomReadImmediately(selected, normalized);
          // The authoritative detail can contain a newer unread tail than the
          // cached sidebar row used by the opening gesture. Always retry that
          // exact target; request-key dedup prevents duplicate POSTs.
          readOpenedSelectionRef.current = selected;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) {
          setRoomDetailRefreshing((current) => (current === selected ? null : current));
        }
      });
    return () => {
      alive = false;
    };
  }, [markRoomReadImmediately, selected, upsertRoom]);

  // Load this user's personal folder store; persist on every change (but only
  // once the current owner's store has been read, mirroring the rooms cache).
  React.useEffect(() => {
    groupsOwnerRef.current = null;
    const nextStore = ownerId ? loadGroupStore(ownerId) : { folders: [], overrides: {} };
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      setGroupStore(nextStore);
      groupsOwnerRef.current = ownerId;
    });
    return () => {
      alive = false;
    };
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
  const socketReady = socket.ready;
  const socketSend = socket.send;
  React.useEffect(() => {
    if (!socketReady) return;
    for (const r of rooms) socketSend({ type: "subscribe", room_id: r.room_id });
  }, [socketReady, rooms, socketSend]);

  // Commit-ordered reconnect repair. The socket buffers live frames until this
  // drains BOTH durable streams through the hello barriers. Cursor advancement
  // happens only after IndexedDB commit + reducer application.
  const syncInflightRef = React.useRef<{
    generation: number;
    run: Promise<void>;
  } | null>(null);
  const activeBarrierGenerationRef = React.useRef(0);
  const snapshotInflightRef = React.useRef(new Map<string, Promise<void>>());
  const acknowledgeStored = React.useCallback((owner: string) => {
    void flushDeliveryAcknowledgements(owner).catch(() => undefined);
  }, [flushDeliveryAcknowledgements]);
  const acknowledgeStoredRoomHistory = React.useCallback(() => {
    if (ownerId) acknowledgeStored(ownerId);
  }, [acknowledgeStored, ownerId]);
  const persistEventFrames = React.useCallback(
    async (
      owner: string,
      frames: Array<{ type: "event"; room_id: string; event: Event }>,
      dispatch = true,
      checkpoint?: SyncCheckpoint,
      requireDurable = false,
      pendingAccountReplay?: Omit<PendingAccountReplay, "ownerId" | "committedAt">,
      signal?: AbortSignal,
      expectedCheckpoint?: SyncCheckpoint,
    ) => {
      if (!frames.length && !checkpoint) return;
      let durable = false;
      try {
        await storeEvents(
          owner,
          frames.map((frame) => ({ roomId: frame.room_id, event: frame.event })),
          checkpoint,
          pendingAccountReplay,
          signal,
          expectedCheckpoint,
        );
        durable = true;
      } catch (error) {
        for (const frame of frames) appendRoomEventSnippet(frame.room_id, frame.event);
        if (requireDurable || checkpoint) throw error;
      }
      if (dispatch) {
        for (const frame of frames) dispatchFrame(frame, { quiet: true });
      }
      if (durable) acknowledgeStored(owner);
    },
    [acknowledgeStored, dispatchFrame],
  );
  const applyAccountUpdate = React.useCallback(
    async (update: AccountSyncUpdate): Promise<boolean> => {
      if (update.kind === "draft") {
        const durable = await applyServerDraft(update.data as unknown as DraftState);
        if (!durable) {
          throw new Error("Account draft replay could not be stored durably");
        }
        return false;
      }
      if (update.kind === "held_send") {
        dispatchFrame(
          { type: "held_send", held_send: update.data as unknown as HeldSend },
          { quiet: true },
        );
        return false;
      }
      if (update.kind === "client.operation") {
        outboxWakeRef.current("socket-ready");
        return false;
      }
      if (update.kind === "read_receipt") {
        dispatchFrame(
          { type: "read_receipt", ...(update.data as Omit<Extract<WsFrame, { type: "read_receipt" }>, "type">) },
          { quiet: true },
        );
        return false;
      }
      if (update.kind === "thread.read_receipt") {
        dispatchFrame(
          { type: "thread_read_receipt", ...(update.data as Omit<Extract<WsFrame, { type: "thread_read_receipt" }>, "type">) },
          { quiet: true },
        );
        return true;
      }
      if (update.kind === "delivery_receipt") {
        dispatchFrame(
          { type: "delivery_receipt", ...(update.data as Omit<Extract<WsFrame, { type: "delivery_receipt" }>, "type">) },
          { quiet: true },
        );
        return false;
      }
      if (
        update.kind === "room.upsert" ||
        update.kind === "room.remove" ||
        update.kind === "room.notifications" ||
        update.kind === "room.list_preferences" ||
        update.kind === "moderation.block"
      ) {
        return true;
      }
      if (update.kind === "chat.preferences") {
        window.dispatchEvent(new CustomEvent("silicon:chat-preferences", { detail: update.data }));
        return false;
      }
      if (update.kind === "device") {
        return false;
      }
      if (update.kind === "extend.request") {
        const parsed = parseToolSetupAccountState(update.data, update.object_id);
        if (!parsed) {
          throw new SyncIntegrityError(
            "account",
            "page_invariant",
            "Account tool-setup request is malformed.",
            { observedPosition: update.position },
          );
        }
        window.dispatchEvent(
          new CustomEvent(TOOL_SETUP_STATE_EVENT, { detail: parsed }),
        );
        return false;
      }
      throw new SyncIntegrityError(
        "account",
        "page_invariant",
        "Account sync item kind is unsupported by this client.",
        { observedPosition: update.position },
      );
    },
    [dispatchFrame],
  );
  const accountProjectionQueueRef = React.useRef(new Map<string, Promise<unknown>>());
  const withAccountProjectionLock = React.useCallback(<T,>(
    owner: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = accountProjectionQueueRef.current.get(owner) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    accountProjectionQueueRef.current.set(owner, run);
    return run.finally(() => {
      if (accountProjectionQueueRef.current.get(owner) === run) {
        accountProjectionQueueRef.current.delete(owner);
      }
    });
  }, []);
  const applyPendingAccountReplay = React.useCallback(
    async (
      owner: string,
      replay: PendingAccountReplay,
      signal?: AbortSignal,
    ): Promise<boolean> => withAccountProjectionLock(owner, async () => {
      let roomStateChanged = false;
      for (const update of replay.updates) {
        if (signal?.aborted) {
          throw new DOMException("Sync generation was superseded", "AbortError");
        }
        roomStateChanged = (await applyAccountUpdate(update)) || roomStateChanged;
      }
      if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
      if (roomStateChanged) await refreshRoomsAuthoritatively(signal, true);
      if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
      const committed = await commitPendingAccountProjection(
        owner,
        replay.nextPosition,
        signal,
      );
      if (committed === "mismatch") {
        throw new Error("Account replay was superseded before durable application");
      }
      return roomStateChanged;
    }),
    [applyAccountUpdate, refreshRoomsAuthoritatively, withAccountProjectionLock],
  );
  const replayPendingAccountState = React.useCallback(
    async (owner: string, signal?: AbortSignal): Promise<boolean> => {
      const replay = await readPendingAccountReplay(owner);
      if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
      if (!replay) return false;
      const checkpoint = await getSyncCheckpoint(owner);
      if (!checkpoint || checkpoint.accountPosition < replay.nextPosition) {
        // The cursor did not commit (or was deliberately cleared) while the
        // replay marker did. Removing the marker is safe only because Glass
        // will return this page again from the still-old cursor.
        const cleared = await clearPendingAccountReplay(owner, replay.nextPosition, signal);
        if (cleared === "mismatch") {
          throw new Error("Pending account replay changed during cursor recovery");
        }
        return false;
      }
      const checkpointAdvancedPastReplay =
        checkpoint.accountPosition > replay.nextPosition ||
        Boolean(
          replay.eventPage &&
          checkpoint.eventPosition !== replay.eventPage.nextPosition,
        );
      const roomStateChanged = await applyPendingAccountReplay(owner, replay, signal);
      if (checkpointAdvancedPastReplay) {
        // A pre-bridge client (or storage corruption) advanced beyond this
        // marker. The older projection is now durable, but only a fresh remote
        // snapshot can prove no intervening account state was skipped.
        await clearSyncCursors(owner, signal);
      }
      return roomStateChanged;
    },
    [applyPendingAccountReplay],
  );
  const hydratedInitialBundleRef = React.useRef<{
    owner: string;
    completedAt: number;
    accountPosition: number;
  } | null>(null);
  const accountProjectionHydrationRef = React.useRef<{
    owner: string;
    run: Promise<void>;
  } | null>(null);
  const hydrateAccountProjections = React.useCallback((owner: string): Promise<void> => {
    const current = accountProjectionHydrationRef.current;
    if (current?.owner === owner) return current.run;
    const run = withAccountProjectionLock(owner, async () => {
      const updates = await readAccountProjections(owner);
      let roomStateChanged = false;
      for (const update of updates) {
        const initial = hydratedInitialBundleRef.current;
        if (
          initial?.owner === owner &&
          update.position <= initial.accountPosition
        ) {
          continue;
        }
        roomStateChanged = (await applyAccountUpdate(update)) || roomStateChanged;
      }
      if (roomStateChanged) void refresh();
    }).finally(() => {
      if (accountProjectionHydrationRef.current?.run === run) {
        accountProjectionHydrationRef.current = null;
      }
    });
    accountProjectionHydrationRef.current = { owner, run };
    return run;
  }, [applyAccountUpdate, refresh, withAccountProjectionLock]);
  const hydrateInitialSyncBundle = React.useCallback(async (owner: string): Promise<boolean> => {
    return withAccountProjectionLock(owner, async () => {
      const bundle = await readInitialSyncBundle(owner);
      if (!bundle) return false;
      if (
        hydratedInitialBundleRef.current?.owner === owner &&
        hydratedInitialBundleRef.current.completedAt === bundle.completedAt
      ) {
        return true;
      }
      const normalized = normalizeRooms(bundle.rooms);
      if (normalized.length !== bundle.rooms.length) {
        throw new SyncIntegrityError(
          "initial",
          "page_invariant",
          "Durable initial room projection is malformed.",
        );
      }
      const draftDurable = await reconcileServerDraftManifest(
        bundle.accountData.drafts,
        normalized.map((room) => room.room_id),
      );
      if (!draftDurable) {
        throw new Error("Initial draft manifest could not be projected durably");
      }
      const next = replaceRoomsPreservingReceiptFacts(roomsRef.current, normalized);
      setRooms((current) => replaceRoomsPreservingReceiptFacts(current, next));
      saveCachedRooms(owner, next);
      for (const held of bundle.accountData.held_sends) {
        dispatchFrame({ type: "held_send", held_send: held }, { quiet: true });
      }
      hydratedInitialBundleRef.current = {
        owner,
        completedAt: bundle.completedAt,
        accountPosition: bundle.checkpoint.accountPosition,
      };
      setLoading(false);
      return true;
    });
  }, [dispatchFrame, withAccountProjectionLock]);
  const runInitialSnapshot = React.useCallback(async (
    owner: string,
    signal?: AbortSignal,
  ) => {
    let cursor = "";
    let eventThrough = "";
    let accountThrough = "";
    let continuity: ReturnType<typeof validateInitialContinuity> | null = null;
    const snapshotRooms: Room[] = [];
    const snapshotFrames: Array<{ type: "event"; room_id: string; event: Event }> = [];
    let initialAccountData: InitialSyncAccountData | null = null;
    const seenRoomIds = new Set<string>();
    const seenSnapshotEventIds = new Set<string>();
    const seenPageCursors = new Set<string>();
    for (let page = 0; page < 1_000; page += 1) {
      const result = await api.initialSync(cursor, 50, 30, signal);
      if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
      if (
        result.sync_version !== 1 ||
        !Array.isArray(result.rooms) ||
        typeof result.has_more !== "boolean" ||
        !isNonBlankString(result.through) ||
        !isNonBlankString(result.account_through) ||
        (result.has_more
          ? !isNonBlankString(result.next)
          : result.next !== null)
      ) {
        throw new SyncIntegrityError(
          "initial",
          "page_invariant",
          "Initial snapshot page is incomplete or malformed.",
        );
      }
      const pageContinuity = validateInitialContinuity(result.continuity);
      const accountData = result.account_data;
      if (
        (page === 0 && !accountData) ||
        (page > 0 && accountData !== null)
      ) {
        throw new SyncIntegrityError(
          "initial",
          "page_invariant",
          "Initial snapshot account state is incomplete or repeated.",
        );
      }
      if (page === 0 && accountData) {
        validateInitialAccountManifest(accountData);
        if (
          accountData.drafts.some((draft) =>
            !draft || typeof draft.room_id !== "string" || !draft.room_id
          ) ||
          accountData.held_sends.some((held) =>
            !held || typeof held.room_id !== "string" || !held.room_id ||
            typeof held.held_send_id !== "string" || !held.held_send_id
          )
        ) {
          throw new SyncIntegrityError(
            "initial",
            "page_invariant",
            "Initial snapshot account projections are malformed.",
          );
        }
        initialAccountData = accountData;
      }
      if (
        continuity &&
        (pageContinuity.event_position !== continuity.event_position ||
          !streamVectorEqual(pageContinuity.event_vector, continuity.event_vector) ||
          pageContinuity.account_position !== continuity.account_position)
      ) {
        throw new SyncIntegrityError(
          "initial",
          "position_discontinuity",
          "Initial snapshot changed its continuity barrier mid-traversal.",
          {
            expectedPosition: continuity.event_position,
            observedPosition: pageContinuity.event_position,
          },
        );
      }
      continuity = pageContinuity;
      eventThrough = result.through;
      accountThrough = result.account_through;
      const pageFrames: Array<{ type: "event"; room_id: string; event: Event }> = [];
      for (const room of result.rooms) {
        validateInitialRoomNotificationProjection(room);
        if (
          !room || typeof room.room_id !== "string" || !room.room_id ||
          seenRoomIds.has(room.room_id) ||
          !room.timeline || !Array.isArray(room.timeline.events)
        ) {
          throw new SyncIntegrityError(
            "initial",
            "page_invariant",
            "Initial snapshot repeated or malformed a room.",
          );
        }
        seenRoomIds.add(room.room_id);
        snapshotRooms.push(room);
        for (const event of room.timeline.events) {
          const eventPosition = Number(event.stream_position);
          const coveredByEventBarrier = pageContinuity.event_vector
            ? typeof event.stream_writer === "string" &&
              streamVectorIncludes(
                pageContinuity.event_vector,
                event.stream_writer,
                eventPosition,
              )
            : eventPosition <= pageContinuity.event_position;
          if (
            !event || typeof event.event_id !== "string" || event.event_id.length !== 26 ||
            seenSnapshotEventIds.has(event.event_id) ||
            !Number.isSafeInteger(event.stream_position) || eventPosition <= 0 ||
            !coveredByEventBarrier
          ) {
            throw new SyncIntegrityError(
              "initial",
              "page_invariant",
              "Initial snapshot contains an invalid event projection.",
            );
          }
          seenSnapshotEventIds.add(event.event_id);
          pageFrames.push({ type: "event", room_id: room.room_id, event });
        }
      }
      snapshotFrames.push(...pageFrames);
      if (!result.has_more) break;
      if (page === 999) {
        throw new SyncIntegrityError(
          "initial",
          "page_invariant",
          "Initial snapshot exceeded its bounded page limit.",
        );
      }
      if (!result.next || seenPageCursors.has(result.next)) {
        throw new SyncIntegrityError(
          "initial",
          "page_invariant",
          "Initial snapshot continuation did not make progress.",
        );
      }
      seenPageCursors.add(result.next);
      cursor = result.next;
    }
    if (!continuity || !initialAccountData) {
      throw new SyncIntegrityError(
        "initial",
        "page_invariant",
        "Initial snapshot did not establish a continuity barrier.",
      );
    }
    const normalized = normalizeRooms(snapshotRooms);
    if (normalized.length !== snapshotRooms.length) {
      throw new SyncIntegrityError(
        "initial",
        "page_invariant",
        "Initial snapshot contains a room that cannot be projected safely.",
      );
    }
    const checkpoint: SyncCheckpoint = {
      event: eventThrough,
      account: accountThrough,
      eventPosition: continuity.event_position,
      eventVector: continuity.event_vector,
      accountPosition: continuity.account_position,
    };
    await commitInitialSyncBundle(owner, {
      rooms: normalized,
      accountData: initialAccountData,
      events: snapshotFrames.map((frame) => ({
        roomId: frame.room_id,
        event: frame.event,
      })),
      checkpoint,
    }, signal);
    if (signal?.aborted) throw new DOMException("Sync generation was superseded", "AbortError");
    if (authStore.getCarbon()?.carbon_id !== owner) return;
    // Make every freshly-synced room immediately paintable on first open.
    // IndexedDB remains the durable source; this tiny synchronous tail avoids
    // a blank chat while either IndexedDB or the network is still resolving.
    const snippetByRoom = new Map<string, Event[]>();
    for (const frame of snapshotFrames) {
      const current = snippetByRoom.get(frame.room_id) ?? [];
      current.push(frame.event);
      snippetByRoom.set(frame.room_id, current);
    }
    for (const [roomId, events] of snippetByRoom) {
      saveRoomEventSnippet(roomId, events);
    }
    // A first-device/cursor rebuild used to stop at durable storage. If the
    // selected RoomView was already mounted, it had read the old snippet and
    // would not see these newly recovered rows until another navigation or
    // history request. Project every *durably committed* snapshot frame
    // through the same idempotent handoff as reconnect pages before hydrating
    // the room list. Mounted timelines paint now; rooms that mount afterward
    // reread the snippet above. This mirrors the reference clients' durable
    // get-difference -> visible projection handoff without weakening barriers.
    for (const frame of snapshotFrames) dispatchFrame(frame, { quiet: true });
    await hydrateInitialSyncBundle(owner);
  }, [dispatchFrame, hydrateInitialSyncBundle]);
  const initialSnapshot = React.useCallback((
    owner: string,
    signal?: AbortSignal,
    scope = "default",
  ): Promise<void> => {
    const key = `${owner}:${scope}`;
    const current = snapshotInflightRef.current.get(key);
    if (current) return current;
    const run = runInitialSnapshot(owner, signal).finally(() => {
      if (snapshotInflightRef.current.get(key) === run) {
        snapshotInflightRef.current.delete(key);
      }
    });
    snapshotInflightRef.current.set(key, run);
    return run;
  }, [runInitialSnapshot]);
  const syncThroughBarrier = React.useCallback(
    async (
      hello: Extract<WsFrame, { type: "hello" }>,
      context: SyncBarrierContext,
    ) => {
      if (!ownerId) return;
      if (syncInflightRef.current?.generation === context.generation) {
        return syncInflightRef.current.run;
      }
      activeBarrierGenerationRef.current = context.generation;
      const assertActive = () => {
        if (
          context.signal.aborted ||
          activeBarrierGenerationRef.current !== context.generation
        ) {
          throw new DOMException("Sync generation was superseded", "AbortError");
        }
      };
      const run = (async () => {
        let activeStream: SyncStream = "initial";
        try {
          assertActive();
          await hydrateInitialSyncBundle(ownerId);
          await hydrateAccountProjections(ownerId);
          await replayPendingAccountState(ownerId, context.signal);
          assertActive();
          const storedCheckpoint = await getSyncCheckpoint(ownerId);
          if (!storedCheckpoint) {
            await initialSnapshot(
              ownerId,
              context.signal,
              `barrier:${context.generation}`,
            );
            assertActive();
            await reportSyncRecovered(ownerId, undefined, REMOTE_SYNC_STREAMS);
            return;
          }
          let checkpoint: SyncCheckpoint = storedCheckpoint;

          activeStream = "events";
          let eventCursor = checkpoint.event;
          let eventThroughPosition: number | undefined;
          let eventThroughVector: SyncCheckpoint["eventVector"];
          for (let page = 0; page < 10_000; page += 1) {
            const result = await api.eventsSyncCursor(
              eventCursor,
              page === 0 ? hello.cursor : "",
              200,
              context.signal,
            );
            assertActive();
            const range = validateEventSyncPage(
              result,
              checkpoint.eventPosition,
              eventThroughPosition,
              checkpoint.eventVector,
              eventThroughVector,
            );
            eventThroughPosition ??= range.through_position;
            eventThroughVector ??= range.through_vector;
            const nextCheckpoint: SyncCheckpoint = {
              ...checkpoint,
              event: result.cursor,
              eventPosition: range.next_position,
              eventVector: range.next_vector,
            };
            await persistEventFrames(
              ownerId,
              result.frames,
              true,
              nextCheckpoint,
              true,
              undefined,
              context.signal,
              checkpoint,
            );
            checkpoint = nextCheckpoint;
            eventCursor = result.cursor;
            if (!result.has_more) break;
            if (page === 9_999) {
              throw new SyncIntegrityError(
                "events",
                "page_invariant",
                "Event sync exceeded its bounded page limit.",
              );
            }
          }

          activeStream = "account";
          let accountCursor = checkpoint.account;
          let accountThroughPosition: number | undefined;
          for (let page = 0; page < 10_000; page += 1) {
            const result = await api.accountSync(
              accountCursor,
              page === 0 ? hello.account_cursor : "",
              200,
              context.signal,
            );
            assertActive();
            const range = validateAccountSyncPage(
              result,
              checkpoint.accountPosition,
              accountThroughPosition,
            );
            accountThroughPosition ??= range.through_position;
            const nextCheckpoint: SyncCheckpoint = {
              ...checkpoint,
              account: result.cursor,
              accountPosition: range.next_position,
            };
            const replay: Omit<PendingAccountReplay, "ownerId" | "committedAt"> = {
              fromPosition: range.from_position,
              nextPosition: range.next_position,
              throughPosition: range.through_position,
              updates: result.updates,
              eventPage: null,
            };
            await persistEventFrames(
              ownerId,
              [],
              false,
              nextCheckpoint,
              true,
              replay,
              context.signal,
              checkpoint,
            );
            await applyPendingAccountReplay(ownerId, {
              ownerId,
              ...replay,
              committedAt: Date.now(),
            }, context.signal);
            checkpoint = nextCheckpoint;
            accountCursor = result.cursor;
            if (!result.has_more) break;
            if (page === 9_999) {
              throw new SyncIntegrityError(
                "account",
                "page_invariant",
                "Account sync exceeded its bounded page limit.",
              );
            }
          }
          await reportSyncRecovered(ownerId, undefined, REMOTE_SYNC_STREAMS);
        } catch (error) {
          if (
            context.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            throw error;
          }
          assertActive();
          const decision = classifySyncFailure(error, activeStream);
          await reportSyncRecovery(ownerId, {
            ...decision,
            phase: decision.action === "resnapshot" ? "rebuilding" : "degraded",
          });
          if (decision.action === "resnapshot") {
            // This deletes only the remote sync checkpoint. Draft journals,
            // outbox intents, protected media sources, and cached history are
            // separate stores and remain untouched.
            assertActive();
            await clearSyncCursors(ownerId, context.signal);
            try {
              await initialSnapshot(
                ownerId,
                context.signal,
                `barrier:${context.generation}:repair`,
              );
              assertActive();
              await reportSyncRecovered(ownerId, undefined, REMOTE_SYNC_STREAMS);
              return;
            } catch (snapshotError) {
              if (
                context.signal.aborted ||
                (snapshotError instanceof DOMException && snapshotError.name === "AbortError")
              ) {
                throw snapshotError;
              }
              assertActive();
              const snapshotDecision = classifySyncFailure(snapshotError, "initial");
              await reportSyncRecovery(ownerId, {
                ...snapshotDecision,
                phase: "degraded",
              });
              throw snapshotError;
            }
          }
          throw error;
        }
      })();
      syncInflightRef.current = { generation: context.generation, run };
      try {
        await run;
      } finally {
        if (syncInflightRef.current?.run === run) syncInflightRef.current = null;
      }
    },
    [
      applyPendingAccountReplay,
      hydrateAccountProjections,
      hydrateInitialSyncBundle,
      initialSnapshot,
      ownerId,
      persistEventFrames,
      replayPendingAccountState,
    ],
  );
  React.useLayoutEffect(() => {
    barrierRef.current = syncThroughBarrier;
  }, [syncThroughBarrier]);

  // WebSocket is the instant paint path, but a healthy pong cannot prove every
  // room fan-out arrived. Keep both durable ordered streams moving through one
  // concurrent long poll even while the socket is online. Duplicates are
  // event-id/revision idempotent; a missed socket frame is repaired as soon as
  // the commit wakes this poll. During reconnect, hello's barrier owns cursors.
  React.useEffect(() => {
    if (!ownerId) return;
    const networkAvailable = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!shouldRunDurableSync({
      ownerId,
      socketState: socket.state,
      socketReady: socket.ready,
      networkAvailable,
    })) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: number | null = null;
    let retryDelayMs = 1_000;

    const scheduleRetry = (delay = retryDelayMs) => {
      if (cancelled || controller.signal.aborted || navigator.onLine === false) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void run();
      }, delay);
      retryDelayMs = Math.min(Math.max(1_000, retryDelayMs * 2), 30_000);
    };

    const run = async () => {
      try {
        await hydrateInitialSyncBundle(ownerId);
        await hydrateAccountProjections(ownerId);
        await replayPendingAccountState(ownerId, controller.signal);
        let checkpoint = await getSyncCheckpoint(ownerId);
        if (!checkpoint) {
          await initialSnapshot(ownerId, controller.signal, "https");
          checkpoint = await getSyncCheckpoint(ownerId);
        }
        if (!checkpoint || cancelled) return;
        let eventThroughPosition: number | undefined;
        let eventThroughVector: SyncCheckpoint["eventVector"];
        let accountThroughPosition: number | undefined;
        for (let page = 0; page < 10_000 && !cancelled; page += 1) {
          const result = await api.syncPoll(
            checkpoint.event,
            checkpoint.account,
            25_000,
            200,
            controller.signal,
          );
          if (cancelled) return;
          // A completed HTTPS long poll proves the event POST transport works,
          // even when this network never permits a WebSocket upgrade.
          outboxWakeRef.current("https-poll");
          const eventRange = validateEventSyncPage(
            result.events,
            checkpoint.eventPosition,
            eventThroughPosition,
            checkpoint.eventVector,
            eventThroughVector,
          );
          const accountRange = validateAccountSyncPage(
            result.account,
            checkpoint.accountPosition,
            accountThroughPosition,
          );
          const nextCheckpoint: SyncCheckpoint = {
            event: result.events.cursor,
            account: result.account.cursor,
            eventPosition: eventRange.next_position,
            eventVector: eventRange.next_vector,
            accountPosition: accountRange.next_position,
          };
          const replay: Omit<PendingAccountReplay, "ownerId" | "committedAt"> = {
            fromPosition: accountRange.from_position,
            nextPosition: accountRange.next_position,
            throughPosition: accountRange.through_position,
            updates: result.account.updates,
            eventPage: {
              cursor: result.events.cursor,
              fromPosition: eventRange.from_position,
              nextPosition: eventRange.next_position,
              fromVector: eventRange.from_vector,
              nextVector: eventRange.next_vector,
              eventIds: result.events.frames.map((frame) => frame.event.event_id),
            },
          };
          await persistEventFrames(
            ownerId,
            result.events.frames,
            true,
            nextCheckpoint,
            true,
            replay,
            controller.signal,
            checkpoint,
          );
          await applyPendingAccountReplay(ownerId, {
            ownerId,
            ...replay,
            committedAt: Date.now(),
          }, controller.signal);
          retryDelayMs = 1_000;
          checkpoint = nextCheckpoint;
          eventThroughPosition = result.events.has_more
            ? eventRange.through_position
            : undefined;
          eventThroughVector = result.events.has_more
            ? eventRange.through_vector
            : undefined;
          accountThroughPosition = result.account.has_more
            ? accountRange.through_position
            : undefined;
          await reportSyncRecovered(ownerId, undefined, REMOTE_SYNC_STREAMS);
          if (!result.events.has_more && !result.account.has_more) {
            // The next request becomes the new bounded wait. Yield first so a
            // socket state transition can run its cleanup/abort immediately.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (page === 9_999) {
            throw new SyncIntegrityError(
              result.events.has_more ? "events" : "account",
              "page_invariant",
              "HTTPS sync exceeded its bounded page limit.",
            );
          }
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        const decision = classifySyncFailure(error, "events");
        await reportSyncRecovery(ownerId, {
          ...decision,
          phase: decision.action === "resnapshot" ? "rebuilding" : "degraded",
        });
        if (decision.action === "resnapshot") {
          await clearSyncCursors(ownerId, controller.signal);
          try {
            await initialSnapshot(ownerId, controller.signal, "https:repair");
            await reportSyncRecovered(ownerId, undefined, REMOTE_SYNC_STREAMS);
          } catch (snapshotError) {
            const snapshotDecision = classifySyncFailure(snapshotError, "initial");
            await reportSyncRecovery(ownerId, {
              ...snapshotDecision,
              phase: "degraded",
            });
          }
        }
        // Durable recovery remains self-healing even when the socket continues
        // returning healthy pongs and therefore causes no React state change.
        scheduleRetry(decision.action === "resnapshot" ? 0 : retryDelayMs);
      }
    };
    // Once the socket barrier is complete, subscribe the durable shadow path
    // immediately. In an offline/degraded generation, let an imminent socket
    // dial win before starting the HTTPS fallback.
    const startTimer = window.setTimeout(() => void run(), socket.ready ? 0 : 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [
    applyPendingAccountReplay,
    hydrateAccountProjections,
    hydrateInitialSyncBundle,
    initialSnapshot,
    ownerId,
    persistEventFrames,
    replayPendingAccountState,
    socket.ready,
    socket.state,
  ]);

  // Outbox flush: re-POST every still-pending text send with its ORIGINAL
  // client_id. The events endpoint is idempotent per content.client_id, so a
  // send whose response was lost (but which the server stored) comes back as
  // the original event instead of a duplicate. Entries that fail again simply
  // stay queued for the next flush.
  const outboxFlushingRef = React.useRef(false);
  const outboxFlushRequestedRef = React.useRef(false);
  const outboxFallbackDelayRef = React.useRef(1_000);
  const outboxRetryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushOutbox = React.useCallback(async () => {
    if (!ownerId) return;
    if (outboxFlushingRef.current) {
      outboxFlushRequestedRef.current = true;
      return;
    }
    // Own the mutex before the first IndexedDB await. Mount, HTTPS poll, and
    // socket signals can otherwise all read and POST the same snapshot.
    outboxFlushingRef.current = true;
    let listFailed = false;
    try {
      if (outboxRetryTimerRef.current) {
        clearTimeout(outboxRetryTimerRef.current);
        outboxRetryTimerRef.current = null;
      }
      let entries;
      let cancellations: HeldCancellation[] = [];
      try {
        await sweepAcknowledgedMediaCleanup(ownerId);
        cancellations = await listHeldCancellations(ownerId);
        entries = await listOutbox(ownerId);
      } catch {
        listFailed = true;
        return;
      }
      // Cancellation recovery runs before sends. A pending cancellation always
      // shadows its stale held outbox row; recovery materializes the immutable
      // held operation when needed and waits for an authoritative terminal
      // state instead of assuming a lost create response meant "not sent".
      for (const cancellation of cancellations) {
        if (cancellation.state !== "pending") {
          if (cancellation.state === "sent" && !cancellation.projectedAt) {
            try {
              const history = await api.historyPage(cancellation.roomId, "", 100);
              validateHistoryPage(history, {
                throughEventId: undefined,
                seenEventIds: new Set<string>(),
              }, cancellation.roomId);
              const recent = history.events;
              const event = findHeldCancellationEvent(cancellation, recent);
              if (!event) {
                listFailed = true;
                continue;
              }
              await persistEventFrames(ownerId, [
                { type: "event", room_id: cancellation.roomId, event },
              ]);
              if (!(await markHeldCancellationProjected(ownerId, cancellation.clientId))) {
                listFailed = true;
                continue;
              }
            } catch {
              // Offline restart: retain the visible sent-awaiting-sync temp row
              // and the outbox until authoritative history can be cached.
              listFailed = true;
              continue;
            }
          }
          await ackOutbox(ownerId, cancellation.clientId);
          continue;
        }
        if (
          cancellation.nextAttemptAt > Date.now()
        ) continue;
        try {
          const state = await reconcileHeldCancellation(cancellation);
          if (state === "cancelled" || state === "failed") {
            await ackOutbox(ownerId, cancellation.clientId);
          } else if (state === "sent") {
            // A second pass resolves and durably caches sent_event_id before
            // the last local held representation may be acknowledged away.
            outboxFlushRequestedRef.current = true;
          }
        } catch {
          // The journal owns retry metadata. The deadline calculation below
          // schedules the next transport-independent attempt.
        }
      }
      await garbageCollectHeldCancellations(ownerId).catch(() => 0);
      for (const it of entries) {
        if (it.operation === "held" && !(await maySendHeldOutbox(ownerId, it.clientId))) {
          continue;
        }
        if (
          it.state === "blocked" ||
          it.state === "challenge" ||
          (it.state !== "resolving" && (it.nextAttemptAt ?? 0) > Date.now())
        ) continue;
        const resolveAcceptedOperation = async (): Promise<
          "accepted" | "attention" | "missing" | "inconclusive"
        > => {
          try {
            const operation = await api.clientOperation(
              it.roomId,
              it.operation === "held" ? "held_send" : "event_send",
              it.clientId,
            );
            const expectedDeviceId = authStore.getBoundDeviceId();
            const event = acceptedEvent(
              operation,
              it.roomId,
              it.clientId,
              expectedDeviceId,
            );
            if (event) {
              const accepted = decorateDirectAcceptedTimelineEvent(
                ownerId,
                it.clientId,
                event,
              );
              await persistEventFrames(ownerId, [
                { type: "event", room_id: it.roomId, event: accepted },
              ]);
              if (it.operation === "media") {
                await acknowledgeMediaSend(ownerId, it, undefined, {
                  roomId: it.roomId,
                  event: accepted,
                });
              } else {
                await ackOutbox(ownerId, it.clientId, {
                  roomId: it.roomId,
                  event: accepted,
                });
              }
              return "accepted";
            }
            const held = acceptedHeldSend(
              operation,
              it.roomId,
              it.clientId,
              expectedDeviceId,
            );
            if (held) {
              if (!(await maySendHeldOutbox(ownerId, it.clientId))) {
                // The cancellation journal, not the send outbox, now owns this
                // operation. Never ack-and-release from a stale recovery pass.
                return "accepted";
              }
              // Any held-send row proves Glass durably owns the operation. Its
              // account-state stream is now the recovery source, including
              // cancelled/failed terminal outcomes.
              await ackOutbox(ownerId, it.clientId);
              const overdue = it.releaseAt && Date.parse(it.releaseAt) <= Date.now();
              if (overdue && held.state === "pending") {
                await withOutboxClientLock(ownerId, it.clientId, async () => {
                  if (!(await maySendHeldOutbox(ownerId, it.clientId))) return;
                  await api.sendHeldNow(it.roomId, held.held_send_id).catch(() => undefined);
                });
              }
              return "accepted";
            }
            const attention = heldSendRequiringAttention(
              operation,
              it.roomId,
              it.clientId,
              expectedDeviceId,
            );
            if (attention) {
              await persistHeldOutboxState(
                ownerId,
                it.clientId,
                attention,
              ).catch(() => false);
              return "attention";
            }
          } catch (error) {
            // 404 means the server never accepted this device-scoped intent.
            // Any other lookup failure is inconclusive and cannot authorize a
            // POST in the same recovery turn.
            return error instanceof ApiError && error.status === 404
              ? "missing"
              : "inconclusive";
          }
          // A pending or structurally unbound operation proves that lookup was
          // not a conclusive absence. Keep the immutable intent and check again.
          return "inconclusive";
        };
        try {
          // Resolve first on every recovery pass. A row already in `resolving`
          // is lookup-only: even a conclusive 404 first settles the persisted
          // original failure and never blind-POSTs in this turn.
          const resolution = await resolveAcceptedOperation();
          if (resolution === "accepted") continue;
          if (resolution === "attention") continue;
          if (it.state === "resolving") {
            if (!(await settleResolvingOutboxFailure(ownerId, it.clientId))) {
              listFailed = true;
            }
            continue;
          }
          if (resolution === "inconclusive") {
            // A recovery lookup can fail independently of the original send.
            // Give it a bounded durable retry deadline; do not let an uncertain
            // lookup authorize a replay in this same turn.
            const persisted = await persistOutboxFailure(
              ownerId,
              it.clientId,
              new TypeError("operation lookup unavailable"),
            ).catch(() => false);
            if (
              !persisted ||
              !(await settleResolvingOutboxFailure(ownerId, it.clientId))
            ) {
              listFailed = true;
            }
            continue;
          }
          if (it.operation === "held") {
            await withOutboxClientLock(ownerId, it.clientId, async () => {
              if (!(await maySendHeldOutbox(ownerId, it.clientId))) return;
              const nowMs = Date.now();
              const remainingMs = it.releaseAt
                ? Date.parse(it.releaseAt) - nowMs
                : 1_000;
              const held = await api.createHeldSend(it.roomId, {
                type: "m.text",
                content: { ...(it.content ?? {}), body: it.body, client_id: it.clientId },
                client_id: it.clientId,
                reply_to_event_id: it.replyTo,
                hold_seconds: recoveredSiliconHoldSeconds(it.releaseAt, nowMs),
              });
              if (!(await maySendHeldOutbox(ownerId, it.clientId))) {
                await api.cancelHeldSend(it.roomId, held.held_send_id).catch(() => undefined);
                return;
              }
              if (
                held.state === "blocked" ||
                held.state === "challenge" ||
                held.state === "failed"
              ) {
                await persistHeldOutboxState(ownerId, it.clientId, held);
                return;
              }
              // Once Glass owns the held row, the account-state stream is the
              // recovery source even if this client disappears again.
              await ackOutbox(ownerId, it.clientId);
              if (
                remainingMs <= 0 &&
                held.state !== "sent" &&
                held.phase !== "retry_wait"
              ) {
                if (!(await maySendHeldOutbox(ownerId, it.clientId))) {
                  await api.cancelHeldSend(it.roomId, held.held_send_id).catch(() => undefined);
                  return;
                }
                await api.sendHeldNow(it.roomId, held.held_send_id).catch(() => undefined);
              }
            });
            continue;
          }
          await withOutboxClientLock(ownerId, it.clientId, async () => {
            const current = (await listOutbox(ownerId)).find(
              (entry) => entry.clientId === it.clientId,
            );
            if (!current) return;
            const control = beginPendingSendControl(ownerId, current.clientId);
            try {
              const payload = current.operation === "media"
                ? await prepareMediaOutboxPayload(
                    ownerId,
                    current,
                    undefined,
                    undefined,
                    control.xhrRef,
                    control.signal,
                  )
                : {
                    type: current.type ?? "m.text",
                    content:
                      current.type && current.type !== "m.text"
                        ? { ...(current.content ?? {}) }
                        : { ...(current.content ?? {}), body: current.body },
                    reply_to_event_id: current.replyTo,
                  };
              const event = await api.sendEvent(
                current.roomId,
                payload,
                current.clientId,
                control.signal,
              );
              const accepted = decorateDirectAcceptedTimelineEvent(
                ownerId,
                current.clientId,
                event,
              );
              await persistEventFrames(
                ownerId,
                [{ type: "event", room_id: current.roomId, event: accepted }],
              );
              if (current.operation === "media") {
                await acknowledgeMediaSend(ownerId, current, undefined, {
                  roomId: current.roomId,
                  event: accepted,
                });
              } else {
                await ackOutbox(ownerId, current.clientId, {
                  roomId: current.roomId,
                  event: accepted,
                });
              }
            } finally {
              control.finish();
            }
          });
        } catch (error) {
          const status = error instanceof ApiError ? error.status : 0;
          // Commit the original result before any ambiguity lookup so a crash
          // cannot regress the row to a blind-replayable state.
          const persisted = await persistOutboxFailure(
            ownerId,
            it.clientId,
            error,
          ).catch(() => false);
          if (!persisted) listFailed = true;
          if (isAmbiguousSendFailure(status)) {
            const resolution = await resolveAcceptedOperation();
            if (resolution === "accepted") continue;
            if (resolution === "attention") continue;
            if (!(await settleResolvingOutboxFailure(ownerId, it.clientId))) {
              listFailed = true;
            }
          }
        }
      }
    } finally {
      try {
        let remaining: OutboxEntry[] = [];
        let remainingCancellations: HeldCancellation[] = [];
        try {
          remaining = await listOutbox(ownerId);
          remainingCancellations = await listHeldCancellations(ownerId);
        } catch {
          listFailed = true;
        }
        const now = Date.now();
        const cancellationIds = new Set(
          remainingCancellations.map((row) => row.clientId),
        );
        const outboxDue = nextOutboxWakeAt(
          remaining.filter(
            (row) => row.operation !== "held" || !cancellationIds.has(row.clientId),
          ),
          now,
        );
        const cancellationDue = remainingCancellations
          .filter((row) => row.state === "pending")
          .reduce<number | null>(
            (earliest, row) =>
              earliest == null ? row.nextAttemptAt : Math.min(earliest, row.nextAttemptAt),
            null,
          );
        const nextDue = outboxDue == null
          ? cancellationDue
          : cancellationDue == null
            ? outboxDue
            : Math.min(outboxDue, cancellationDue);
        if (outboxFlushRequestedRef.current) {
          outboxFlushRequestedRef.current = false;
          queueMicrotask(() => outboxWakeRef.current("deadline"));
        } else if (listFailed || (nextDue != null && nextDue <= now)) {
          // A due row means retry metadata could not advance. Keep it live with
          // bounded in-memory backoff rather than stranding it or hammering.
          const delay = outboxFallbackDelayRef.current;
          outboxFallbackDelayRef.current = Math.min(delay * 2, 30_000);
          outboxRetryTimerRef.current = setTimeout(
            () => outboxWakeRef.current("deadline"),
            delay,
          );
        } else if (nextDue != null) {
          outboxFallbackDelayRef.current = 1_000;
          outboxRetryTimerRef.current = setTimeout(
            () => outboxWakeRef.current("deadline"),
            Math.max(250, Math.min(nextDue - now, 2_147_000_000)),
          );
        } else {
          outboxFallbackDelayRef.current = 1_000;
        }
      } finally {
        // Keep ownership through the final durable reread and timer arm.
        outboxFlushingRef.current = false;
      }
    }
  }, [ownerId, persistEventFrames]);

  const requestOutboxFlush = React.useCallback(
    (signal: OutboxWakeSignal) => {
      const runtime = {
        ownerId,
        online: typeof navigator === "undefined" || navigator.onLine !== false,
        visible:
          typeof document === "undefined" || document.visibilityState === "visible",
        socketReady: socket.ready,
      };
      if (!shouldFlushOutbox(signal, runtime)) return;
      // Failure persistence during this exact pass only needs the finally
      // block to arm its new deadline; an immediate coalesced POST would ignore
      // Retry-After and can form a tight loop when storage is degraded.
      if (signal === "deadline" && outboxFlushingRef.current) return;
      void flushOutbox();
    },
    [flushOutbox, ownerId, socket.ready],
  );
  React.useLayoutEffect(() => {
    outboxWakeRef.current = requestOutboxFlush;
  }, [requestOutboxFlush]);

  // Mount, connectivity recovery, foregrounding, and persisted deadlines all
  // wake the queue independently of WebSocket state. No periodic polling is
  // required to make a durable retry happen.
  React.useEffect(() => {
    requestOutboxFlush("mount");
    const onOnline = () => requestOutboxFlush("online");
    const onVisible = () => {
      if (document.visibilityState === "visible") requestOutboxFlush("foreground");
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [requestOutboxFlush]);

  React.useEffect(() => {
    const resume = () => requestOutboxFlush("challenge");
    window.addEventListener(ABUSE_CHALLENGE_SOLVED_EVENT, resume);
    return () => window.removeEventListener(ABUSE_CHALLENGE_SOLVED_EVENT, resume);
  }, [requestOutboxFlush]);

  React.useEffect(() => {
    const armPersistedDeadline = (event: globalThis.Event) => {
      const detail = (event as CustomEvent<{ ownerId?: string }>).detail;
      if (!detail?.ownerId || detail.ownerId === ownerId) {
        requestOutboxFlush("deadline");
      }
    };
    window.addEventListener(OUTBOX_RETRY_SCHEDULED_EVENT, armPersistedDeadline);
    return () =>
      window.removeEventListener(OUTBOX_RETRY_SCHEDULED_EVENT, armPersistedDeadline);
  }, [ownerId, requestOutboxFlush]);

  React.useEffect(
    () => () => {
      if (outboxRetryTimerRef.current) clearTimeout(outboxRetryTimerRef.current);
    },
    [],
  );

  // `socket.ready` means both durable barriers have drained and buffered live
  // frames were released. Only now may the outbox retry user sends.
  const prevReadyRef = React.useRef(false);
  React.useEffect(() => {
    if (socket.ready && !prevReadyRef.current) {
      void (async () => {
        void loadAllServerDrafts();
        void refresh();
        requestOutboxFlush("socket-ready");
      })();
    }
    prevReadyRef.current = socket.ready;
  }, [socket.ready, refresh, requestOutboxFlush]);

  // Live sidebar streaming. On every event frame, patch the matching room's
  // last-message preview and unread count in place so a new message shows
  // instantly — even when that chat isn't open. Unknown rooms (and #2's
  // room.added) trigger a refetch so brand-new conversations surface too.
  // Kept current via a deps-less effect so it always sees the latest closures;
  // invoked by `dispatchFrame` for every WS frame (QA §2.1). Because `onFrame`
  // delivers each frame exactly once we no longer need the unbounded
  // `processedRef` dedup set the old `lastFrame` effect carried (QA §2.9).
  React.useEffect(() => {
    pageFrameRef.current = (f: WsFrame, opts?: { quiet?: boolean }) => {
    let activityReplacementEvent: Event | null = null;
    // Backfilled (sync-replayed) frame: state updates yes, noise no.
    const quiet = opts?.quiet === true;
    if (f.type === "event") {
      const ev = f.event;
      const mine = !!ev.sender_handle && ev.sender_handle === myUsername;
      const rid = f.room_id;
      const resolvedWorkBlocker = isResolvedWorkBlocker(ev);
      if (resolvedWorkBlocker) {
        if (ownerId) removeNotificationByEvent(ownerId, ev.event_id);
        closeBrowserNotification(ev.event_id);
        toast.dismiss(ev.event_id);
      }
      // Cache before room lookup: a deep-linked or newly-added room may not be
      // in the current sidebar projection yet, but its opening RoomView still
      // needs this accepted frame immediately.
      const novelSnippetEvent = appendRoomEventSnippet(rid, ev);
      const liveIdentity = `${rid}:${ev.event_id}`;
      const seenEventIdentity = seenLiveEventIdentitiesRef.current.has(liveIdentity);
      if (!seenEventIdentity) {
        seenLiveEventIdentitiesRef.current.add(liveIdentity);
        seenLiveEventIdentityOrderRef.current.push(liveIdentity);
        if (seenLiveEventIdentityOrderRef.current.length > 5_000) {
          const stale = seenLiveEventIdentityOrderRef.current.splice(0, 1_000);
          for (const identity of stale) seenLiveEventIdentitiesRef.current.delete(identity);
        }
      }
      setPeerActivity((prev) => {
        if (!(rid in prev) || prev[rid].note.indexOf(ev.sender_handle ?? "") < 0) return prev;
        const next = { ...prev };
        delete next[rid];
        return next;
      });
      const room = roomsRef.current.find((r) => r.room_id === rid);
      if (!room) {
        void refresh();
        return;
      }
      const isOpen = selectedRef.current === rid;
      const updatesExistingEvent = Boolean(ev.edited_at);
      const patchesLastEvent = room.last_event?.event_id === ev.event_id;
      const genuinelyNewEvent = isGenuinelyNewLiveEvent({
        seenEventIdentity,
        cachedEventIdentity: !novelSnippetEvent,
        patchesProjectedLastEvent: patchesLastEvent,
        edited: updatesExistingEvent,
      });
      const notificationPolicy = ownerId
        ? localNotificationPolicy(room, ev, ownerId, globalNotificationsRef.current)
        : { allowed: false, preview: false, sound: false };
      const finalizedBeforeCreate = finalizedBeforeEventRef.current.delete(liveIdentity);
      const signalReady = ev.is_final !== false || finalizedBeforeCreate;
      if (signalReady) {
        activityReplacementEvent = ev.is_final === false ? { ...ev, is_final: true } : ev;
      }
      if (
        genuinelyNewEvent &&
        !signalReady &&
        !mine &&
        isCountableEvent(ev)
      ) {
        pendingFinalSignalsRef.current.set(liveIdentity, { event: ev, quiet });
      }
      const genuinelyNewFinalMessage = genuinelyNewEvent && signalReady;
      // Received-message sound — global (any room), once per finalized event.
      // §3a — hear who's talking: silicons get a synthetic timbre, carbons a sine.
      if (shouldPlayReceivedSound({
        quiet,
        notificationAllowed: notificationPolicy.allowed,
        soundAllowed: notificationPolicy.sound,
        mine,
        countable: isCountableEvent(ev) && eventNotificationTier(ev) !== "in_app",
        genuinelyNew: genuinelyNewFinalMessage,
        observed: room.observed === true,
      })) {
        if (ev.sender_kind === "silicon") playReceivedSilicon();
        else playReceived();
      }
      const preview = eventPreview(ev);
      // An open room only counts as "seen" while the user is actually present
      // (in the desktop wrapper: window visible AND focused). A minimized or
      // hidden app with a room open must still notify and count unread —
      // auto-read catches up when the user returns.
      const present = userPresent();
      const attended = isOpen && present;
      // Unread is independent of whether the room happens to be mounted. The
      // viewport-owned read path will clear it after this exact row is actually
      // visible; an open-but-scrolled-up room must retain the count.
      const countableIncoming =
        genuinelyNewFinalMessage && isCountableEvent(ev) && !mine && !room.observed;
      const shouldNotify = countableIncoming && !attended;
      // Observer rooms (inter-silicon chats I only watch) never raise a
      // notification, browser alert, or toast — read-only visibility shouldn't
      // ping me. The unread indicator below still updates so the Observing tab
      // can show there's new activity.
      if (!quiet && shouldNotify && ownerId && notificationPolicy.allowed) {
        const notificationTier = eventNotificationTier(ev);
        const body = notificationPolicy.preview ? notificationBody(ev) : "New message";
        const display = notificationDisplay(room, contacts.byPeer);
        const title = notificationPolicy.preview ? display.title : "Silicon Interface";
        addNotification(ownerId, {
          id: ev.event_id,
          roomId: rid,
          eventId: ev.event_id,
          title,
          body,
          at: ev.created_at,
          avatarUrl: display.avatarUrl,
          avatarSeed: display.avatarSeed,
        });
        if (notificationTier !== "in_app") {
          showBrowserNotification(title, {
            body,
            tag: ev.event_id,
            roomId: rid,
            silent: !notificationPolicy.sound,
            requireInteraction: notificationTier === "prominent_push",
          });
        }
        // Present → in-app toast; absent → the OS notification above covers it.
        if (present) {
          const options = {
            id: ev.event_id,
            description: body,
            action: {
              label: "open",
              onClick: () => navigate(`/chat?room=${encodeURIComponent(rid)}`),
            },
          };
          if (notificationTier === "prominent_push") toast.error(title, options);
          else toast.message(title, options);
        }
      }
      setRooms((prev) =>
        prev.map((r) => {
          if (r.room_id !== rid) return r;
          const incomingEditVersion = Number.isSafeInteger(ev.edit_version)
            ? Number(ev.edit_version)
            : 0;
          const projectedEditVersion = Number.isSafeInteger(r.last_event?.edit_version)
            ? Number(r.last_event?.edit_version)
            : 0;
          const patchesLastRevision = !updatesExistingEvent ||
            (patchesLastEvent && incomingEditVersion >= projectedEditVersion);
          const patchesProjectedActivity =
            preview !== null &&
            !updatesExistingEvent &&
            Number.isSafeInteger(ev.stream_position) &&
            Number(ev.stream_position) > 0;
          const activityPosition = Number(ev.stream_position);
          let nextListVector = r.list_projection.through_stream_vector;
          let nextUnreadVector = r.unread_boundary.through_stream_vector;
          if (
            typeof ev.stream_writer === "string" &&
            Number.isSafeInteger(ev.stream_position) &&
            activityPosition > 0
          ) {
            try {
              if (nextListVector) {
                nextListVector = streamVectorAdvanced(
                  nextListVector,
                  ev.stream_writer,
                  activityPosition,
                );
              }
              if (nextUnreadVector) {
                nextUnreadVector = streamVectorAdvanced(
                  nextUnreadVector,
                  ev.stream_writer,
                  activityPosition,
                );
              }
            } catch {
              void refresh();
            }
          }
          // Counts toward unread only if it's a real message from someone
          // else and I'm not already looking at this room.
          const senderHandle = (ev.sender_handle ?? "").replace(/^@/, "");
          const peers = r.peers.map((peer) => {
            if (
              ev.sender_kind !== "carbon" ||
              peer.kind !== "carbon" ||
              !peer.presence ||
              ![peer.handle, peer.id].some(
                (identity) => identity.replace(/^@/, "") === senderHandle,
              )
            ) return peer;
            const presence = observePresenceActivity(peer.presence, ev.created_at);
            return presence === peer.presence ? peer : { ...peer, presence };
          });
          const projected = mergeRoomReceiptProjection(r, {
            ...r,
            peers,
            last_event:
              preview !== null && patchesLastRevision
                ? {
                    event_id: ev.event_id,
                    preview,
                    at: updatesExistingEvent ? (r.last_event?.at ?? ev.created_at) : ev.created_at,
                    sender_handle: ev.sender_handle,
                    sender_kind: ev.sender_kind ?? null,
                    type: ev.type,
                    delivery: updatesExistingEvent
                      ? mergeDeliverySummaries(r.last_event?.delivery, ev.delivery)
                      : (ev.delivery ?? undefined),
                    read: updatesExistingEvent
                      ? (r.last_event?.read === true || ev.delivery?.state === "read")
                      : ev.delivery?.state === "read",
                    stream_position: updatesExistingEvent
                      ? r.last_event?.stream_position
                      : activityPosition,
                    stream_writer: updatesExistingEvent
                      ? r.last_event?.stream_writer
                      : ev.stream_writer,
                    edit_version: incomingEditVersion,
                    edited_at: ev.edited_at,
                  }
                : r.last_event,
            list_projection: patchesProjectedActivity
              ? {
                  ...r.list_projection,
                  through_stream_position: Math.max(
                    r.list_projection.through_stream_position,
                    activityPosition,
                  ),
                  ...(nextListVector ? { through_stream_vector: nextListVector } : {}),
                  activity_stream_position: activityPosition,
                  activity_at: ev.created_at,
                }
              : r.list_projection,
            unread: countableIncoming ? true : r.unread,
            unread_count: countableIncoming
              ? (r.unread_count ?? 0) + 1
              : r.unread_count,
            unread_boundary: countableIncoming && Number.isSafeInteger(ev.stream_position)
              ? {
                  ...r.unread_boundary,
                  first_unread_event_id:
                    r.unread_boundary.unread_count > 0
                      ? r.unread_boundary.first_unread_event_id
                      : ev.event_id,
                  first_unread_stream_position:
                    r.unread_boundary.unread_count > 0
                      ? r.unread_boundary.first_unread_stream_position
                      : Number(ev.stream_position),
                  first_unread_stream_writer:
                    r.unread_boundary.unread_count > 0
                      ? r.unread_boundary.first_unread_stream_writer
                      : (ev.stream_writer ?? null),
                  unread_count: r.unread_boundary.unread_count + 1,
                  through_stream_position: Math.max(
                    r.unread_boundary.through_stream_position,
                    Number(ev.stream_position),
                  ),
                  ...(nextUnreadVector ? { through_stream_vector: nextUnreadVector } : {}),
                }
              : r.unread_boundary,
          });
          return resolvedWorkBlocker && roomProjectsEventAsUnread(r, ev, myUsername)
            ? retractRoomUnreadEvent(projected, ev.event_id)
            : projected;
        }),
      );
      // A real event landed for this room — clear any "waiting" sidebar
      // preview so it doesn't linger beside the now-current last message.
      if (preview !== null && !updatesExistingEvent) dropPendingPreview(rid);
    } else if (f.type === "presence") {
      setRooms((prev) => prev.map((candidate) => {
        if (f.room_id && candidate.room_id !== f.room_id) return candidate;
        let changed = false;
        const peers = candidate.peers.map((peer) => {
          if (peer.kind !== "carbon" || peer.id !== f.member_handle) return peer;
          const current = peer.presence;
          const presence = mergePresence(current, {
            state: f.state,
            expires_at: f.expires_at,
            last_seen_at: f.last_seen_at,
            revision: f.revision,
          });
          if (presence === current) return peer;
          changed = true;
          return {
            ...peer,
            presence,
          };
        });
        return changed ? { ...candidate, peers } : candidate;
      }));
    } else if (f.type === "take_back") {
      const redactedAt = new Date().toISOString();
      const eventIds = new Set(f.event_ids);
      for (const eventId of eventIds) {
        if (ownerId) removeNotificationByEvent(ownerId, eventId);
        closeBrowserNotification(eventId);
      }
      const snippet = readRoomEventSnippet(f.room_id) ?? [];
      const projectedSnippet = projectRedactedWindow(
        snippet, eventIds, redactedAt, "redacted",
      );
      projectedSnippet.mediaIds.forEach(evictCachedMedia);
      if (projectedSnippet.changed.length > 0) {
        saveRoomEventSnippet(f.room_id, projectedSnippet.events);
      }
      if (ownerId) {
        void loadStoredRoomEvents(ownerId, f.room_id).then((stored) => {
          const projected = projectRedactedWindow(stored, eventIds, redactedAt, "redacted");
          projected.mediaIds.forEach(evictCachedMedia);
          if (projected.changed.length > 0) {
            return storeEvents(
              ownerId,
              projected.changed.map((event) => ({ roomId: f.room_id, event })),
            );
          }
        }).catch(() => undefined);
      }
      setRooms((prev) => prev.map((room) =>
        room.room_id === f.room_id && room.last_event?.event_id &&
          eventIds.has(room.last_event.event_id)
          ? {
              ...room,
              last_event: { ...room.last_event, preview: "message deleted" },
            }
          : room,
      ));
    } else if (f.type === "event.final") {
      const signalKey = `${f.room_id}:${f.event_id}`;
      const pending = pendingFinalSignalsRef.current.get(signalKey);
      if (pending) {
        pendingFinalSignalsRef.current.delete(signalKey);
        const ev = { ...pending.event, is_final: true };
        const room = roomsRef.current.find((candidate) => candidate.room_id === f.room_id);
        if (!room) {
          void refresh();
        } else {
          const mine = !!ev.sender_handle && ev.sender_handle === myUsername;
          const notificationPolicy = ownerId
            ? localNotificationPolicy(room, ev, ownerId, globalNotificationsRef.current)
            : { allowed: false, preview: false, sound: false };
          if (shouldPlayReceivedSound({
            quiet: pending.quiet,
            notificationAllowed: notificationPolicy.allowed,
            soundAllowed: notificationPolicy.sound,
            mine,
            countable: isCountableEvent(ev) && eventNotificationTier(ev) !== "in_app",
            genuinelyNew: true,
            observed: room.observed === true,
          })) {
            if (ev.sender_kind === "silicon") playReceivedSilicon();
            else playReceived();
          }
          const present = userPresent();
          const attended = selectedRef.current === f.room_id && present;
          const countableIncoming =
            isCountableEvent(ev) && !mine && !room.observed;
          if (
            !pending.quiet &&
            countableIncoming &&
            !attended &&
            ownerId &&
            notificationPolicy.allowed
          ) {
            const notificationTier = eventNotificationTier(ev);
            const body = notificationPolicy.preview
              ? notificationBody(ev)
              : "New message";
            const display = notificationDisplay(room, contacts.byPeer);
            const title = notificationPolicy.preview
              ? display.title
              : "Silicon Interface";
            addNotification(ownerId, {
              id: ev.event_id,
              roomId: f.room_id,
              eventId: ev.event_id,
              title,
              body,
              at: ev.created_at,
              avatarUrl: display.avatarUrl,
              avatarSeed: display.avatarSeed,
            });
            if (notificationTier !== "in_app") {
              showBrowserNotification(title, {
                body,
                tag: ev.event_id,
                roomId: f.room_id,
                silent: !notificationPolicy.sound,
                requireInteraction: notificationTier === "prominent_push",
              });
            }
            if (present) {
              const options = {
                id: ev.event_id,
                description: body,
                action: {
                  label: "open",
                  onClick: () => navigate(`/chat?room=${encodeURIComponent(f.room_id)}`),
                },
              };
              if (notificationTier === "prominent_push") toast.error(title, options);
              else toast.message(title, options);
            }
          }
          if (countableIncoming) {
            setRooms((previous) => previous.map((candidate) => {
              if (candidate.room_id !== f.room_id) return candidate;
              return {
                ...candidate,
                unread: true,
                unread_count: (candidate.unread_count ?? 0) + 1,
                unread_boundary: {
                  ...candidate.unread_boundary,
                  first_unread_event_id:
                    candidate.unread_boundary.unread_count > 0
                      ? candidate.unread_boundary.first_unread_event_id
                      : ev.event_id,
                  first_unread_stream_position:
                    candidate.unread_boundary.unread_count > 0
                      ? candidate.unread_boundary.first_unread_stream_position
                      : Number.isSafeInteger(ev.stream_position)
                        ? Number(ev.stream_position)
                        : null,
                  first_unread_stream_writer:
                    candidate.unread_boundary.unread_count > 0
                      ? candidate.unread_boundary.first_unread_stream_writer
                      : (ev.stream_writer ?? null),
                  unread_count: candidate.unread_boundary.unread_count + 1,
                },
              };
            }));
          }
          if (eventReplacesManagerActivity(ev)) {
            settleCachedManagerActivity(f.room_id, {
              reason: "final_message",
              progress_group_id:
                typeof ev.content.progress_group_id === "string"
                  ? ev.content.progress_group_id
                  : null,
              occurred_at: new Date().toISOString(),
              final_message_event_id: ev.event_id,
            });
            reconcileRoomManagerActivity(f.room_id);
          }
        }
      } else if (!seenLiveEventIdentitiesRef.current.has(signalKey)) {
        // A different realtime lane may deliver final before the creating
        // frame. Remember that single fact so the later event signals once.
        finalizedBeforeEventRef.current.add(signalKey);
        if (finalizedBeforeEventRef.current.size > 512) {
          const oldest = finalizedBeforeEventRef.current.values().next().value;
          if (oldest) finalizedBeforeEventRef.current.delete(oldest);
        }
      }
    } else if (f.type === "draft") {
      void applyServerDraft(f.draft);
    } else if (f.type === "delivery_receipt") {
      if (f.member_handle && f.member_handle === myUsername) return;
      const deliveredIds = new Set(f.event_ids);
      setRooms((previous) => {
        let changed = false;
        const next = previous.map((candidate) => {
          const last = candidate.last_event;
          if (
            candidate.room_id !== f.room_id ||
            !last?.event_id ||
            last.sender_handle !== myUsername ||
            !deliveredIds.has(last.event_id)
          ) return candidate;
          const incoming = f.deliveries?.[last.event_id];
          // Direct rooms have exactly one recipient, so an event-id delivery
          // frame is itself authoritative even when an older Glass node omits
          // the aggregate map. Group totals still require Glass' aggregate.
          if (!incoming && candidate.kind !== "direct") return candidate;
          const delivery = incoming
            ? mergeDeliverySummaries(last.delivery, incoming)!
            : normalizeDeliverySummary(
                Math.max(1, last.delivery?.recipient_count ?? 1),
                Math.max(1, last.delivery?.delivered_count ?? 0),
                last.delivery?.read_count ?? 0,
              );
          changed = true;
          return {
            ...candidate,
            last_event: {
              ...last,
              delivery,
              read: delivery.state === "read",
            },
          };
        });
        return changed ? next : previous;
      });
    } else if (f.type === "read_receipt") {
      // Receipts are broadcast on EVERY mark-read — including my own, from any
      // device. A self-receipt (member_handle is mine) means I read this room
      // somewhere else: sync this device's unread badge, and never treat it as
      // a peer "read" tick (I can't read my own sent message via my own receipt).
      if (f.member_handle && f.member_handle === myUsername) {
        const room = roomsRef.current.find((r) => r.room_id === f.room_id);
        const boundary = room?.unread_boundary;
        if (!boundary) return;
        const vectorReceipt = f.read_stream_vector;
        const vectorProgress = vectorReceipt && boundary.last_read_stream_vector
          ? !streamVectorBeforeOrEqual(vectorReceipt, boundary.last_read_stream_vector)
          : f.read_stream_position > boundary.last_read_stream_position;
        if (!vectorProgress) return;
        const coversBarrier = vectorReceipt && boundary.through_stream_vector
          ? streamVectorBeforeOrEqual(boundary.through_stream_vector, vectorReceipt)
          : f.read_stream_position >= boundary.through_stream_position;
        if (coversBarrier) {
          if (ownerId) markRoomNotificationsRead(ownerId, f.room_id);
          // The receipt covers everything we know about — zero the badge.
          setRooms((prev) => {
            const needsClear = prev.some(
              (r) => r.room_id === f.room_id && (r.unread || (r.unread_count ?? 0) > 0),
            );
            if (!needsClear) return prev;
            return prev.map((r) =>
              r.room_id === f.room_id
                ? {
                    ...r,
                    unread: false,
                    unread_count: 0,
                    unread_boundary: {
                      ...r.unread_boundary,
                      last_read_stream_position: f.read_stream_position,
                      ...(vectorReceipt ? { last_read_stream_vector: vectorReceipt } : {}),
                      first_unread_event_id: null,
                      first_unread_stream_position: null,
                      first_unread_stream_writer: null,
                      unread_count: 0,
                    },
                  }
                : r,
            );
          });
        } else {
          // Partial coverage (messages landed after the read) — refetch for
          // the true remaining count rather than guessing.
          void refresh();
        }
        return;
      }
      // Someone ELSE read up to f.event_id. If that reaches my own latest
      // message, flip its sidebar tick to "read". (My own auto-read only ever
      // advances to the last *received* message, never my own send — so a
      // receipt at/past my latest message must be from someone else.)
      let missingAuthoritativeTail = false;
      setRooms((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (r.room_id !== f.room_id) return r;
          const le = r.last_event;
          if (!le || le.read || le.sender_handle !== myUsername || !le.event_id) {
            return r;
          }
          const incoming = f.deliveries?.[le.event_id];
          if (incoming) {
            const delivery = mergeDeliverySummaries(le.delivery, incoming)!;
            changed = true;
            return {
              ...r,
              last_event: {
                ...le,
                delivery,
                read: delivery.state === "read",
              },
            };
          }
          if (readReceiptCoversEvent(f, le)) {
            if (r.kind === "direct") {
              const delivery = normalizeDeliverySummary(
                Math.max(1, le.delivery?.recipient_count ?? 1),
                Math.max(1, le.delivery?.delivered_count ?? 0),
                1,
              );
              changed = true;
              return {
                ...r,
                last_event: { ...le, delivery, read: true },
              };
            }
            // The vector proves activity, but only Glass' aggregate can tell a
            // group-wide read from a partial read. Refetch instead of showing
            // an opaque double tick that may be false.
            missingAuthoritativeTail = true;
          }
          return r;
        });
        return changed ? next : prev;
      });
      if (missingAuthoritativeTail) void refresh();
    } else if (f.type === "thread_read_receipt") {
      // Thread reads are selective: refreshing preserves the room's remaining
      // unread boundary instead of guessing from a linear timeline cutoff.
      void refresh();
    } else if (f.type === "room.added") {
      if (!roomsRef.current.some((r) => r.room_id === f.room_id)) void refresh();
    } else if (f.type === "room.updated") {
      void refresh();
    } else if (f.type === "room.removed") {
      setRooms((prev) => prev.filter((room) => room.room_id !== f.room_id));
      if (ownerId) markRoomNotificationsRead(ownerId, f.room_id);
    } else if (f.type === "account.state") {
      if (f.kind === "client.operation") outboxWakeRef.current("socket-ready");
      if (f.kind === "chat.preferences") {
        window.dispatchEvent(new CustomEvent("silicon:chat-preferences", { detail: f.data }));
      }
      if (f.kind === "extend.request") {
        const requestId =
          typeof f.data.request_id === "string" ? f.data.request_id : "";
        const parsed = parseToolSetupAccountState(f.data, requestId);
        if (parsed) {
          window.dispatchEvent(
            new CustomEvent(TOOL_SETUP_STATE_EVENT, { detail: parsed }),
          );
        }
      }
      if (
        f.kind === "moderation.block" ||
        f.kind === "room.notifications" ||
        f.kind === "room.list_preferences"
      ) void refresh();
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
      const activityKind = f.kind;
      if (
        activityKind && ["typing", "uploading", "recording"].includes(activityKind) &&
        f.member_handle && f.member_handle !== myUsername
      ) {
        setPeerActivity((prev) => {
          if (f.is_typing === false) {
            if (!(progressRoom in prev)) return prev;
            const next = { ...prev };
            delete next[progressRoom];
            return next;
          }
          const verb = activityKind === "typing" ? "typing" : activityKind;
          return {
            ...prev,
            [progressRoom]: {
              note: `@${f.member_handle} is ${verb}…`,
              expiresAt: Date.now() + 8_000,
            },
          };
        });
      }
      if (f.state && f.progress_group_id) {
        const occurredAt = new Date().toISOString();
        recordManagerActivity(f, {
          room_id: progressRoom,
          occurred_at: occurredAt,
        });
        const selectedGroup = reconcileRoomManagerActivity(progressRoom);
        if (selectedGroup?.progress_group_id === f.progress_group_id) {
          setRoomProgress(progressRoom, {
            roomId: progressRoom,
            groupId: f.progress_group_id,
            state: f.state as ProgressState,
            note: f.note || "",
            updatedAt: Date.now(),
            source: "server",
            pct: typeof f.progress_pct === "number" ? f.progress_pct : null,
            handle: f.member_handle ?? null,
            anchorEventId: f.run_anchor_event_id ?? null,
          });
        }
      }
    } else if (f.type === "event" && f.event.type === "m.progress" && progressRoom) {
      const state = String(f.event.content.state || "thinking");
      const groupId = String(f.event.content.progress_group_id || f.event.event_id);
      recordManagerActivity(
        { ...f.event.content, room_id: progressRoom, event_id: f.event.event_id },
        {
          room_id: progressRoom,
          occurred_at: f.event.created_at,
          frame_id: f.event.event_id,
        },
      );
      const selectedGroup = reconcileRoomManagerActivity(progressRoom);
      if (selectedGroup?.progress_group_id === groupId) {
        setRoomProgress(progressRoom, {
          roomId: progressRoom,
          groupId,
          state: state as ProgressState,
          note: String(f.event.content.note || ""),
          updatedAt: Date.now(),
          source: "server",
          pct:
            typeof f.event.content.progress_pct === "number"
              ? f.event.content.progress_pct
              : null,
          handle: f.event.sender_handle,
          anchorEventId: f.event.content.run_anchor_event_id
            ? String(f.event.content.run_anchor_event_id)
            : null,
        });
      }
    } else if (
      f.type === "event" &&
      progressRoom &&
      activityReplacementEvent !== null &&
      eventReplacesManagerActivity(activityReplacementEvent)
    ) {
      // A final conversational response replaces only the matching manager
      // activity run so no completed shell remains beside the message.
      // Durable task/update cards may arrive while work continues.
      settleCachedManagerActivity(progressRoom, {
        reason: "final_message",
        progress_group_id:
          typeof f.event.content.progress_group_id === "string"
            ? f.event.content.progress_group_id
            : null,
        occurred_at:
          f.event.is_final === false ? new Date().toISOString() : f.event.created_at,
        final_message_event_id: f.event.event_id,
      });
      reconcileRoomManagerActivity(progressRoom);
    }
    };
  });

  // Clicking an OS notification (showBrowserNotification) raises a soft
  // navigation request instead of a cold window.location load. Open the room
  // through the same History-API path the sidebar uses so the socket survives.
  React.useEffect(() => {
    const onNavigate = (e: globalThis.Event) => {
      const detail = (e as CustomEvent<{ roomId?: string }>).detail;
      if (detail?.roomId) {
        markRoomReadImmediately(detail.roomId);
        navigate(`/chat?room=${encodeURIComponent(detail.roomId)}`);
      }
    };
    window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, onNavigate);
  }, [markRoomReadImmediately, navigate]);

  const filtered = React.useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    // Team filter chips (multi-select). Observed (inter-silicon) rooms only
    // appear when the Observing chip is on — they never show in the default
    // "all" view or under a team/Others selection.
    const teamSlugs = filters.teams.filter((t) => t !== OTHERS_TAB && t !== OBSERVING_TAB);
    const wantOth = filters.teams.includes(OTHERS_TAB);
    const wantObs = filters.teams.includes(OBSERVING_TAB);
    const list = rooms.filter((r) => {
      if (!roomVisibleInArchiveView(r, showArchivedRooms, Boolean(q))) return false;
      if (r.observed) {
        if (!wantObs) return false; // observed rooms gated behind the chip
      } else {
        // Non-observed: with any team/Others chip selected, the room must match
        // one of them; with only "Observing" selected, hide all non-observed;
        // with nothing selected, show everything.
        if (teamSlugs.length || wantOth) {
          const slugs = roomTeams(r.room_id);
          const matchTeam = teamSlugs.some((s) => slugs.has(s));
          const matchOthers = wantOth && slugs.size === 0;
          if (!matchTeam && !matchOthers) return false;
        } else if (wantObs) {
          return false; // only Observing selected → no non-observed rooms
        }
      }
      if (filters.unread && !r.unread) return false;
      const peerKinds = Array.isArray(r.peer_kinds) ? r.peer_kinds : [];
      if (filters.kinds.length && !filters.kinds.some((k) => peerKinds.includes(k))) return false;
      if (q) {
        const hayName = (r.name || "").toLowerCase();
        const hayPeer = (Array.isArray(r.peers) ? r.peers : [])
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
    list.sort(compareRoomListRows);
    return list;
  }, [rooms, filters, sidebarQuery, roomTeams, showArchivedRooms]);

  const archivedRoomEntry = React.useMemo(
    () => projectArchivedRoomListEntry(rooms),
    [rooms],
  );
  const updateRoomListPreference = React.useCallback(async (
    roomId: string,
    patch: Partial<{ pinned: boolean; archived: boolean }>,
  ) => {
    try {
      const result = await api.updateRoomListPreferences(roomId, patch);
      setRooms((current) => current.map((room) => room.room_id === roomId
        ? { ...room, list_preferences: result.preferences }
        : room));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    }
  }, []);

  const filtersActive = filters.unread || filters.kinds.length > 0 || filters.teams.length > 0;
  React.useEffect(() => {
    if (
      loading ||
      sidebarQuery.trim() ||
      !filtersActive ||
      rooms.length === 0 ||
      filtered.length !== 0
    ) return;
    let alive = true;
    queueMicrotask(() => {
      if (alive) {
        setFilters((current) => (current === filters ? EMPTY_FILTERS : current));
      }
    });
    return () => {
      alive = false;
    };
  }, [filtered.length, filters, filtersActive, loading, rooms.length, sidebarQuery]);

  // Folders aggregate across the teams currently in view: the selected teams,
  // or — when no team is selected — ALL teams (so folders still show by
  // default). Only-Others / only-Observing selections have no team folders.
  const relevantTeams = React.useMemo(() => {
    if (selectedTeamSlugs.length > 0) {
      return teams.filter((t) => selectedTeamSlugs.includes(t.slug));
    }
    if (wantOthers || wantObserving) return [];
    return teams;
  }, [selectedTeamSlugs, wantOthers, wantObserving, teams]);

  // Grouping shows whenever we have teams in view and aren't searching.
  const groupingActive = relevantTeams.length > 0 && sidebarQuery.trim() === "";

  const { groupSections, ungroupedRooms, displayFolders, assignmentByRoom } =
    React.useMemo(() => {
      if (!groupingActive) {
        return {
          groupSections: undefined as GroupSection[] | undefined,
          ungroupedRooms: undefined as Room[] | undefined,
          displayFolders: [] as DisplayFolder[],
          assignmentByRoom: {} as Record<string, string>,
          folderTeam: {} as Record<string, string>,
        };
      }
      // Merge every relevant team's folders (team-authored + personal) and their
      // silicon→folder assignments. Folder ids are unique across teams.
      const folders: DisplayFolder[] = [];
      const folderIds = new Set<string>();
      const folderTeam: Record<string, string> = {};
      const assignAll: Record<string, string> = {};
      for (const team of relevantTeams) {
        const cfg = team.silicon_folders;
        for (const f of cfg?.folders ?? []) {
          if (folderIds.has(f.id)) continue;
          folders.push({ id: f.id, name: f.name, source: "team" });
          folderIds.add(f.id);
          folderTeam[f.id] = team.slug;
        }
        Object.assign(assignAll, cfg?.assignments ?? {});
      }
      for (const team of relevantTeams) {
        const personal = groupStore.folders
          .filter((f) => f.teamSlug === team.slug)
          .sort((a, b) => a.order - b.order);
        for (const f of personal) {
          if (folderIds.has(f.id)) continue;
          folders.push({ id: f.id, name: f.name, source: "personal" });
          folderIds.add(f.id);
          folderTeam[f.id] = team.slug;
        }
      }

      // Override wins; else a silicon peer's team-folder default; else ungrouped.
      const resolve = (room: Room): string | null => {
        const o = groupStore.overrides[room.room_id];
        if (o !== undefined) return o === "" || !folderIds.has(o) ? null : o;
        const peers = Array.isArray(room.peers) ? room.peers : [];
        const peer = room.kind === "direct" && peers.length === 1 ? peers[0] : null;
        if (peer && peer.kind === "silicon") {
          const fid = assignAll[peer.id];
          if (fid && folderIds.has(fid)) return fid;
        }
        return null;
      };

      const byRoom: Record<string, string> = {};
      // Resolve every loaded room, not only the currently filtered rows. The
      // selected chat may have been opened from a notification or hidden by a
      // filter, but Escape still needs its true folder membership.
      for (const room of rooms) {
        const fid = resolve(room);
        if (fid) byRoom[room.room_id] = fid;
      }
      const byFolder = new Map<string, Room[]>();
      folders.forEach((f) => byFolder.set(f.id, []));
      const ungrouped: Room[] = [];
      for (const r of filtered) {
        const fid = byRoom[r.room_id] ?? null;
        if (fid) {
          byFolder.get(fid)!.push(r);
        } else {
          ungrouped.push(r);
        }
      }
      const sections: GroupSection[] = folders.map((group) => ({
        group,
        rooms: byFolder.get(group.id) ?? [],
      }));
      return {
        groupSections: sections,
        ungroupedRooms: ungrouped,
        displayFolders: folders,
        assignmentByRoom: byRoom,
        folderTeam,
      };
    }, [groupingActive, relevantTeams, groupStore, rooms, filtered]);

  // Persistence key for the drilled-in folder: the single selected team, or a
  // shared key when folders are aggregated across teams.
  const openFolderKey = activeTeamSlug ?? "__all__";
  const visibleOpenGroupId =
    groupingActive && displayFolders.some((folder) => folder.id === openGroupId)
      ? openGroupId
      : null;

  // Esc unwinds one level per keypress. A chat inside the open folder closes
  // before its folder; a chat outside the open folder leaves that folder first,
  // then closes on the next press. Bail when a dialog, popover, picker, or
  // in-chat search already handled the event.
  React.useEffect(() => {
    if (!selected && !visibleOpenGroupId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;

      const selectedIsInOpenFolder =
        !!selected &&
        !!visibleOpenGroupId &&
        assignmentByRoom[selected] === visibleOpenGroupId;
      if (visibleOpenGroupId && !selectedIsInOpenFolder) {
        setOpenGroupId(null);
        saveOpenFolder(ownerId, openFolderKey, null);
        return;
      }
      if (selected) {
        navigate("/chat");
        return;
      }
      if (visibleOpenGroupId) {
        setOpenGroupId(null);
        saveOpenFolder(ownerId, openFolderKey, null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, visibleOpenGroupId, assignmentByRoom, navigate, ownerId, openFolderKey]);

  const groupControls = React.useMemo(() => {
    if (!groupingActive) return undefined;
    return {
      groups: displayFolders,
      assignmentByRoom,
      openGroupId,
      onOpenGroup: (groupId: string) => {
        setOpenGroupId(groupId);
        saveOpenFolder(ownerId, openFolderKey, groupId);
      },
      onCloseGroup: () => {
        setOpenGroupId(null);
        saveOpenFolder(ownerId, openFolderKey, null);
      },
      onRename: (groupId: string) => {
        const f = groupStore.folders.find((x) => x.id === groupId);
        if (f) setGroupPrompt({ mode: "rename", groupId, current: f.name });
      },
      onDelete: (groupId: string) => {
        setGroupStore((prev) => deletePersonalFolder(prev, groupId));
        setOpenGroupId((cur) => {
          if (cur !== groupId) return cur;
          saveOpenFolder(ownerId, openFolderKey, null);
          return null;
        });
      },
      onMoveRoom: (roomId: string, groupId: string | null) =>
        setGroupStore((prev) => setRoomFolder(prev, roomId, groupId)),
      onCreateGroupWithRoom: (roomId: string) =>
        setGroupPrompt({ mode: "create", seedRoomId: roomId }),
    };
  }, [
    groupingActive,
    displayFolders,
    assignmentByRoom,
    groupStore,
    openGroupId,
    ownerId,
    openFolderKey,
  ]);

  // On a team/filter switch (or reload), restore that view's drilled-in folder.
  React.useEffect(() => {
    let alive = true;
    const savedGroupId = loadOpenFolder(ownerId, openFolderKey);
    queueMicrotask(() => {
      if (alive) setOpenGroupId(savedGroupId);
    });
    return () => {
      alive = false;
    };
  }, [openFolderKey, ownerId]);

  const confirmGroupPrompt = React.useCallback(
    (name: string) => {
      if (!groupPrompt) return;
      if (groupPrompt.mode === "rename") {
        setGroupStore((prev) => renamePersonalFolder(prev, groupPrompt.groupId, name));
        return;
      }
      // create a personal folder; seed it with the room when opened from a
      // chat's "New group…". The folder's team is the seed room's team (when
      // creating from a chat) or the single selected team / first team in view.
      const seedRoomId = groupPrompt.seedRoomId;
      const seedTeam = seedRoomId ? [...roomTeams(seedRoomId)][0] : undefined;
      const teamSlug = seedTeam ?? activeTeamSlug ?? relevantTeams[0]?.slug;
      if (!teamSlug) return;
      setGroupStore((prev) => {
        const { store, id } = createPersonalFolder(prev, teamSlug, name);
        return seedRoomId ? setRoomFolder(store, seedRoomId, id) : store;
      });
    },
    [groupPrompt, activeTeamSlug, relevantTeams, roomTeams],
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
        navigate(`/chat?room=${encodeURIComponent(target.room_id)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selected, navigate]);

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
        {/* Teams slider — above the search, acts as a multi-select filter. */}
        <TeamSlider
          filters={filters}
          onChange={setFilters}
          teams={orderedTeams.map((t) => ({ slug: t.slug, name: t.name, logo_url: t.logo_url }))}
          hasOthers={hasOtherRooms}
          hasObserving={hasObservedRooms}
          unread={unreadByTab}
          onOpenTeamSettings={(slug) => navigate(`/chat?team=${encodeURIComponent(slug)}`)}
        />
        {/* Search + new chat. */}
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
            className="m-2 grid h-8 w-8 shrink-0 self-center place-items-center border border-border text-foreground transition-colors hover:bg-accent"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <TeamFilterBar filters={filters} onChange={setFilters} />
        {/* Head-only payment-deadline banner — sits above the chat list. */}
        <PaymentBanner />
        <RoomList
          rooms={filtered}
          myHandle={myUsername}
          contacts={contacts.byPeer}
          selectedId={selected}
          onSelect={(id) => {
            markRoomReadImmediately(id);
            navigate(`/chat?room=${encodeURIComponent(id)}`);
          }}
          onNew={() => setDialogOpen(true)}
          loading={loading}
          hoverRoomId={hoverRoomId}
          workingRoomIds={workingRoomIds}
          workingNotes={workingNotes}
          peerActivityNotes={peerActivityNotes}
          onRoomDragEnter={onRoomDragEnter}
          onRoomDragLeave={onRoomDragLeave}
          groupSections={groupSections}
          ungroupedRooms={ungroupedRooms}
          groupControls={groupControls}
          archivedCount={archivedRoomEntry.count}
          archivedLatestRoom={archivedRoomEntry.latest}
          showArchived={showArchivedRooms}
          onShowArchivedChange={setShowArchivedRooms}
          onListPreferenceChange={updateRoomListPreference}
        />
      </aside>

      {selectedRoom ? (
        <RoomView
          // Signal keeps the conversation surface mounted while account and
          // message projections advance. Key only by room identity: remounting
          // on a sync generation destroys both the reader's scroll ownership
          // and the browser's live native Selection, then reopens at bottom.
          key={selectedRoom.room_id}
          room={selectedRoom}
          allRooms={rooms}
          socket={{
            ready: socket.ready,
            state: socket.state,
            send: socket.send,
            subscribe: subscribeFrames,
          }}
          contacts={contacts.byPeer}
          onContactsChanged={contacts.refresh}
          connectionStatePending={roomDetailRefreshing === selectedRoom.room_id}
          onEventAccepted={(event) => projectAcceptedRoomEvent(selectedRoom.room_id, event)}
          onSendIntent={() => markRoomReadImmediately(selectedRoom.room_id)}
          onHistoryStored={acknowledgeStoredRoomHistory}
          onReadThrough={(_eventId, streamPosition) =>
            projectRoomRead(selectedRoom.room_id, streamPosition)}
        />
      ) : selected ? (
        // A deep-linked room resolves after the account snapshot. Keep a
        // stable conversation shell during that interval instead of flashing
        // the unrelated welcome screen and then replacing the entire layout.
        <section className="flex flex-1 items-center justify-center bg-muted/20">
          <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <CircleNotch className="h-4 w-4 animate-spin" />
            Loading conversation…
          </div>
        </section>
      ) : viewedTeam ? (
        <TeamPanel
          slug={viewedTeam.slug}
          initialTab={(search.get("tab") as React.ComponentProps<typeof TeamPanel>["initialTab"]) ?? undefined}
          onClose={() => navigate("/chat")}
          onRoomOpened={openRoom}
        />
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
        onCreated={openRoom}
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

      {callbackSetupRequestId && (
        <ToolSetupDialog
          open={callbackSetupOpen}
          onOpenChange={(nextOpen) => {
            if (nextOpen) {
              setDismissedSetupRequestId("");
              return;
            }
            setDismissedSetupRequestId(callbackSetupRequestId);
            const url = new URL(window.location.href);
            url.searchParams.delete("extend_request");
            const nextUrl = `${url.pathname}${url.search}${url.hash}`;
            window.history.replaceState(null, "", nextUrl);
            lastSafeChatUrlRef.current = nextUrl;
          }}
          requestId={callbackSetupRequestId}
        />
      )}
    </>
  );
}
