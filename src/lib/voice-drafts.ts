"use client";

import * as React from "react";

/**
 * Durable, per-room voice-note drafts.
 *
 * A Blob cannot be stored in localStorage, so voice notes use IndexedDB. The
 * in-memory mirror keeps recovery working when IndexedDB is unavailable (for
 * example, a locked-down/private browser) and makes same-session room switches
 * synchronous after the first read.
 */
export interface VoiceDraft {
  blob: Blob;
  durationMs: number;
  savedAt: number;
  /** Reused by every retry so a retained draft cannot create a second event. */
  clientId?: string;
}

interface StoredVoiceDraft extends VoiceDraft {
  roomId: string;
}

const DB_NAME = "silicon-interface-voice-drafts";
const DB_VERSION = 2;
const STORE_NAME = "drafts";
const LIVE_STORE_NAME = "live_chunks";
const META_PREFIX = "silicon-interface:voice-draft-meta:v1:";

export interface VoiceDraftListPreview {
  active: boolean;
  updatedAt: string;
}

interface StoredLiveVoiceChunk {
  id: string;
  roomId: string;
  clientId: string;
  sequence: number;
  startedAt: number;
  durationMs: number;
  mime: string;
  blob: Blob;
}

const memory = new Map<string, VoiceDraft>();
const metadataMemory = new Map<string, VoiceDraftListPreview>();
const metadataListeners = new Set<() => void>();
let databasePromise: Promise<IDBDatabase | null> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let metadataStorageBound = false;

const EMPTY_VOICE_PREVIEW = JSON.stringify({ active: false, updatedAt: "" });

function metadataKey(roomId: string): string {
  return `${META_PREFIX}${encodeURIComponent(roomId)}`;
}

function emitMetadata(): void {
  for (const listener of metadataListeners) listener();
}

export function getVoiceDraftListPreview(roomId: string): VoiceDraftListPreview {
  if (!roomId) return { active: false, updatedAt: "" };
  const cached = metadataMemory.get(roomId);
  if (cached) return cached;
  if (typeof window === "undefined") return { active: false, updatedAt: "" };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(metadataKey(roomId)) ?? "null") as
      Partial<VoiceDraftListPreview> | null;
    if (parsed?.active === true && typeof parsed.updatedAt === "string" && parsed.updatedAt) {
      const value = { active: true, updatedAt: parsed.updatedAt };
      metadataMemory.set(roomId, value);
      return value;
    }
  } catch {
    // IndexedDB remains the audio authority; the sidebar hint is best-effort.
  }
  return { active: false, updatedAt: "" };
}

function setVoiceDraftMetadata(roomId: string, savedAt: number): void {
  const next = { active: true, updatedAt: new Date(savedAt).toISOString() };
  const current = getVoiceDraftListPreview(roomId);
  if (current.active && current.updatedAt === next.updatedAt) return;
  metadataMemory.set(roomId, next);
  try {
    window.localStorage.setItem(metadataKey(roomId), JSON.stringify(next));
  } catch {
    // Keep the in-memory projection when localStorage is unavailable.
  }
  emitMetadata();
}

function clearVoiceDraftMetadata(roomId: string): void {
  const hadValue = metadataMemory.delete(roomId) || getVoiceDraftListPreview(roomId).active;
  metadataMemory.delete(roomId);
  try {
    window.localStorage.removeItem(metadataKey(roomId));
  } catch {
    // Best-effort sidebar metadata; the durable audio delete continues below.
  }
  if (hadValue) emitMetadata();
}

function subscribeVoiceDraftMetadata(listener: () => void): () => void {
  if (!metadataStorageBound && typeof window !== "undefined") {
    metadataStorageBound = true;
    window.addEventListener("storage", (event) => {
      if (event.key && !event.key.startsWith(META_PREFIX)) return;
      metadataMemory.clear();
      emitMetadata();
    });
  }
  metadataListeners.add(listener);
  return () => metadataListeners.delete(listener);
}

export function useVoiceDraftListPreview(roomId: string): VoiceDraftListPreview {
  const snapshot = React.useSyncExternalStore(
    subscribeVoiceDraftMetadata,
    () => JSON.stringify(getVoiceDraftListPreview(roomId)),
    () => EMPTY_VOICE_PREVIEW,
  );
  return React.useMemo(() => JSON.parse(snapshot) as VoiceDraftListPreview, [snapshot]);
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve) => {
    let settled = false;
    const finish = (value: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "roomId" });
        }
        if (!db.objectStoreNames.contains(LIVE_STORE_NAME)) {
          const live = db.createObjectStore(LIVE_STORE_NAME, { keyPath: "id" });
          live.createIndex("roomId", "roomId");
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        finish(db);
      };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });

  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(operation, operation).catch(() => undefined);
  return writeQueue;
}

function isVoiceDraft(value: unknown): value is StoredVoiceDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredVoiceDraft>;
  return (
    typeof draft.roomId === "string" &&
    typeof Blob !== "undefined" &&
    draft.blob instanceof Blob &&
    draft.blob.size > 0 &&
    typeof draft.durationMs === "number" &&
    Number.isFinite(draft.durationMs) &&
    draft.durationMs >= 0 &&
    typeof draft.savedAt === "number" &&
    Number.isFinite(draft.savedAt) &&
    (draft.clientId == null || typeof draft.clientId === "string")
  );
}

/** Save before upload/navigation so a crash or remount cannot discard audio. */
export function saveVoiceDraft(roomId: string, draft: VoiceDraft): Promise<void> {
  if (!roomId || draft.blob.size === 0) return Promise.resolve();
  memory.set(roomId, draft);
  setVoiceDraftMetadata(roomId, draft.savedAt);

  return enqueueWrite(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ roomId, ...draft } satisfies StoredVoiceDraft);
    await transactionDone(transaction);
  });
}

