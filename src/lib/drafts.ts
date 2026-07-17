"use client";

import * as React from "react";

import { api, ApiError } from "./api";
import { authStore } from "./auth";
import { deviceId } from "./device-id";
import {
  journalDraft,
  listDraftJournalRoomIds,
  readDraftJournal,
} from "./draft-journal";
import {
  hasActiveMediaTransfers,
  hasFailedMediaDurability,
  hasPendingMediaDurability,
} from "./media-upload-store";
import { hasActiveVoiceRecording } from "./composer-activity";
import { decideClientRetry } from "./retry-policy";
import { currentStorageIssue } from "./storage-health";
import { beginClientDurableCommit } from "./reliability-telemetry";
import {
  draftListPreviewText,
  type DraftListPreview,
} from "./draft-list-preview";
import type { DraftAttachment, DraftState, ReplyDraftTarget } from "./types";

const LEGACY_TEXT_PREFIX = "silicon-interface:draft:";
const LEGACY_ATT_PREFIX = "silicon-interface:draft-att:";
const PREFIX = "silicon-interface:draft-v2:";
const BACKUP_PREFIX = "silicon-interface:draft-v2-backup:";
const MIGRATED_PREFIX = "silicon-interface:drafts-migrated:";
const PUBLISH_DELAY_MS = 2000;
const SERVER_IDLE_MS = 800;
const SERVER_MAX_MS = 5000;

type PendingClearAfterSend = {
  text: string;
  attachments: DraftAttachment[];
  reply_to_event_id: string;
  base_version: number;
  content_updated_at: string;
};

type LocalDraft = {
  room_id: string;
  text: string;
  selection_start: number;
  selection_end: number;
  selection_direction: DraftSelectionDirection;
  formatting_mode: DraftFormattingMode;
  attachments: DraftAttachment[];
  reply_to_event_id: string;
  reply_to_snapshot: ReplyDraftTarget | Record<string, never>;
  version: number;
  updated_at: string;
  content_updated_at: string;
  origin_device: string;
  dirty: boolean;
  focused: boolean;
  lastLocalEditAt: number;
  lastJournalAt: number;
  localClearedAt: number;
  lastServerSyncAt: number;
  pendingRemote?: DraftState | null;
  pendingClearAfterSend?: PendingClearAfterSend | null;
  syncError?: string;
  syncAttempts: number;
  nextSyncAt: number;
  syncBlocked: boolean;
};

export type DraftSelectionDirection = "forward" | "backward" | "none";
export type DraftFormattingMode = "markdown";

export type DraftComposerState = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: DraftSelectionDirection;
  formattingMode: DraftFormattingMode;
};

const liveCache = new Map<string, LocalDraft>();
const publishedCache = new Map<string, string>();
const publishedListPreviewCache = new Map<string, string>();
const publishedReplyCache = new Map<
  string,
  { signature: string; value: ReplyDraftTarget | null }
>();
const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
const serverTimers = new Map<string, ReturnType<typeof setTimeout>>();
const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const serverInFlight = new Map<string, Promise<void>>();
const clearInFlight = new Map<string, Promise<void>>();
const localDurabilityErrors = new Map<string, string>();
const localDurabilityPending = new Set<string>();
const localSaveGeneration = new Map<string, number>();
const listeners = new Set<() => void>();
let storageBound = false;

function emit() {
  for (const fn of listeners) fn();
}

function ownerKey(): string | null {
  const carbon = authStore.getCarbon();
  return carbon?.carbon_id ? `carbon:${carbon.carbon_id}` : null;
}

function canPersist(): boolean {
  return ownerKey() !== null;
}

function storageKey(roomId: string): string | null {
  const owner = ownerKey();
  return owner ? `${PREFIX}${owner}:${roomId}` : null;
}

function backupKey(roomId: string): string | null {
  const owner = ownerKey();
  return owner ? `${BACKUP_PREFIX}${owner}:${roomId}` : null;
}

function migratedKey(): string | null {
  const owner = ownerKey();
  return owner ? `${MIGRATED_PREFIX}${owner}` : null;
}


