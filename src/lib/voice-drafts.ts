// IndexedDB-only storage for protected voice drafts. Audio bytes never touch
// localStorage/sessionStorage; keys are random draft ids + sequence numbers.

export type VoiceDraftStatus = "recording" | "draft" | "sending" | "failed";

export interface VoiceDraftMeta {
  draftId: string;
  ownerKey: string;
  roomId: string;
  replyToEventId?: string;
  mime: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  bytes: number;
  chunkCount: number;
  status: VoiceDraftStatus;
  error?: string;
}

const DB_NAME = "silicon-interface-voice-drafts";
const DB_VERSION = 1;
const META = "meta";
const CHUNKS = "chunks";
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

type ChunkRecord = { key: string; draftId: string; seq: number; blob: Blob; bytes: number; createdAt: number };

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openVoiceDraftDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: "draftId" });
        meta.createIndex("ownerKey", "ownerKey", { unique: false });
        meta.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const chunks = db.createObjectStore(CHUNKS, { keyPath: "key" });
        chunks.createIndex("draftId", "draftId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

export function newVoiceDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `vd_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export async function putVoiceMeta(meta: VoiceDraftMeta): Promise<void> {
  const db = await openVoiceDraftDb();
  const tx = db.transaction(META, "readwrite");
  tx.objectStore(META).put(meta);
  await txDone(tx);
}

export async function getVoiceMeta(draftId: string): Promise<VoiceDraftMeta | undefined> {
  const db = await openVoiceDraftDb();
  const tx = db.transaction(META, "readonly");
  return req(tx.objectStore(META).get(draftId) as IDBRequest<VoiceDraftMeta | undefined>);
}

export async function listVoiceMetas(ownerKey: string): Promise<VoiceDraftMeta[]> {
  const db = await openVoiceDraftDb();
  const tx = db.transaction(META, "readonly");
  const idx = tx.objectStore(META).index("ownerKey");
  return req(idx.getAll(ownerKey) as IDBRequest<VoiceDraftMeta[]>);
}

export async function appendVoiceChunk(draftId: string, seq: number, blob: Blob): Promise<void> {
  const db = await openVoiceDraftDb();
  const tx = db.transaction(CHUNKS, "readwrite");
  const rec: ChunkRecord = {
    key: `${draftId}:${String(seq).padStart(8, "0")}`,
    draftId,
    seq,
    blob,
    bytes: blob.size,
    createdAt: Date.now(),
  };
  tx.objectStore(CHUNKS).put(rec);
  await txDone(tx);
}

export async function readVoiceChunks(draftId: string): Promise<Blob[]> {
  const db = await openVoiceDraftDb();
  const tx = db.transaction(CHUNKS, "readonly");
  const idx = tx.objectStore(CHUNKS).index("draftId");
  const rows = await req(idx.getAll(draftId) as IDBRequest<ChunkRecord[]>);
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.blob);
}

export async function deleteVoiceDraft(draftId: string): Promise<void> {
  const db = await openVoiceDraftDb();
  const readTx = db.transaction(CHUNKS, "readonly");
  const keys = await req(readTx.objectStore(CHUNKS).index("draftId").getAllKeys(draftId));
  await txDone(readTx);
  const tx = db.transaction([META, CHUNKS], "readwrite");
  tx.objectStore(META).delete(draftId);
  for (const key of keys) tx.objectStore(CHUNKS).delete(key);
  await txDone(tx);
}

export async function deleteVoiceDraftsForOwner(ownerKey: string): Promise<void> {
  const metas = await listVoiceMetas(ownerKey).catch(() => []);
  await Promise.all(metas.map((m) => deleteVoiceDraft(m.draftId)));
}

export async function clearAllVoiceDrafts(): Promise<void> {
  const db = await openVoiceDraftDb();
  const tx = db.transaction([META, CHUNKS], "readwrite");
  tx.objectStore(META).clear();
  tx.objectStore(CHUNKS).clear();
  await txDone(tx);
}

export async function cleanupStaleVoiceDrafts(ownerKey: string, now = Date.now()): Promise<void> {
  const metas = await listVoiceMetas(ownerKey).catch(() => []);
  await Promise.all(
    metas.filter((m) => now - m.updatedAt > STALE_MS).map((m) => deleteVoiceDraft(m.draftId)),
  );
}