/** Restore a draft after a room remount or full page reload. */
export async function getVoiceDraft(roomId: string): Promise<VoiceDraft | null> {
  if (!roomId) return null;
  const cached = memory.get(roomId);
  if (cached) return cached;

  // Observe all earlier writes/deletes before reading from IndexedDB.
  await writeQueue;
  const db = await openDatabase();
  if (!db) return null;

  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(roomId);
    const result = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (isVoiceDraft(result)) {
      const draft: VoiceDraft = {
        blob: result.blob,
        durationMs: result.durationMs,
        savedAt: result.savedAt,
        clientId: result.clientId,
      };
      memory.set(roomId, draft);
      setVoiceDraftMetadata(roomId, draft.savedAt);
      return draft;
    }
  } catch {
    // Fall through to the live chunk journal. A browser crash can happen before
    // MediaRecorder's final stop event, but every completed slice remains usable.
  }
  const recovered = await recoverLiveVoiceDraft(roomId);
  if (recovered) memory.set(roomId, recovered);
  if (recovered) setVoiceDraftMetadata(roomId, recovered.savedAt);
  else clearVoiceDraftMetadata(roomId);
  return recovered;
}

function liveChunkId(roomId: string, clientId: string, sequence: number): string {
  return `${encodeURIComponent(roomId)}:${encodeURIComponent(clientId)}:${String(sequence).padStart(10, "0")}`;
}

function deleteLiveRows(
  transaction: IDBTransaction,
  roomId: string,
  clientId?: string,
): void {
  const store = transaction.objectStore(LIVE_STORE_NAME);
  const request = store.index("roomId").openCursor(IDBKeyRange.only(roomId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as Partial<StoredLiveVoiceChunk>;
    if (!clientId || row.clientId === clientId) cursor.delete();
    cursor.continue();
  };
}

/** Start a fresh crash journal before MediaRecorder begins producing slices. */
export function beginLiveVoiceDraft(roomId: string): Promise<void> {
  if (!roomId) return Promise.resolve();
  clearVoiceDraftMetadata(roomId);
  return enqueueWrite(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(LIVE_STORE_NAME, "readwrite");
    deleteLiveRows(transaction, roomId);
    await transactionDone(transaction);
  });
}

/** Append one MediaRecorder slice. Writes stay small as the recording grows. */
export function appendLiveVoiceChunk(
  input: Omit<StoredLiveVoiceChunk, "id">,
): Promise<void> {
  if (!input.roomId || !input.clientId || input.blob.size === 0) return Promise.resolve();
  if (!getVoiceDraftListPreview(input.roomId).active) {
    setVoiceDraftMetadata(input.roomId, input.startedAt);
  }
  return enqueueWrite(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(LIVE_STORE_NAME, "readwrite");
    transaction.objectStore(LIVE_STORE_NAME).put({
      ...input,
      id: liveChunkId(input.roomId, input.clientId, input.sequence),
    });
    await transactionDone(transaction);
  });
}

/** Rebuild the newest interrupted recording from its committed slices. */
export async function recoverLiveVoiceDraft(roomId: string): Promise<VoiceDraft | null> {
  if (!roomId) return null;
  await writeQueue;
  const db = await openDatabase();
  if (!db) return null;
  try {
    const transaction = db.transaction(LIVE_STORE_NAME, "readonly");
    const request = transaction.objectStore(LIVE_STORE_NAME).index("roomId").getAll(
      IDBKeyRange.only(roomId),
    );
    const values = await new Promise<StoredLiveVoiceChunk[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as StoredLiveVoiceChunk[]) ?? []);
      request.onerror = () => reject(request.error);
    });
    const valid = values.filter((row) =>
      row?.blob instanceof Blob &&
      row.blob.size > 0 &&
      typeof row.clientId === "string" &&
      Number.isSafeInteger(row.sequence) &&
      Number.isFinite(row.startedAt),
    );
    if (valid.length === 0) return null;
    const newest = valid.reduce((winner, row) => row.startedAt > winner.startedAt ? row : winner);
    const slices = valid
      .filter((row) => row.clientId === newest.clientId)
      .sort((left, right) => left.sequence - right.sequence);
    const blob = new Blob(slices.map((row) => row.blob), { type: newest.mime || "audio/webm" });
    if (blob.size === 0) return null;
    const recovered = {
      blob,
      durationMs: Math.max(...slices.map((row) => row.durationMs), 0),
      savedAt: Date.now(),
      clientId: newest.clientId,
    };
    setVoiceDraftMetadata(roomId, recovered.savedAt);
    return recovered;
  } catch {
    return null;
  }
}

export function clearLiveVoiceDraft(roomId: string, clientId?: string): Promise<void> {
  if (!roomId) return Promise.resolve();
  return enqueueWrite(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(LIVE_STORE_NAME, "readwrite");
    deleteLiveRows(transaction, roomId, clientId);
    await transactionDone(transaction);
    if (!memory.has(roomId)) clearVoiceDraftMetadata(roomId);
  });
}

/** Clear only after a server acknowledgement or an explicit user discard. */
export function clearVoiceDraft(roomId: string): Promise<void> {
  if (!roomId) return Promise.resolve();
  memory.delete(roomId);
  clearVoiceDraftMetadata(roomId);

  return enqueueWrite(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction([STORE_NAME, LIVE_STORE_NAME], "readwrite");
    transaction.objectStore(STORE_NAME).delete(roomId);
    deleteLiveRows(transaction, roomId);
    await transactionDone(transaction);
  });
}