function cleanupOwnerDraftStorage(owner: string | null) {
  if (typeof window === "undefined") return;
  try {
    const prefixes = [
      ...(owner ? [`${PREFIX}${owner}:`, `${BACKUP_PREFIX}${owner}:`, `${MIGRATED_PREFIX}${owner}`] : []),
      LEGACY_TEXT_PREFIX,
      LEGACY_ATT_PREFIX,
    ];
    for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (prefixes.some((prefix) => key === prefix || key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* best-effort logout cleanup */
  }
}

function blank(roomId: string): LocalDraft {
  return {
    room_id: roomId,
    text: "",
    selection_start: 0,
    selection_end: 0,
    selection_direction: "none",
    formatting_mode: "markdown",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 0,
    updated_at: "",
    content_updated_at: "",
    origin_device: "",
    dirty: false,
    focused: false,
    lastLocalEditAt: 0,
    lastJournalAt: 0,
    localClearedAt: 0,
    lastServerSyncAt: 0,
    syncAttempts: 0,
    nextSyncAt: 0,
    syncBlocked: false,
  };
}

function finiteTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parsedTimestamp(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDraftHasContent(value: LocalDraft): boolean {
  return Boolean(value.text || value.attachments.length || value.reply_to_event_id);
}

function remoteContentTimestamp(value: DraftState): number {
  // updated_at is a compatibility fallback for frames from the pre-authored-
  // timestamp backend. Current frames always carry content_updated_at.
  return parsedTimestamp(value.content_updated_at) || parsedTimestamp(value.updated_at);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPendingAttachment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.mediaId !== undefined && typeof value.mediaId !== "string") return false;
  if (value.media_id !== undefined && typeof value.media_id !== "string") return false;
  const mediaId = value.mediaId || value.media_id;
  if (typeof mediaId !== "string" || !mediaId) return false;
  for (const key of ["id", "mime", "name", "kind"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (
    value.size !== undefined &&
    (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0)
  ) {
    return false;
  }
  return true;
}

function validPendingDraftSnapshot(value: unknown, roomId: string): value is DraftState {
  if (!isRecord(value)) return false;
  if (value.room_id !== roomId || typeof value.text !== "string") return false;
  if (
    typeof value.version !== "number" ||
    !Number.isFinite(value.version) ||
    value.version < 0 ||
    typeof value.updated_at !== "string"
  ) {
    return false;
  }
  if (
    value.content_updated_at !== undefined &&
    typeof value.content_updated_at !== "string"
  ) return false;
  if (!Array.isArray(value.attachments) || !value.attachments.every(validPendingAttachment)) {
    return false;
  }
  if (typeof value.reply_to_event_id !== "string" || !isRecord(value.reply_to_snapshot)) {
    return false;
  }
  if (!Object.values(value.reply_to_snapshot).every((part) => typeof part === "string")) {
    return false;
  }
  if (value.cleared_at !== undefined && typeof value.cleared_at !== "string") return false;
  if (value.origin_device !== undefined && typeof value.origin_device !== "string") return false;
  return true;
}

function normalizePendingClearAfterSend(value: unknown): PendingClearAfterSend | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.text !== "string" ||
    !Array.isArray(value.attachments) ||
    !value.attachments.every(validPendingAttachment) ||
    typeof value.reply_to_event_id !== "string" ||
    (value.content_updated_at !== undefined && typeof value.content_updated_at !== "string") ||
    typeof value.base_version !== "number" ||
    !Number.isFinite(value.base_version) ||
    value.base_version < 0
  ) {
    return null;
  }
  return {
    text: value.text,
    attachments: cloudDraftAttachments(value.attachments as DraftAttachment[]),
    reply_to_event_id: value.reply_to_event_id,
    base_version: value.base_version,
    content_updated_at:
      typeof value.content_updated_at === "string" ? value.content_updated_at : "",
  };
}

function normalizeSelection(
  text: string,
  start: unknown,
  end: unknown,
  direction: unknown,
): Pick<LocalDraft, "selection_start" | "selection_end" | "selection_direction"> {
  const length = text.length;
  const integer = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.min(length, Math.trunc(value)))
      : fallback;
  const selectionStart = integer(start, length);
  const selectionEnd = Math.max(selectionStart, integer(end, selectionStart));
  const selectionDirection: DraftSelectionDirection =
    direction === "forward" || direction === "backward" ? direction : "none";
  return {
    selection_start: selectionStart,
    selection_end: selectionEnd,
    selection_direction: selectionDirection,
  };
}

function normalizeDraft(roomId: string, raw: Partial<LocalDraft>): LocalDraft {
  const text = typeof raw.text === "string" ? raw.text : "";
  const selection = normalizeSelection(
    text,
    raw.selection_start,
    raw.selection_end,
    raw.selection_direction,
  );
  const normalized: LocalDraft = {
    ...blank(roomId),
    ...raw,
    room_id: roomId,
    text,
    ...selection,
    formatting_mode: "markdown",
    attachments: sanitizeAttachments(raw.attachments ?? []),
    reply_to_event_id:
      typeof raw.reply_to_event_id === "string" ? raw.reply_to_event_id : "",
    reply_to_snapshot:
      raw.reply_to_snapshot && typeof raw.reply_to_snapshot === "object"
        ? raw.reply_to_snapshot
        : {},
    version: finiteTimestamp(raw.version),
    content_updated_at:
      typeof raw.content_updated_at === "string" ? raw.content_updated_at : "",
    origin_device: typeof raw.origin_device === "string" ? raw.origin_device : "",
    // Focus is process-local. Persisting it across a crash can incorrectly
    // make a newly opened room win over a newer remote draft.
    focused: false,
    lastLocalEditAt: finiteTimestamp(raw.lastLocalEditAt),
    lastJournalAt: finiteTimestamp(raw.lastJournalAt),
    localClearedAt: finiteTimestamp(raw.localClearedAt),
    lastServerSyncAt: finiteTimestamp(raw.lastServerSyncAt),
    pendingClearAfterSend: normalizePendingClearAfterSend(raw.pendingClearAfterSend),
    syncAttempts: finiteTimestamp(raw.syncAttempts),
    nextSyncAt: finiteTimestamp(raw.nextSyncAt),
    syncBlocked: raw.syncBlocked === true,
  };

  // Older builds persisted remote snapshots while waiting for a local/remote
  // choice. Telegram treats a draft as one continuously reconciled input
  // state, so repair those records silently while hydrating: a dirty local
  // composer stays authoritative, while a clean composer adopts the cloud
  // projection. A matching pre-send snapshot remains a clear-recovery proof.
  const pending = normalized.pendingRemote;
  const clearLegacyPending = () => {
    normalized.pendingRemote = null;
    if (normalized.syncBlocked && normalized.syncError === "conflict") {
      normalized.syncError = undefined;
      normalized.syncAttempts = 0;
      normalized.nextSyncAt = 0;
      normalized.syncBlocked = false;
    }
  };
  if (pending) {
    const validPending = validPendingDraftSnapshot(pending, roomId);
    const matchesPendingClear = Boolean(
      validPending &&
      normalized.pendingClearAfterSend &&
      pending.version >= normalized.pendingClearAfterSend.base_version &&
      semanticDraftMatches(
        normalized.pendingClearAfterSend.text,
        normalized.pendingClearAfterSend.attachments,
        normalized.pendingClearAfterSend.reply_to_event_id,
        pending,
      ),
    );
    const stale = validPending && pending.version < normalized.version;
    const pendingMatchesLocal = Boolean(
      validPending &&
      semanticDraftMatches(
        normalized.text,
        normalized.attachments,
        normalized.reply_to_event_id,
        pending,
      ),
    );
    if (matchesPendingClear) {
      // This is the ambiguous pre-send PUT, not a user-visible conflict. Keep
      // the local tombstone, adopt only its server version, and resume clear.
      normalized.version = Math.max(normalized.version, pending.version);
      if (normalized.pendingClearAfterSend) {
        normalized.pendingClearAfterSend.base_version = Math.max(
          normalized.pendingClearAfterSend.base_version,
          pending.version,
        );
      }
      normalized.updated_at = pending.updated_at;
      clearLegacyPending();
    } else if (!validPending || stale) {
      // Stale or malformed frames are not actionable conflicts. Remove only a
      // conflict barrier tied to that exact discarded frame; unrelated
      // transport failures remain intact.
      clearLegacyPending();
    } else if (normalized.dirty && !pendingMatchesLocal) {
      // A live local composer is never replaced by a passive cloud update.
      // Rebase it onto the remote version and let normal sync publish it.
      // If this raced a post-send clear, stop that delete first so it cannot
      // erase the newly observed cloud state.
      normalized.pendingClearAfterSend = null;
      normalized.version = Math.max(normalized.version, pending.version);
      normalized.updated_at = pending.updated_at;
      normalized.origin_device = deviceId();
      normalized.lastServerSyncAt = Math.max(normalized.lastServerSyncAt, Date.now());
      clearLegacyPending();
    } else if (normalized.dirty && pendingMatchesLocal) {
      // A complete matching snapshot proves that the dirty local composer was
      // already committed even if an older build crashed before persisting the
      // acknowledgement.
      normalized.pendingRemote = null;
      normalized.dirty = false;
      normalized.version = Math.max(normalized.version, pending.version);
      normalized.updated_at = pending.updated_at;
      normalized.content_updated_at = pending.content_updated_at ?? normalized.content_updated_at;
      normalized.lastServerSyncAt = Math.max(normalized.lastServerSyncAt, Date.now());
      normalized.syncError = undefined;
      normalized.syncAttempts = 0;
      normalized.nextSyncAt = 0;
      normalized.syncBlocked = false;
    } else if (!normalized.dirty) {
      // There is no local edit to protect. Adopt the complete remote composer
      // and put its caret at the end, matching Telegram's cross-device restore.
      normalized.pendingClearAfterSend = null;
      clearLegacyPending();
      normalized.text = pending.text;
      Object.assign(
        normalized,
        normalizeSelection(
          normalized.text,
          normalized.text.length,
          normalized.text.length,
          "none",
        ),
      );
      normalized.attachments = sanitizeAttachments(pending.attachments ?? []);
      normalized.reply_to_event_id = pending.reply_to_event_id || "";
      normalized.reply_to_snapshot = pending.reply_to_snapshot ?? {};
      normalized.version = pending.version;
      normalized.updated_at = pending.updated_at;
      normalized.content_updated_at = pending.content_updated_at ?? pending.updated_at;
      normalized.lastLocalEditAt = remoteContentTimestamp(pending);
      normalized.origin_device = pending.origin_device ?? "";
      const hasIntent = Boolean(
        normalized.text ||
          normalized.attachments.length ||
          normalized.reply_to_event_id,
      );
      const remoteTimestamp = Date.parse(pending.cleared_at || pending.updated_at);
      normalized.localClearedAt = hasIntent
        ? 0
        : Math.max(
            normalized.localClearedAt,
            Number.isFinite(remoteTimestamp) ? remoteTimestamp : 0,
          );
      normalized.lastServerSyncAt = Math.max(
        normalized.lastServerSyncAt,
        Number.isFinite(remoteTimestamp) ? remoteTimestamp : 0,
      );
    }
  }

  return normalized;
}

function persistedSnapshot(draft: LocalDraft): LocalDraft {
  return { ...draft, focused: false };
}

function safeLocalGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string | null): boolean {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function sanitizeAttachments(list: DraftAttachment[]): DraftAttachment[] {
  return list
    .filter((a) => a && (a.mediaId || a.media_id))
    .map((a) => ({
      id: a.id,
      mediaId: a.mediaId || (a as { media_id?: string }).media_id || "",
      mime: a.mime || "application/octet-stream",
      name: a.name || "attachment",
      size: a.size,
      kind: a.kind,
    }));
}

function cloudDraftAttachments(list: DraftAttachment[]): DraftAttachment[] {
  return sanitizeAttachments(list).map(({ mediaId, mime, name, size, kind }) => ({
    mediaId,
    mime,
    name,
    size,
    kind,
  }));
}

function draftAttachmentsMatch(
  local: DraftAttachment[],
  remote: DraftAttachment[],
): boolean {
  return JSON.stringify(cloudDraftAttachments(local)) === JSON.stringify(cloudDraftAttachments(remote));
}

function semanticDraftMatches(
  text: string,
  attachments: DraftAttachment[],
  replyToEventId: string,
  server: DraftState,
): boolean {
  return text === (server.text || "") &&
    replyToEventId === (server.reply_to_event_id || "") &&
    draftAttachmentsMatch(attachments, server.attachments ?? []);
}

function serverDraftsMatch(left: DraftState, right: DraftState): boolean {
  return left.version === right.version && semanticDraftMatches(
    left.text || "",
    left.attachments ?? [],
    left.reply_to_event_id || "",
    right,
  );
}

function serverDraftIsCleared(server: DraftState): boolean {
  return !server.text &&
    !(server.attachments ?? []).length &&
    !server.reply_to_event_id;
}

function saveLocalUninstrumented(draft: LocalDraft): Promise<boolean> {
  if (typeof window === "undefined" || !canPersist()) return Promise.resolve(false);
  const key = storageKey(draft.room_id);
  if (!key) return Promise.resolve(false);
  draft.lastJournalAt = Math.max(Date.now(), draft.lastJournalAt + 1);
  const snapshot = persistedSnapshot(draft);
  const hasData = Boolean(draft.text.length || draft.attachments.length || draft.reply_to_event_id);
  // Keep an authenticated-by-owner local tombstone after a clear. Deleting both
  // copies made it possible for an older asynchronous IndexedDB snapshot to
  // resurrect text after a process kill between the two deletes.
  const shouldPersist = Boolean(
    hasData ||
      draft.lastLocalEditAt ||
      draft.localClearedAt ||
      draft.version ||
      draft.pendingRemote ||
      draft.pendingClearAfterSend ||
      draft.syncError,
  );
  const serialized = shouldPersist ? JSON.stringify(snapshot) : null;
  const mirrorSaved = safeLocalSet(key, serialized);
  const generation = (localSaveGeneration.get(draft.room_id) ?? 0) + 1;
  localSaveGeneration.set(draft.room_id, generation);
  if (mirrorSaved) {
    const pendingChanged = localDurabilityPending.delete(draft.room_id);
    const errorChanged = localDurabilityErrors.delete(draft.room_id);
    if (pendingChanged || errorChanged) emit();
  } else {
    localDurabilityPending.add(draft.room_id);
    emit();
  }
  const owner = ownerKey();
  if (owner) {
    return journalDraft(owner, draft.room_id, shouldPersist ? { ...snapshot } : null)
      .then(() => {
        if (localSaveGeneration.get(draft.room_id) !== generation) return true;
        const pendingChanged = localDurabilityPending.delete(draft.room_id);
        const errorChanged = localDurabilityErrors.delete(draft.room_id);
        if (pendingChanged || errorChanged) emit();
        return true;
      })
      .catch(() => {
        if (localSaveGeneration.get(draft.room_id) === generation) {
          localDurabilityPending.delete(draft.room_id);
        }
        if (!mirrorSaved && localSaveGeneration.get(draft.room_id) === generation) {
          localDurabilityErrors.set(
            draft.room_id,
            "This draft is still on screen, but this browser could not save it. Free storage before leaving this chat.",
          );
          emit();
        }
        return mirrorSaved;
      });
  } else if (!mirrorSaved) {
    localDurabilityPending.delete(draft.room_id);
    localDurabilityErrors.set(
      draft.room_id,
      "This draft is still on screen, but this browser could not save it. Free storage before leaving this chat.",
    );
    emit();
  }
  return Promise.resolve(mirrorSaved);
}

function saveLocal(draft: LocalDraft): Promise<boolean> {
  if (typeof window === "undefined" || !canPersist()) {
    return saveLocalUninstrumented(draft);
  }
  const finish = beginClientDurableCommit("draft");
  return saveLocalUninstrumented(draft).then(
    (committed) => {
      finish(committed);
      return committed;
    },
    (error) => {
      finish(false);
      throw error;
    },
  );
}

function cancelRetry(roomId: string) {
  const timer = retryTimers.get(roomId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(roomId);
}

function cancelServerSchedule(roomId: string) {
  const idle = serverTimers.get(roomId);
  if (idle) clearTimeout(idle);
  serverTimers.delete(roomId);
  const max = maxTimers.get(roomId);
  if (max) clearTimeout(max);
  maxTimers.delete(roomId);
}

function scheduleRetry(roomId: string, at: number) {
  cancelRetry(roomId);
  const delay = Math.max(0, at - Date.now());
  const timer = setTimeout(() => {
    retryTimers.delete(roomId);
    const draft = readLocal(roomId);
    if (draft.pendingClearAfterSend) void deleteServerDraftAfterSend(roomId);
    else void flushServer(roomId);
  }, delay);
  // Node's conformance runner should not stay alive solely for a future retry.
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  retryTimers.set(roomId, timer);
}

function clearDraftTimers() {
  for (const timer of [
    ...publishTimers.values(),
    ...serverTimers.values(),
    ...maxTimers.values(),
    ...retryTimers.values(),
  ]) {
    clearTimeout(timer);
  }
  publishTimers.clear();
  serverTimers.clear();
  maxTimers.clear();
  retryTimers.clear();
}

function resumeDraftSync(draft: LocalDraft) {
  if (draft.pendingClearAfterSend) {
    if (hasExplicitDraftConflict(draft) || draft.syncBlocked) return;
    scheduleRetry(draft.room_id, Math.max(Date.now(), draft.nextSyncAt || 0));
    return;
  }
  if (!draft.dirty || draft.syncBlocked) return;
  scheduleRetry(draft.room_id, Math.max(Date.now(), draft.nextSyncAt || 0));
}

export async function hydrateDraftJournal(roomId: string): Promise<void> {
  const owner = ownerKey();
  if (!owner || !roomId) return;
  try {
    const stored = await readDraftJournal(owner, roomId);
    if (!stored) return;
    const journal = normalizeDraft(roomId, stored as Partial<LocalDraft>);
    const local = readLocal(roomId);
    const journalOrder = journal.lastJournalAt || journal.lastLocalEditAt;
    const localOrder = local.lastJournalAt || local.lastLocalEditAt;
    if (journalOrder <= localOrder) return;
    liveCache.set(roomId, journal);
    saveLocal(journal);
    resumeDraftSync(journal);
    schedulePublish(roomId, true);
    emit();
  } catch {
    // localStorage/cloud copies remain available.
  }
}

function readLegacyAttachments(roomId: string): DraftAttachment[] {
  const raw = safeLocalGet(`${LEGACY_ATT_PREFIX}${roomId}`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as DraftAttachment[];
    return Array.isArray(list) ? sanitizeAttachments(list) : [];
  } catch {
    return [];
  }
}

function readLocal(roomId: string): LocalDraft {
  if (typeof window === "undefined") return blank(roomId);
  const cached = liveCache.get(roomId);
  if (cached) return cached;
  if (!canPersist()) {
    const draft = blank(roomId);
    liveCache.set(roomId, draft);
    if (!publishedCache.has(roomId)) publishedCache.set(roomId, draft.text);
    if (!publishedListPreviewCache.has(roomId)) {
      publishedListPreviewCache.set(roomId, JSON.stringify(listPreviewOf(draft)));
    }
    return draft;
  }
  const key = storageKey(roomId);
  const raw = key ? safeLocalGet(key) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<LocalDraft>;
      const draft = normalizeDraft(roomId, parsed);
      liveCache.set(roomId, draft);
      // Persist migrations and silent legacy-conflict repair immediately.
      // Otherwise a clean restored draft can look correct in memory but fall
      // back to the obsolete choice barrier after the next process restart.
      if (JSON.stringify(persistedSnapshot(draft)) !== JSON.stringify(parsed)) {
        void saveLocal(draft);
      }
      resumeDraftSync(draft);
      if (!publishedCache.has(roomId)) publishedCache.set(roomId, draft.text);
      if (!publishedListPreviewCache.has(roomId)) {
        publishedListPreviewCache.set(roomId, JSON.stringify(listPreviewOf(draft)));
      }
      return draft;
    } catch {
      /* fall through to legacy */
    }
  }
  const legacyText = safeLocalGet(`${LEGACY_TEXT_PREFIX}${roomId}`) ?? "";
  const legacyAttachments = readLegacyAttachments(roomId);
  const draft = {
    ...blank(roomId),
    text: legacyText,
    attachments: legacyAttachments,
    dirty: Boolean(legacyText || legacyAttachments.length),
    lastLocalEditAt: legacyText || legacyAttachments.length ? Date.now() : 0,
  };
  liveCache.set(roomId, draft);
  if (!publishedCache.has(roomId)) publishedCache.set(roomId, draft.text);
  if (!publishedListPreviewCache.has(roomId)) {
    publishedListPreviewCache.set(roomId, JSON.stringify(listPreviewOf(draft)));
  }
  if (draft.dirty) saveLocal(draft);
  return draft;
}

