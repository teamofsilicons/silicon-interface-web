"use client";

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
}

interface StoredVoiceDraft extends VoiceDraft {
  roomId: string;
}

const DB_NAME = "silicon-interface-voice-drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";

const memory = new Map<string, VoiceDraft>();
let databasePromise: Promise<IDBDatabase | null> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

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
    Number.isFinite(draft.savedAt)
  );
}

/** Save before upload/navigation so a crash or remount cannot discard audio. */
export function saveVoiceDraft(roomId: string, draft: VoiceDraft): Promise<void> {
  if (!roomId || draft.blob.size === 0) return Promise.resolve();
  memory.set(roomId, draft);

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
    if (!isVoiceDraft(result)) return null;
    const draft: VoiceDraft = {
      blob: result.blob,
      durationMs: result.durationMs,
      savedAt: result.savedAt,
    };
    memory.set(roomId, draft);
    return draft;
  } catch {
    return null;
  }
}

/** Clear only after a server acknowledgement or an explicit user discard. */
export function clearVoiceDraft(roomId: string): Promise<void> {
  if (!roomId) return Promise.resolve();
  memory.delete(roomId);

  return enqueueWrite(async () => {
    const db = await openDatabase();
    if (!db) return;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(roomId);
    await transactionDone(transaction);
  });
}
