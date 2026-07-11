"use client";

import * as React from "react";

import { api, ApiError } from "./api";
import { authStore } from "./auth";
import { deviceId } from "./device-id";
import type { DraftAttachment, DraftState, ReplyDraftTarget } from "./types";

const LEGACY_TEXT_PREFIX = "silicon-interface:draft:";
const LEGACY_ATT_PREFIX = "silicon-interface:draft-att:";
const PREFIX = "silicon-interface:draft-v2:";
const BACKUP_PREFIX = "silicon-interface:draft-v2-backup:";
const MIGRATED_PREFIX = "silicon-interface:drafts-migrated:";
const PUBLISH_DELAY_MS = 2000;
const SERVER_IDLE_MS = 800;
const SERVER_MAX_MS = 5000;

type LocalDraft = {
  room_id: string;
  text: string;
  attachments: DraftAttachment[];
  reply_to_event_id: string;
  reply_to_snapshot: ReplyDraftTarget | Record<string, never>;
  version: number;
  updated_at: string;
  dirty: boolean;
  focused: boolean;
  lastLocalEditAt: number;
  lastServerSyncAt: number;
  pendingRemote?: DraftState | null;
  syncError?: string;
};

const liveCache = new Map<string, LocalDraft>();
const publishedCache = new Map<string, string>();
const publishedReplyCache = new Map<
  string,
  { signature: string; value: ReplyDraftTarget | null }
>();
const publishTimers = new Map<string, ReturnType<typeof setTimeout>>();
const serverTimers = new Map<string, ReturnType<typeof setTimeout>>();
const maxTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 0,
    updated_at: "",
    dirty: false,
    focused: false,
    lastLocalEditAt: 0,
    lastServerSyncAt: 0,
  };
}

function safeLocalGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* local draft cache is best effort */
  }
}

function sanitizeAttachments(list: DraftAttachment[]): DraftAttachment[] {
  return list
    .filter((a) => a && a.mediaId)
    .map((a) => ({
      id: a.id,
      mediaId: a.mediaId || (a as { media_id?: string }).media_id || "",
      mime: a.mime || "application/octet-stream",
      name: a.name || "attachment",
      size: a.size,
      kind: a.kind,
    }));
}

function saveLocal(draft: LocalDraft) {
  if (typeof window === "undefined" || !canPersist()) return;
  const key = storageKey(draft.room_id);
  if (!key) return;
  const hasData = Boolean(draft.text || draft.attachments.length || draft.reply_to_event_id);
  safeLocalSet(key, hasData ? JSON.stringify(draft) : null);
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
    return draft;
  }
  const key = storageKey(roomId);
  const raw = key ? safeLocalGet(key) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<LocalDraft>;
      const draft = { ...blank(roomId), ...parsed, attachments: sanitizeAttachments(parsed.attachments ?? []) };
      liveCache.set(roomId, draft);
      if (!publishedCache.has(roomId)) publishedCache.set(roomId, draft.text);
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
  if (draft.dirty) saveLocal(draft);
  return draft;
}