function listPreviewOf(draft: LocalDraft): DraftListPreview {
  const text = draftListPreviewText(
    draft.text,
    draft.attachments.length,
    Boolean(draft.reply_to_event_id),
  );
  const serverAt = parsedTimestamp(draft.content_updated_at);
  const timestamp = Math.max(
    draft.lastLocalEditAt,
    Number.isFinite(serverAt) ? serverAt : 0,
  );
  return {
    active: Boolean(text),
    text,
    updatedAt: timestamp > 0 ? new Date(timestamp).toISOString() : "",
    originDevice: draft.origin_device,
  };
}

function publish(roomId: string) {
  const draft = readLocal(roomId);
  const v = draft.text;
  const preview = JSON.stringify(listPreviewOf(draft));
  if (
    publishedCache.get(roomId) === v &&
    publishedListPreviewCache.get(roomId) === preview
  ) return;
  publishedCache.set(roomId, v);
  publishedListPreviewCache.set(roomId, preview);
  emit();
}

function schedulePublish(roomId: string, immediate = false) {
  const existing = publishTimers.get(roomId);
  if (existing) clearTimeout(existing);
  publishTimers.delete(roomId);
  if (immediate) {
    publish(roomId);
    return;
  }
  publishTimers.set(
    roomId,
    setTimeout(() => {
      publishTimers.delete(roomId);
      publish(roomId);
    }, PUBLISH_DELAY_MS),
  );
}

