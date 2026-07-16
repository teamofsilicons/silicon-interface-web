"use client";

const DB_NAME = "silicon-interface-draft-journal";
const STORE = "drafts";
let dbPromise: Promise<IDBDatabase> | null = null;
const writes = new Map<string, Promise<void>>();

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function journalDraft(
  owner: string,
  roomId: string,
  draft: Record<string, unknown> | null,
): Promise<void> {
  if (!owner || !roomId) return Promise.reject(new Error("draft owner and room are required"));
  if (typeof window.indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB draft journal is unavailable"));
  }
  const key = `${owner}:${roomId}`;
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const db = await openDb();
      const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(STORE);
      if (draft) store.put(draft, key);
      else store.delete(key);
      await done(transaction);
    })
    .finally(() => {
      if (writes.get(key) === next) writes.delete(key);
    });
  writes.set(key, next);
  return next;
}

export async function readDraftJournal(
  owner: string,
  roomId: string,
): Promise<Record<string, unknown> | null> {
  if (!owner || !roomId || typeof window.indexedDB === "undefined") return null;
  const key = `${owner}:${roomId}`;
  await writes.get(key)?.catch(() => undefined);
  const db = await openDb();
  const transaction = db.transaction(STORE, "readonly");
  return new Promise((resolve, reject) => {
    const request = transaction.objectStore(STORE).get(key);
    request.onsuccess = () =>
      resolve(
        request.result && typeof request.result === "object"
          ? (request.result as Record<string, unknown>)
          : null,
      );
    request.onerror = () => reject(request.error);
  });
}

export async function listDraftJournalRoomIds(owner: string): Promise<string[]> {
  if (!owner || typeof window.indexedDB === "undefined") return [];
  await Promise.all([...writes.values()].map((write) => write.catch(() => undefined)));
  const db = await openDb();
  const transaction = db.transaction(STORE, "readonly");
  const prefix = `${owner}:`;
  return new Promise<string[]>((resolve, reject) => {
    const roomIds: string[] = [];
    const request = transaction.objectStore(STORE).openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(roomIds);
        return;
      }
      if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
        roomIds.push(cursor.key.slice(prefix.length));
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