function publish(roomId: string) {
  const v = readLocal(roomId).text;
  if (publishedCache.get(roomId) === v) return;
  publishedCache.set(roomId, v);
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

async function flushServer(roomId: string) {
  if (!canPersist()) return;
  const draft = readLocal(roomId);
  if (!draft.dirty) return;
  try {
    const remote = await api.putDraft(roomId, {
      text: draft.text,
      attachments: draft.attachments,
      reply_to_event_id: draft.reply_to_event_id,
      base_version: draft.version,
      origin_device: deviceId(),
    });
    applyServerDraft(remote, { ack: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const body = err.body as { current?: DraftState } | null;
      if (body?.current) {
        const current = body.current;
        const latest = readLocal(roomId);
        latest.version = current.version;
        latest.pendingRemote = current;
        latest.syncError = "conflict";
        saveLocal(latest);
        emit();
      }
    } else {
      const latest = readLocal(roomId);
      latest.syncError = err instanceof Error ? err.message : "draft sync failed";
      saveLocal(latest);
      emit();
    }
  }
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

function markDirty(roomId: string) {
  const draft = readLocal(roomId);
  draft.dirty = true;
  draft.lastLocalEditAt = Date.now();
  draft.syncError = undefined;
  saveLocal(draft);
  scheduleServer(roomId);
  emit();
}

export function getDraft(roomId: string): string {
  if (typeof window === "undefined" || !roomId) return "";
  return readLocal(roomId).text;
}

function publishedDraft(roomId: string): string {
  if (typeof window === "undefined" || !roomId) return "";
  const cached = publishedCache.get(roomId);
  if (cached !== undefined) return cached;
  const v = readLocal(roomId).text;
  publishedCache.set(roomId, v);
  return v;
}

export function setDraft(roomId: string, text: string): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  const v = text.trim() ? text : "";
  if (draft.text === v) return;
  draft.text = v;
  markDirty(roomId);
  schedulePublish(roomId, !v);
}

export function setDraftFocused(roomId: string, focused: boolean): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  draft.focused = focused;
  saveLocal(draft);
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
}

export function flushDraft(roomId: string): void {
  if (typeof window === "undefined" || !roomId) return;
  const t = publishTimers.get(roomId);
  if (t) clearTimeout(t);
  publishTimers.delete(roomId);
  publish(roomId);
  void flushServer(roomId);
}

export function clearDraftAfterSend(roomId: string): void {
  if (typeof window === "undefined" || !roomId) return;
  const draft = readLocal(roomId);
  const baseVersion = draft.version;
  draft.text = "";
  draft.attachments = [];
  draft.reply_to_event_id = "";
  draft.reply_to_snapshot = {};
  draft.dirty = false;
  draft.pendingRemote = null;
  draft.syncError = undefined;
  saveLocal(draft);
  schedulePublish(roomId, true);
  if (!canPersist()) return;
  void api
    .deleteDraft(roomId, { base_version: baseVersion, origin_device: deviceId() })
    .then((remote) => applyServerDraft(remote, { ack: true }))
    .catch((err) => {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { current?: DraftState } | null;
        const current = body?.current;
        if (!current) return;
        const latest = readLocal(roomId);
        latest.version = current.version;
        latest.pendingRemote = current;
        latest.syncError = "conflict";
        saveLocal(latest);
        emit();
      }
    });
}

export function applyServerDraft(server: DraftState, opts: { ack?: boolean } = {}): void {
  if (typeof window === "undefined" || !server.room_id) return;
  const draft = readLocal(server.room_id);
  const sameDevice = server.origin_device && server.origin_device === deviceId();
  if ((opts.ack || sameDevice) && !(server.cleared_at && !draft.dirty && !draft.focused)) {
    draft.version = server.version;
    draft.updated_at = server.updated_at;
    draft.lastServerSyncAt = Date.now();
    draft.syncError = undefined;
    if (!draft.text && draft.attachments.length === 0 && !draft.reply_to_event_id) draft.dirty = false;
    saveLocal(draft);
    emit();
    return;
  }
  if (draft.dirty || draft.focused) {
    draft.version = Math.max(draft.version, server.version);
    draft.pendingRemote = server;
    saveLocal(draft);
    emit();
    return;
  }
  draft.text = server.text || "";
  draft.attachments = sanitizeAttachments(server.attachments ?? []);
  draft.reply_to_event_id = server.reply_to_event_id || "";
  draft.reply_to_snapshot = server.reply_to_snapshot ?? {};
  draft.version = server.version;
  draft.updated_at = server.updated_at;
  draft.dirty = false;
  draft.pendingRemote = null;
  draft.syncError = undefined;
  saveLocal(draft);
  schedulePublish(server.room_id, true);
  emit();
}

export async function loadServerDraft(roomId: string): Promise<void> {
  if (!roomId || !canPersist()) return;
  try {
    const server = await api.draft(roomId);
    applyServerDraft(server);
  } catch {
    /* old backend/offline: keep local-only */
  }
}

export async function loadAllServerDrafts(): Promise<void> {
  if (!canPersist()) return;
  try {
    const res = await api.drafts();
    for (const draft of res.drafts ?? []) applyServerDraft(draft);
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
    publishedCache.clear();
    publishedReplyCache.clear();
    emit();
  });
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const owner = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey ?? null;
    cleanupOwnerDraftStorage(owner);
    liveCache.clear();
    publishedCache.clear();
    publishedReplyCache.clear();
    emit();
  });
  authStore.subscribe(() => {
    const nextOwner = ownerKey();
    if (lastSeenOwnerKey && nextOwner && lastSeenOwnerKey !== nextOwner) {
      cleanupOwnerDraftStorage(null);
    }
    lastSeenOwnerKey = nextOwner;
    liveCache.clear();
    publishedCache.clear();
    publishedReplyCache.clear();
    emit();
  });
}

export function useDraft(roomId: string): string {
  return React.useSyncExternalStore(
    subscribe,
    () => publishedDraft(roomId),
    () => "",
  );
}

export function useDraftReply(roomId: string): ReplyDraftTarget | null {
  return React.useSyncExternalStore(
    subscribe,
    () => getDraftReply(roomId),
    () => null,
  );
}