async function flushServerOnce(roomId: string) {
  if (!canPersist()) return;
  const draft = readLocal(roomId);
  if (!draft.dirty || draft.syncBlocked) return;
  if (draft.nextSyncAt > Date.now()) {
    scheduleRetry(roomId, draft.nextSyncAt);
    return;
  }
  const sent = {
    text: draft.text,
    // `id` is a local staged-row identity. Glass accepts only the durable
    // media descriptor, so never leak that UI-only field into cloud drafts.
    attachments: cloudDraftAttachments(draft.attachments),
    reply_to_event_id: draft.reply_to_event_id,
    version: draft.version,
    content_updated_at: draft.content_updated_at ||
      (draft.lastLocalEditAt > 0 ? new Date(draft.lastLocalEditAt).toISOString() : ""),
  };
  try {
    const remote = await api.putDraft(roomId, {
      text: sent.text,
      attachments: sent.attachments,
      reply_to_event_id: sent.reply_to_event_id,
      base_version: sent.version,
      origin_device: deviceId(),
      content_updated_at: sent.content_updated_at,
    });
    // The acknowledgement applies against the latest local snapshot. A newer
    // realtime conflict may have arrived while this request was in flight and
    // must not be erased by this older response.
    await applyServerDraft(remote, { ack: true });
    const latest = readLocal(roomId);
    if (latest.dirty && !latest.syncBlocked) scheduleServer(roomId);
  } catch (err) {
    let failure: unknown = err;
    if (err instanceof ApiError && err.status === 409) {
      try {
        const body = err.body as { current?: DraftState } | null;
        // Rolling deployments and intermediaries may strip the optional 409
        // body. Resolve the authoritative draft with GET instead of leaving a
        // dirty composer permanently stalled as "not synced".
        const current = body?.current ?? await api.draft(roomId);
        const currentMatchesSent =
          sent.text === (current.text || "") &&
          sent.reply_to_event_id === (current.reply_to_event_id || "") &&
          draftAttachmentsMatch(sent.attachments, current.attachments ?? []);
        // A lost response or another tab may already have committed this exact
        // snapshot. Treat that 409 as an acknowledgement; a divergent newer
        // snapshot is reconciled by applyServerDraft without interrupting input.
        await applyServerDraft(current, { ack: currentMatchesSent });
        const latest = readLocal(roomId);
        if (latest.dirty && !latest.syncBlocked) scheduleServer(roomId);
        return;
      } catch (recoveryError) {
        failure = recoveryError;
      }
    }
    const latest = readLocal(roomId);
    // A newer server frame may have established an actionable conflict while
    // this request was in flight. Its decision barrier must win over a late
    // transport failure from the superseded request.
    if (
      latest.pendingRemote &&
      latest.syncBlocked &&
      latest.syncError === "conflict"
    ) {
      return;
    }
    const attempts = (latest.syncAttempts || 0) + 1;
    const status = failure instanceof ApiError ? failure.status : 0;
    const retryAfter = failure instanceof ApiError ? failure.retryAfterMs : null;
    const decision = decideClientRetry(status, attempts, Date.now(), undefined, retryAfter);
    latest.syncAttempts = attempts;
    latest.syncBlocked = decision.state === "blocked";
    latest.nextSyncAt = decision.nextAttemptAt;
    latest.syncError = failure instanceof Error ? failure.message : "draft sync failed";
    await saveLocal(latest);
    if (!latest.syncBlocked) scheduleRetry(roomId, latest.nextSyncAt);
    emit();
  }
}

async function flushServer(roomId: string) {
  const draft = readLocal(roomId);
  if (draft.pendingClearAfterSend) {
    if (hasExplicitDraftConflict(draft) || draft.syncBlocked) return;
    return deleteServerDraftAfterSend(roomId);
  }
  const active = serverInFlight.get(roomId);
  if (active) return active;
  const run = flushServerOnce(roomId).finally(() => {
    if (serverInFlight.get(roomId) === run) serverInFlight.delete(roomId);
  });
  serverInFlight.set(roomId, run);
  return run;
}

function scheduleServer(roomId: string) {
  const old = serverTimers.get(roomId);
  if (old) clearTimeout(old);
  serverTimers.set(
    roomId,
    setTimeout(() => {
      serverTimers.delete(roomId);
      const max = maxTimers.get(roomId);
      if (max) {
        clearTimeout(max);
        maxTimers.delete(roomId);
      }
      void flushServer(roomId);
    }, SERVER_IDLE_MS),
  );
  if (!maxTimers.has(roomId)) {
    maxTimers.set(
      roomId,
      setTimeout(() => {
        const idle = serverTimers.get(roomId);
        if (idle) clearTimeout(idle);
        serverTimers.delete(roomId);
        maxTimers.delete(roomId);
        void flushServer(roomId);
      }, SERVER_MAX_MS),
    );
  }
}

function markDirty(roomId: string): Promise<boolean> {
  const draft = readLocal(roomId);
  draft.dirty = true;
  draft.lastLocalEditAt = Date.now();
  draft.content_updated_at = new Date(draft.lastLocalEditAt).toISOString();
  draft.origin_device = deviceId();
  draft.localClearedAt = draft.text.length || draft.attachments.length || draft.reply_to_event_id
    ? 0
    : draft.lastLocalEditAt;
  if (draft.pendingRemote) {
    // Typing is the decision: preserve the live local input, silently rebase
    // it onto the latest known cloud version, and resume normal draft sync.
    draft.version = Math.max(draft.version, draft.pendingRemote.version);
    draft.updated_at = draft.pendingRemote.updated_at;
    draft.pendingRemote = null;
    if (draft.syncError === "conflict") {
      draft.syncError = undefined;
      draft.syncAttempts = 0;
      draft.nextSyncAt = 0;
      draft.syncBlocked = false;
      cancelRetry(roomId);
    }
  }
  if (!draft.pendingClearAfterSend) {
    draft.syncError = undefined;
    draft.syncAttempts = 0;
    draft.nextSyncAt = 0;
    draft.syncBlocked = false;
    cancelRetry(roomId);
  }
  const committed = saveLocal(draft);
  if (!draft.pendingClearAfterSend && !draft.syncBlocked) scheduleServer(roomId);
  emit();
  return committed;
}

export function getDraft(roomId: string): string {
  if (typeof window === "undefined" || !roomId) return "";
  return readLocal(roomId).text;
}

export function getDraftComposerState(roomId: string): DraftComposerState {
  if (typeof window === "undefined" || !roomId) {
    return {
      text: "",
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: "none",
      formattingMode: "markdown",
    };
  }
  const draft = readLocal(roomId);
  const selection = normalizeSelection(
    draft.text,
    draft.selection_start,
    draft.selection_end,
    draft.selection_direction,
  );
  return {
    text: draft.text,
    selectionStart: selection.selection_start,
    selectionEnd: selection.selection_end,
    selectionDirection: selection.selection_direction,
    formattingMode: draft.formatting_mode,
  };
}

function publishedDraft(roomId: string): string {
  if (typeof window === "undefined" || !roomId) return "";
  const cached = publishedCache.get(roomId);
  if (cached !== undefined) return cached;
  const v = readLocal(roomId).text;
  publishedCache.set(roomId, v);
  return v;
}

export function setDraft(
  roomId: string,
  text: string,
  selection?: {
    start: number;
    end: number;
    direction?: DraftSelectionDirection;
  },
): Promise<boolean> {
  if (typeof window === "undefined" || !roomId) return Promise.resolve(false);
  const draft = readLocal(roomId);
  const textChanged = draft.text !== text;
  const nextSelection = selection
    ? normalizeSelection(text, selection.start, selection.end, selection.direction)
    : normalizeSelection(
        text,
        textChanged ? text.length : draft.selection_start,
        textChanged ? text.length : draft.selection_end,
        textChanged ? "none" : draft.selection_direction,
      );
  const selectionChanged =
    draft.selection_start !== nextSelection.selection_start ||
    draft.selection_end !== nextSelection.selection_end ||
    draft.selection_direction !== nextSelection.selection_direction;
  if (!textChanged && !selectionChanged) return Promise.resolve(true);
  draft.text = text;
  Object.assign(draft, nextSelection);
  if (textChanged) {
    const committed = markDirty(roomId);
    schedulePublish(roomId, !text);
    return committed;
  } else {
    return saveLocal(draft);
  }
}

export function setDraftSelection(
  roomId: string,
  start: number,
  end: number,
  direction: DraftSelectionDirection = "none",
): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  const next = normalizeSelection(draft.text, start, end, direction);
  if (
    draft.selection_start === next.selection_start &&
    draft.selection_end === next.selection_end &&
    draft.selection_direction === next.selection_direction
  ) {
    return;
  }
  Object.assign(draft, next);
  void saveLocal(draft);
}

export function setDraftFormattingMode(roomId: string, mode: DraftFormattingMode): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  if (draft.formatting_mode === mode) return;
  draft.formatting_mode = mode;
  void saveLocal(draft);
}

export function setDraftFocused(roomId: string, focused: boolean): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  draft.focused = focused;
}

export function getDraftAttachments(roomId: string): DraftAttachment[] {
  if (typeof window === "undefined" || !roomId) return [];
  return readLocal(roomId).attachments;
}

export function setDraftAttachments(roomId: string, attachments: DraftAttachment[]): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  const next = sanitizeAttachments(attachments);
  if (JSON.stringify(draft.attachments) === JSON.stringify(next)) return;
  draft.attachments = next;
  markDirty(roomId);
  schedulePublish(roomId);
}


export function getDraftReply(roomId: string): ReplyDraftTarget | null {
  if (typeof window === "undefined" || !roomId) return null;
  const draft = readLocal(roomId);
  const snapshot = draft.reply_to_snapshot as ReplyDraftTarget;
  const signature = draft.reply_to_event_id
    ? [
        draft.reply_to_event_id,
        snapshot.sender_handle ?? "",
        snapshot.sender_kind ?? "",
        snapshot.type ?? "",
        snapshot.preview ?? "",
      ].join("\u0000")
    : "";
  const cached = publishedReplyCache.get(roomId);
  if (cached?.signature === signature) return cached.value;
  const value: ReplyDraftTarget | null = draft.reply_to_event_id ? {
    event_id: draft.reply_to_event_id,
    sender_handle: snapshot.sender_handle,
    sender_kind: snapshot.sender_kind,
    type: snapshot.type,
    preview: snapshot.preview,
  } : null;
  publishedReplyCache.set(roomId, { signature, value });
  return value;
}

export function setDraftReply(roomId: string, reply: ReplyDraftTarget | null): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  const nextId = reply?.event_id ?? "";
  const current = draft.reply_to_snapshot ?? {};
  if (
    draft.reply_to_event_id === nextId &&
    (current.sender_handle ?? undefined) === reply?.sender_handle &&
    (current.sender_kind ?? undefined) === reply?.sender_kind &&
    (current.type ?? undefined) === reply?.type &&
    (current.preview ?? undefined) === reply?.preview
  ) {
    return;
  }
  draft.reply_to_event_id = nextId;
  draft.reply_to_snapshot = reply ?? {};
  markDirty(roomId);
  schedulePublish(roomId);
}

export function flushDraft(roomId: string): void {
  if (typeof window === "undefined" || !roomId) return;
  const t = publishTimers.get(roomId);
  if (t) clearTimeout(t);
  publishTimers.delete(roomId);
  publish(roomId);
  const draft = readLocal(roomId);
  if (draft.pendingClearAfterSend) {
    if (!hasExplicitDraftConflict(draft) && !draft.syncBlocked) {
      void deleteServerDraftAfterSend(roomId);
    }
  }
  else void flushServer(roomId);
}

export function retryDraftSync(roomId: string): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  if (!draft.dirty && !draft.pendingClearAfterSend) return;
  // A legacy conflict barrier may still exist in pre-migration memory. Never
  // let a retry turn a preserved divergent remote draft into an authorized
  // DELETE; hydration resolves valid legacy snapshots first.
  if (hasExplicitDraftConflict(draft)) return;
  draft.syncBlocked = false;
  draft.nextSyncAt = 0;
  draft.syncError = undefined;
  saveLocal(draft);
  cancelRetry(roomId);
  if (draft.pendingClearAfterSend) void deleteServerDraftAfterSend(roomId);
  else void flushServer(roomId);
  emit();
}

export type DraftSyncStatus = {
  dirty: boolean;
  blocked: boolean;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  localDurabilityPending: boolean;
  localDurabilityError: string | null;
};

export function draftSyncStatus(roomId: string): DraftSyncStatus {
  const draft = readLocal(roomId);
  return {
    dirty: draft.dirty,
    blocked: draft.syncBlocked,
    attempts: draft.syncAttempts,
    nextAttemptAt: draft.nextSyncAt,
    error: draft.syncError ?? null,
    localDurabilityPending: localDurabilityPending.has(roomId),
    localDurabilityError: localDurabilityErrors.get(roomId) ?? null,
  };
}

export function useDraftSyncStatus(roomId: string): DraftSyncStatus {
  const snapshot = React.useSyncExternalStore(
    subscribe,
    () => JSON.stringify(draftSyncStatus(roomId)),
    () => JSON.stringify({ dirty: false, blocked: false, attempts: 0, nextAttemptAt: 0, error: null, localDurabilityPending: false, localDurabilityError: null }),
  );
  return React.useMemo(() => JSON.parse(snapshot) as DraftSyncStatus, [snapshot]);
}

export function clearDraftAfterSend(roomId: string): Promise<boolean> {
  if (typeof window === "undefined" || !roomId) return Promise.resolve(false);
  const draft = readLocal(roomId);
  const hasSentComposer = Boolean(
    draft.text || draft.attachments.length || draft.reply_to_event_id,
  );
  if (hasSentComposer) {
    // Persist the exact cloud semantics before replacing the composer with its
    // local tombstone. If a preceding PUT reached Glass but its response was
    // lost, this is the durable proof that a matching 409 can be rebased and
    // cleared rather than resurrected or shown as a false conflict.
    draft.pendingClearAfterSend = {
      text: draft.text,
      attachments: cloudDraftAttachments(draft.attachments),
      reply_to_event_id: draft.reply_to_event_id,
      base_version: draft.version,
      content_updated_at: draft.content_updated_at,
    };
  }
  draft.text = "";
  draft.selection_start = 0;
  draft.selection_end = 0;
  draft.selection_direction = "none";
  draft.attachments = [];
  draft.reply_to_event_id = "";
  draft.reply_to_snapshot = {};
  draft.dirty = false;
  draft.pendingRemote = null;
  draft.syncError = undefined;
  draft.syncAttempts = 0;
  draft.nextSyncAt = 0;
  draft.syncBlocked = false;
  draft.lastLocalEditAt = Date.now();
  draft.content_updated_at = "";
  draft.localClearedAt = draft.lastLocalEditAt;
  cancelRetry(roomId);
  cancelServerSchedule(roomId);
  const locallyCommitted = saveLocal(draft);
  schedulePublish(roomId, true);
  if (!canPersist()) return locallyCommitted;
  void deleteServerDraftAfterSend(roomId);
  return locallyCommitted;
}

function deleteServerDraftAfterSend(roomId: string): Promise<void> {
  const activeClear = clearInFlight.get(roomId);
  if (activeClear) return activeClear;
  const pending = readLocal(roomId);
  if (
    !pending.pendingClearAfterSend ||
    hasExplicitDraftConflict(pending) ||
    pending.syncBlocked
  ) {
    return Promise.resolve();
  }
  if (pending.nextSyncAt > Date.now()) {
    scheduleRetry(roomId, pending.nextSyncAt);
    return Promise.resolve();
  }
  // A debounced PUT may already have captured the pre-send text. Let it finish
  // and adopt its returned version before issuing the clear, otherwise the PUT
  // can land after DELETE and resurrect a message that was already sent.
  const previous = serverInFlight.get(roomId);
  const run = (async () => {
    await previous?.catch(() => undefined);
    const afterPrevious = readLocal(roomId);
    if (
      !afterPrevious.pendingClearAfterSend ||
      hasExplicitDraftConflict(afterPrevious) ||
      afterPrevious.syncBlocked
    ) {
      return;
    }
    const attempt = async (baseVersion: number, mayRebaseOnce: boolean): Promise<void> => {
      const beforeDelete = readLocal(roomId);
      if (
        !beforeDelete.pendingClearAfterSend ||
        hasExplicitDraftConflict(beforeDelete) ||
        beforeDelete.syncBlocked
      ) {
        return;
      }
      try {
        const remote = await api.deleteDraft(roomId, {
          base_version: baseVersion,
          origin_device: deviceId(),
        });
        if (!serverDraftIsCleared(remote)) {
          await resolveClearRaceSilently(readLocal(roomId), remote);
          return;
        }
        await applyServerDraft(remote, { ack: true, clearAck: true });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) {
          await recordClearFailure(roomId, err);
          return;
        }
        const body = err.body as { current?: DraftState } | null;
        const current = body?.current;
        if (!current) {
          await recordClearFailure(roomId, err);
          return;
        }
        if (serverDraftIsCleared(current)) {
          // The clear already won elsewhere; the version conflict is an
          // idempotent success and must not ask the user to clear it again.
          await applyServerDraft(current, { ack: true, clearAck: true });
          return;
        }
        const latest = readLocal(roomId);
        const recovery = latest.pendingClearAfterSend;
        const requiredBase = recovery
          ? Math.max(recovery.base_version, latest.version)
          : latest.version;
        const matchesPreSend = Boolean(
          recovery &&
          current.version >= requiredBase &&
          semanticDraftMatches(
            recovery.text,
            recovery.attachments,
            recovery.reply_to_event_id,
            current,
          ),
        );
        if (mayRebaseOnce && matchesPreSend) {
          // The preceding PUT committed but its response was lost. Adopt only
          // its version (never its sent text), then retry DELETE exactly once.
          await applyServerDraft(current, { ack: true });
          await attempt(current.version, false);
          return;
        }
        if (current.version <= requiredBase) {
          // Glass increments the version on every write, so an equal/older
          // divergent frame is only the request's base context. Preserve the
          // recovery tombstone and retry instead of manufacturing a conflict.
          await recordClearFailure(
            roomId,
            new ApiError(503, {}, "Draft clear has not been confirmed yet"),
          );
          return;
        }
        // Another device authored a different draft before this clear landed.
        // Cancel the destructive clear and reconcile it silently.
        await resolveClearRaceSilently(latest, current);
      }
    };

    await attempt(readLocal(roomId).version, true);
  })().finally(() => {
    if (clearInFlight.get(roomId) === run) clearInFlight.delete(roomId);
    if (serverInFlight.get(roomId) === run) serverInFlight.delete(roomId);
    const currentLocal = readLocal(roomId);
    if (
      !currentLocal.pendingClearAfterSend &&
      currentLocal.dirty &&
      !currentLocal.syncBlocked
    ) {
      scheduleServer(roomId);
    }
  });
  clearInFlight.set(roomId, run);
  serverInFlight.set(roomId, run);
  return run;
}

async function recordClearFailure(roomId: string, error: unknown): Promise<void> {
  const latest = readLocal(roomId);
  if (!latest.pendingClearAfterSend || hasExplicitDraftConflict(latest)) return;
  const attempts = (latest.syncAttempts || 0) + 1;
  const status = error instanceof ApiError ? error.status : 0;
  const retryAfter = error instanceof ApiError ? error.retryAfterMs : null;
  const decision = decideClientRetry(
    status,
    attempts,
    Date.now(),
    undefined,
    retryAfter,
  );
  latest.syncAttempts = attempts;
  latest.syncBlocked = decision.state === "blocked";
  latest.nextSyncAt = decision.nextAttemptAt;
  latest.syncError = error instanceof Error
    ? error.message
    : "Could not finish syncing this draft";
  cancelServerSchedule(roomId);
  if (latest.syncBlocked) cancelRetry(roomId);
  await saveLocal(latest);
  if (!latest.syncBlocked) scheduleRetry(roomId, latest.nextSyncAt);
  emit();
}

export function retryLocalDraftPersistence(roomId: string): Promise<boolean> {
  if (typeof window === "undefined" || !roomId) return Promise.resolve(false);
  return saveLocal(readLocal(roomId));
}

export function hasUncommittedLocalDraft(roomId?: string | null): boolean {
  if (roomId) {
    return localDurabilityPending.has(roomId) || localDurabilityErrors.has(roomId);
  }
  return localDurabilityPending.size > 0 || localDurabilityErrors.size > 0;
}

/** Re-commit every live composer snapshot before a desktop quit/update. This
 * waits only for local strict-durability journals; cloud sync can safely resume
 * next launch and must never make quitting depend on the network. */
export async function prepareDraftsForDesktopLifecycle(): Promise<boolean> {
  if (typeof window === "undefined") return true;
  const results = await Promise.all(
    [...liveCache.values()].map((draft) => saveLocal(draft).catch(() => false)),
  );
  return results.every(Boolean) && allowDraftNavigation();
}

export const DRAFT_DURABILITY_BLOCKED_EVENT = "silicon-interface:draft-durability-blocked";

export function allowDraftNavigation(roomId?: string | null): boolean {
  const issue = currentStorageIssue();
  const mediaOnlyInMemory = issue?.severity === "blocked" && issue.area === "media";
  if (
    !hasUncommittedLocalDraft(roomId) &&
    !hasActiveMediaTransfers() &&
    !hasPendingMediaDurability() &&
    !hasFailedMediaDurability() &&
    !hasActiveVoiceRecording() &&
    !mediaOnlyInMemory
  ) return true;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent(DRAFT_DURABILITY_BLOCKED_EVENT, { detail: { roomId: roomId ?? null } }),
    );
  }
  return false;
}

function resetDraftSyncState(draft: LocalDraft): void {
  draft.syncError = undefined;
  draft.syncAttempts = 0;
  draft.nextSyncAt = 0;
  draft.syncBlocked = false;
}

function hasExplicitDraftConflict(draft: LocalDraft): boolean {
  return Boolean(
    draft.pendingRemote &&
    draft.syncBlocked &&
    draft.syncError === "conflict",
  );
}

function clearMatchingPendingBarrier(draft: LocalDraft, server: DraftState): boolean {
  if (!draft.pendingRemote || !serverDraftsMatch(draft.pendingRemote, server)) return false;
  draft.pendingRemote = null;
  if (draft.syncError === "conflict") resetDraftSyncState(draft);
  return true;
}

function rebaseLocalOverRemote(draft: LocalDraft, server: DraftState): Promise<boolean> {
  draft.version = Math.max(draft.version, server.version);
  draft.updated_at = server.updated_at;
  draft.origin_device = deviceId();
  draft.lastServerSyncAt = Date.now();
  draft.pendingRemote = null;
  resetDraftSyncState(draft);
  const saved = saveLocal(draft);
  emit();
  if (draft.dirty) scheduleServer(server.room_id);
  return saved;
}

function adoptServerProjection(draft: LocalDraft, server: DraftState): Promise<boolean> {
  cancelRetry(server.room_id);
  cancelServerSchedule(server.room_id);
  draft.text = server.text || "";
  draft.selection_start = draft.text.length;
  draft.selection_end = draft.text.length;
  draft.selection_direction = "none";
  draft.attachments = sanitizeAttachments(server.attachments ?? []);
  draft.reply_to_event_id = server.reply_to_event_id || "";
  draft.reply_to_snapshot = server.reply_to_snapshot ?? {};
  draft.version = Math.max(draft.version, server.version);
  draft.updated_at = server.updated_at;
  draft.content_updated_at = server.content_updated_at ?? server.updated_at;
  draft.lastLocalEditAt = remoteContentTimestamp(server);
  draft.lastServerSyncAt = Date.now();
  draft.origin_device = server.origin_device ?? "";
  draft.dirty = false;
  draft.pendingRemote = null;
  draft.pendingClearAfterSend = null;
  resetDraftSyncState(draft);
  const remoteTimestamp = parsedTimestamp(server.cleared_at || server.updated_at);
  draft.localClearedAt = localDraftHasContent(draft)
    ? 0
    : Math.max(draft.localClearedAt, remoteTimestamp, Date.now());
  const saved = saveLocal(draft);
  schedulePublish(server.room_id, true);
  emit();
  return saved;
}

/** A post-send DELETE can race a draft authored elsewhere. Never keep asking
 * the user which one to retain: a newer live local edit stays authoritative;
 * otherwise the complete cloud draft is restored and the delete is cancelled. */
function resolveClearRaceSilently(draft: LocalDraft, server: DraftState): Promise<boolean> {
  draft.pendingClearAfterSend = null;
  cancelRetry(server.room_id);
  cancelServerSchedule(server.room_id);
  return draft.dirty
    ? rebaseLocalOverRemote(draft, server)
    : adoptServerProjection(draft, server);
}

/** A clean empty local composer can still receive a delayed active snapshot
 * from an older tab/build. When the locally persisted clear was authored after
 * that snapshot, reassert the tombstone against the server version instead of
 * resurrecting the text or recreating the retired conflict modal. */
function reassertNewerLocalClear(draft: LocalDraft, server: DraftState): Promise<boolean> {
  cancelRetry(server.room_id);
  cancelServerSchedule(server.room_id);
  draft.version = Math.max(draft.version, server.version);
  draft.updated_at = server.updated_at;
  draft.origin_device = deviceId();
  draft.pendingRemote = null;
  draft.pendingClearAfterSend = {
    text: server.text || "",
    attachments: cloudDraftAttachments(server.attachments ?? []),
    reply_to_event_id: server.reply_to_event_id || "",
    base_version: server.version,
    content_updated_at: server.content_updated_at ?? server.updated_at,
  };
  resetDraftSyncState(draft);
  const saved = saveLocal(draft);
  schedulePublish(server.room_id, true);
  emit();
  Promise.resolve().then(() => void deleteServerDraftAfterSend(server.room_id));
  return saved;
}

function clearIsAuthoritativeForRecovery(
  recovery: PendingClearAfterSend,
  server: DraftState,
  knownVersion: number,
  directDeleteAck: boolean,
): boolean {
  if (!serverDraftIsCleared(server)) return false;
  const requiredBase = Math.max(recovery.base_version, knownVersion);
  return server.version > requiredBase ||
    (directDeleteAck && requiredBase === 0 && server.version === 0);
}

export function applyServerDraft(
  server: DraftState,
  opts: { ack?: boolean; clearAck?: boolean } = {},
): Promise<boolean> {
  if (typeof window === "undefined" || !server.room_id) return Promise.resolve(false);
  const draft = readLocal(server.room_id);
  const matchesServer =
    semanticDraftMatches(draft.text, draft.attachments, draft.reply_to_event_id, server);
  const pendingVersion = draft.pendingRemote?.version ?? -1;
  const localVersion = draft.version;
  const recovery = draft.pendingClearAfterSend;

  if (recovery) {
    const matchesRecovery = semanticDraftMatches(
      recovery.text,
      recovery.attachments,
      recovery.reply_to_event_id,
      server,
    );
    if (
      clearIsAuthoritativeForRecovery(
        recovery,
        server,
        localVersion,
        opts.clearAck === true,
      )
    ) {
      // A server clear newer than the captured pre-send base is the only
      // automatic terminal proof for this recovery intent. Preserve any newer
      // local edit, but remove a websocket barrier for this exact clear.
      draft.pendingClearAfterSend = null;
      cancelRetry(server.room_id);
      if (draft.pendingRemote && draft.pendingRemote.version <= server.version) {
        draft.pendingRemote = null;
      } else {
        clearMatchingPendingBarrier(draft, server);
      }
      draft.version = Math.max(draft.version, server.version);
      if (server.version >= localVersion) {
        draft.updated_at = server.updated_at;
        if (serverDraftIsCleared(server)) {
          if (!localDraftHasContent(draft)) draft.content_updated_at = "";
        } else {
          draft.content_updated_at = server.content_updated_at ?? draft.content_updated_at;
        }
        draft.origin_device = server.origin_device ?? "";
      }
      draft.lastServerSyncAt = Date.now();
      if (matchesServer && server.version >= localVersion) draft.dirty = false;
      if (!draft.pendingRemote) resetDraftSyncState(draft);
      const saved = saveLocal(draft);
      schedulePublish(server.room_id, true);
      emit();
      if (draft.dirty && !draft.syncBlocked) scheduleServer(server.room_id);
      return saved;
    }
    if (serverDraftIsCleared(server)) {
      // An older/equal clear can predate the ambiguous PUT. It cannot prove the
      // sent snapshot is absent, so retain the durable tombstone and retry.
      return Promise.resolve(true);
    }
    const requiredBase = Math.max(recovery.base_version, localVersion);
    if (server.version < requiredBase) return Promise.resolve(true);
    if (matchesRecovery && server.version >= requiredBase) {
      // The ambiguous PUT is now authoritative. Rebase the pending clear onto
      // its version without restoring the already-sent composer contents.
      clearMatchingPendingBarrier(draft, server);
      recovery.base_version = Math.max(
        recovery.base_version,
        localVersion,
        server.version,
      );
      draft.version = Math.max(draft.version, server.version);
      if (server.version >= localVersion) {
        draft.updated_at = server.updated_at;
        draft.origin_device = server.origin_device ?? "";
      }
      draft.lastServerSyncAt = Date.now();
      if (!draft.pendingRemote) resetDraftSyncState(draft);
      const saved = saveLocal(draft);
      emit();
      Promise.resolve().then(() => void deleteServerDraftAfterSend(server.room_id));
      return saved;
    }
    if (server.version <= requiredBase) {
      return Promise.resolve(true);
    }
    // The cloud draft moved to different semantics before the clear could be
    // proven. Cancel the delete and reconcile without interrupting the input.
    return resolveClearRaceSilently(draft, server);
  }

  // Only the direct response to our own request is an acknowledgement. An
  // origin_device identifies a browser installation, not a specific tab or
  // request, so treating every same-device replay as an ack could downgrade a
  // newer local base or hide a real cross-tab update.
  if (opts.ack) {
    clearMatchingPendingBarrier(draft, server);
    draft.version = Math.max(draft.version, server.version);
    if (server.version >= localVersion) {
      draft.updated_at = server.updated_at;
      draft.content_updated_at = server.content_updated_at ?? draft.content_updated_at;
      draft.origin_device = server.origin_device ?? "";
      draft.lastServerSyncAt = Date.now();
    }
    if (
      matchesServer &&
      server.version >= localVersion &&
      server.version >= pendingVersion
    ) {
      draft.dirty = false;
      draft.pendingRemote = null;
    }
    if (!draft.pendingRemote) {
      resetDraftSyncState(draft);
    }
    const saved = saveLocal(draft);
    emit();
    return saved;
  }

  // A complete matching snapshot is an idempotent delivery acknowledgement,
  // regardless of which connection delivered it. Do not resolve an already
  // known newer conflict with an older matching replay.
  if (
    matchesServer &&
    server.version >= localVersion &&
    server.version >= pendingVersion
  ) {
    draft.version = Math.max(draft.version, server.version);
    draft.updated_at = server.updated_at;
    draft.content_updated_at = server.content_updated_at ?? draft.content_updated_at;
    draft.origin_device = server.origin_device ?? "";
    draft.lastServerSyncAt = Date.now();
    draft.dirty = false;
    draft.pendingRemote = null;
    resetDraftSyncState(draft);
    const saved = saveLocal(draft);
    emit();
    return saved;
  }

  // A websocket echo from this installation may represent the snapshot that
  // was just uploaded while the user has already typed the next keystroke.
  // Rebase that newer local edit onto the echoed version silently. Device
  // origin cannot distinguish tabs, so same-device draft edits intentionally
  // use last-local-write-wins instead of presenting a false cross-device modal.
  const sameDeviceEcho = Boolean(
    server.origin_device && server.origin_device === deviceId(),
  );
  if (sameDeviceEcho && draft.dirty && server.version > localVersion) {
    draft.version = server.version;
    draft.updated_at = server.updated_at;
    draft.origin_device = server.origin_device ?? "";
    draft.lastServerSyncAt = Date.now();
    draft.pendingRemote = null;
    resetDraftSyncState(draft);
    const saved = saveLocal(draft);
    emit();
    scheduleServer(server.room_id);
    return saved;
  }

  const explicitConflict =
    Boolean(draft.pendingRemote) &&
    draft.syncBlocked &&
    draft.syncError === "conflict";

  // A dirty composer is based on its current server version. Replaying that
  // version (for example on room open or immediately after a local rebase) is
  // stale context, not a new update. Older frames are ignored as well.
  if (server.version < draft.version || (server.version === draft.version && draft.dirty)) {
    return Promise.resolve(true);
  }
  if (server.version === draft.version && explicitConflict) {
    return Promise.resolve(true);
  }

  const localClearIsNewer =
    !draft.dirty &&
    !localDraftHasContent(draft) &&
    !serverDraftIsCleared(server) &&
    draft.localClearedAt > 0 &&
    draft.localClearedAt > remoteContentTimestamp(server);
  if (localClearIsNewer) {
    return reassertNewerLocalClear(draft, server);
  }

  if (draft.dirty || explicitConflict) {
    return rebaseLocalOverRemote(draft, server);
  }
  return adoptServerProjection(draft, server);
}

/** Replace the server-synced draft projection from an authoritative initial
 * manifest. Absence clears only a previously synced clean copy; local edits,
 * queued persistence, and post-send clear recovery remain intact. */
export async function reconcileServerDraftManifest(
  activeDrafts: DraftState[],
  visibleRoomIds: string[] = [],
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const owner = ownerKey();
  if (!owner) return false;
  const activeByRoom = new Map(activeDrafts.map((draft) => [draft.room_id, draft]));
  const roomIds = new Set<string>([
    ...visibleRoomIds,
    ...activeByRoom.keys(),
    ...liveCache.keys(),
    ...(await listDraftJournalRoomIds(owner).catch(() => [])),
  ]);
  const localPrefix = `${PREFIX}${owner}:`;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(localPrefix)) roomIds.add(key.slice(localPrefix.length));
    }
  } catch {
    // IndexedDB + the in-memory cache still cover storage-restricted profiles.
  }

  let durable = true;
  for (const [roomId, server] of activeByRoom) {
    durable = (await applyServerDraft(server)) && durable;
    roomIds.delete(roomId);
  }
  for (const roomId of roomIds) {
    await hydrateDraftJournal(roomId);
    const draft = readLocal(roomId);
    const hasIntent = Boolean(
      draft.text || draft.attachments.length || draft.reply_to_event_id,
    );
    const unsyncedOrConflicted = Boolean(
      draft.dirty ||
      draft.pendingRemote ||
      draft.pendingClearAfterSend ||
      draft.syncBlocked ||
      draft.syncError ||
      localDurabilityPending.has(roomId) ||
      localDurabilityErrors.has(roomId) ||
      (hasIntent && draft.version === 0 && draft.lastServerSyncAt === 0),
    );
    if (unsyncedOrConflicted) continue;
    if (!hasIntent && draft.version === 0 && !draft.lastServerSyncAt) continue;

    draft.text = "";
    draft.selection_start = 0;
    draft.selection_end = 0;
    draft.selection_direction = "none";
    draft.attachments = [];
    draft.reply_to_event_id = "";
    draft.reply_to_snapshot = {};
    draft.content_updated_at = "";
    draft.dirty = false;
    draft.pendingRemote = null;
    draft.syncError = undefined;
    draft.syncAttempts = 0;
    draft.nextSyncAt = 0;
    draft.syncBlocked = false;
    draft.localClearedAt = Math.max(Date.now(), draft.localClearedAt + 1);
    cancelRetry(roomId);
    cancelServerSchedule(roomId);
    durable = (await saveLocal(draft)) && durable;
    schedulePublish(roomId, true);
  }
  emit();
  return durable;
}

export async function loadServerDraft(roomId: string): Promise<void> {
  if (!roomId || !canPersist()) return;
  try {
    const server = await api.draft(roomId);
    await applyServerDraft(server);
  } catch {
    /* old backend/offline: keep local-only */
  }
}

export async function loadAllServerDrafts(): Promise<void> {
  if (!canPersist()) return;
  try {
    const res = await api.drafts();
    for (const draft of res.drafts ?? []) await applyServerDraft(draft);
  } catch {
    /* old backend/offline: keep local-only */
  }
}

export async function migrateLegacyDrafts(roomIds: string[]): Promise<void> {
  const marker = migratedKey();
  if (typeof window === "undefined" || !marker || safeLocalGet(marker)) return;
  let safeToMarkMigrated = true;
  for (const roomId of roomIds) {
    const legacyText = safeLocalGet(`${LEGACY_TEXT_PREFIX}${roomId}`) ?? "";
    const legacyAttachments = readLegacyAttachments(roomId);
    if (!legacyText && legacyAttachments.length === 0) continue;
    try {
      const cloud = await api.draft(roomId);
      if (cloud.version === 0 || (!cloud.text && (cloud.attachments ?? []).length === 0)) {
        const local = readLocal(roomId);
        local.text = legacyText;
        local.attachments = legacyAttachments;
        local.dirty = true;
        saveLocal(local);
        await flushServer(roomId);
      } else {
        const backup = backupKey(roomId);
        if (backup) safeLocalSet(backup, JSON.stringify({ text: legacyText, attachments: legacyAttachments }));
        applyServerDraft(cloud);
      }
    } catch {
      safeToMarkMigrated = false;
      // Keep legacy local-only until the backend contract exists or connectivity returns.
    }
  }
  if (safeToMarkMigrated) safeLocalSet(marker, "1");
}

function subscribe(cb: () => void): () => void {
  ensureStorageBound();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

let lastSeenOwnerKey: string | null = null;

function ensureStorageBound() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  lastSeenOwnerKey = ownerKey();
  window.addEventListener("storage", (e) => {
    if (e.key && !e.key.startsWith(PREFIX) && !e.key.startsWith(LEGACY_TEXT_PREFIX)) return;
    liveCache.clear();
    localDurabilityPending.clear();
    localDurabilityErrors.clear();
    localSaveGeneration.clear();
    publishedCache.clear();
    publishedListPreviewCache.clear();
    publishedReplyCache.clear();
    emit();
  });
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const owner = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey ?? null;
    cleanupOwnerDraftStorage(owner);
    clearDraftTimers();
    liveCache.clear();
    localDurabilityPending.clear();
    localDurabilityErrors.clear();
    localSaveGeneration.clear();
    publishedCache.clear();
    publishedListPreviewCache.clear();
    publishedReplyCache.clear();
    emit();
  });
  authStore.subscribe(() => {
    const nextOwner = ownerKey();
    if (lastSeenOwnerKey && nextOwner && lastSeenOwnerKey !== nextOwner) {
      cleanupOwnerDraftStorage(null);
    }
    lastSeenOwnerKey = nextOwner;
    clearDraftTimers();
    liveCache.clear();
    localDurabilityPending.clear();
    localDurabilityErrors.clear();
    localSaveGeneration.clear();
    publishedCache.clear();
    publishedListPreviewCache.clear();
    publishedReplyCache.clear();
    emit();
  });
  window.addEventListener("beforeunload", (event) => {
    const issue = currentStorageIssue();
    if (
      !hasUncommittedLocalDraft() &&
      !hasActiveMediaTransfers() &&
      !hasPendingMediaDurability() &&
      !hasFailedMediaDurability() &&
      !hasActiveVoiceRecording() &&
      !(issue?.severity === "blocked" && issue.area === "media")
    ) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function useDraft(roomId: string): string {
  return React.useSyncExternalStore(
    subscribe,
    () => publishedDraft(roomId),
    () => "",
  );
}

export function useDraftListPreview(roomId: string): DraftListPreview {
  const snapshot = React.useSyncExternalStore(
    subscribe,
    () => {
      const cached = publishedListPreviewCache.get(roomId);
      if (cached !== undefined) return cached;
      const value = JSON.stringify(listPreviewOf(readLocal(roomId)));
      publishedListPreviewCache.set(roomId, value);
      return value;
    },
    () => JSON.stringify({ active: false, text: "", updatedAt: "", originDevice: "" }),
  );
  return React.useMemo(() => JSON.parse(snapshot) as DraftListPreview, [snapshot]);
}

export function useDraftReply(roomId: string): ReplyDraftTarget | null {
  return React.useSyncExternalStore(
    subscribe,
    () => getDraftReply(roomId),
    () => null,
  );
}
