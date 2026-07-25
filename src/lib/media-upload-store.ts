"use client";

import { clearStorageIssue, reportStorageIssue } from "./storage-health";

export interface DurableMediaUpload {
  key: string;
  ownerId: string;
  roomId: string;
  clientId: string;
  /** Owning event outbox ID after bytes/media identity transfer to a send. */
  outboxClientId?: string;
  /** Verified replacement generation that made this source unreachable. */
  supersededBySourceClientId?: string;
  name: string;
  mime: string;
  kind: "image" | "file" | "voice";
  size: number;
  blob: Blob | null;
  sessionId: string | null;
  mediaId: string | null;
  /** "scanning" means object storage has the complete immutable payload but
   * Glass has not yet received a clean malware verdict. It is deliberately
   * distinct from completed so restart recovery cannot skip that boundary. */
  state: "staged" | "uploading" | "scanning" | "completed" | "failed" | "cleanup";
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = "silicon-interface-media-outbox";
const STORE = "uploads";
let database: Promise<IDBDatabase> | null = null;
const durabilityPending = new Set<string>();
const durabilityFailures = new Set<string>();
const activeTransfers = new Set<string>();

export function beginMediaDurability(ownerId: string, clientId: string): void {
  durabilityPending.add(mediaUploadKey(ownerId, clientId));
}

export function endMediaDurability(ownerId: string, clientId: string): void {
  durabilityPending.delete(mediaUploadKey(ownerId, clientId));
}

export function hasPendingMediaDurability(): boolean {
  return durabilityPending.size > 0;
}

export function markMediaDurabilityFailure(ownerId: string, clientId: string): void {
  durabilityFailures.add(mediaUploadKey(ownerId, clientId));
}

export function resolveMediaDurabilityFailure(ownerId: string, clientId: string): void {
  durabilityFailures.delete(mediaUploadKey(ownerId, clientId));
  if (durabilityFailures.size === 0) clearStorageIssue("media");
}

export function hasFailedMediaDurability(): boolean {
  return durabilityFailures.size > 0;
}

export function beginMediaTransfer(ownerId: string, clientId: string): void {
  activeTransfers.add(mediaUploadKey(ownerId, clientId));
}

export function endMediaTransfer(ownerId: string, clientId: string): void {
  activeTransfers.delete(mediaUploadKey(ownerId, clientId));
}

/** True for the complete network transfer, not just the short IndexedDB commit. */
export function hasActiveMediaTransfers(): boolean {
  return activeTransfers.size > 0;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !window.indexedDB) {
    reportStorageIssue({
      severity: "blocked",
      area: "media",
      message: "We can’t save this attachment in this browser. It’s still here and wasn’t sent.",
    });
    return Promise.reject(
      new Error("We can’t save this attachment in this browser. It’s still here and wasn’t sent."),
    );
  }
  if (database) return database;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "key" });
      if (!store.indexNames.contains("ownerRoom")) {
        store.createIndex("ownerRoom", ["ownerId", "roomId", "createdAt"]);
      }
      if (!store.indexNames.contains("owner")) store.createIndex("owner", "ownerId");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (database === opening) database = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      reportStorageIssue({
        severity: "blocked",
        area: "media",
        message: "We couldn’t save this attachment. It’s still here and wasn’t sent.",
      });
      reject(new Error("We couldn’t save this attachment. It’s still here and wasn’t sent."));
    };
    request.onblocked = () => {
      reportStorageIssue({
        severity: "blocked",
        area: "media",
        message: "Close any other Silicon Interface tabs, then try again. Your attachment is still here.",
      });
      reject(
        new Error("Close any other Silicon Interface tabs, then try again. Your attachment is still here."),
      );
    };
  });
  database = opening;
  void opening.catch(() => {
    if (database === opening) database = null;
  });
  return opening;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reportStorageIssue({
        severity: "blocked",
        area: "media",
        message: "We couldn’t save this attachment. It’s still here and wasn’t sent.",
      });
      reject(new Error("We couldn’t save this attachment. It’s still here and wasn’t sent."));
    };
    transaction.onabort = () => {
      reportStorageIssue({
        severity: "blocked",
        area: "media",
        message: "We couldn’t save this attachment. It’s still here and wasn’t sent.",
      });
      reject(new Error("We couldn’t save this attachment. It’s still here and wasn’t sent."));
    };
  });
}

export function mediaUploadKey(ownerId: string, clientId: string): string {
  return `${ownerId}:${clientId}`;
}

export async function stageMediaUpload(
  row: Omit<DurableMediaUpload, "key" | "state" | "sessionId" | "mediaId" | "createdAt" | "updatedAt">,
): Promise<DurableMediaUpload> {
  const db = await openDatabase();
  const now = Date.now();
  const stored: DurableMediaUpload = {
    ...row,
    key: mediaUploadKey(row.ownerId, row.clientId),
    state: "staged",
    sessionId: null,
    mediaId: null,
    createdAt: now,
    updatedAt: now,
  };
  const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
  transaction.objectStore(STORE).put(stored);
  await done(transaction);
  if (durabilityFailures.size === 0) clearStorageIssue("media");
  return stored;
}

/** Create the local cleanup/recovery row for a previously uploaded object.
 * The stable media identity is reusable inside its original room; no source
 * Blob or new multipart session is needed. */
export async function stageReusedMediaUpload(row: {
  ownerId: string;
  roomId: string;
  clientId: string;
  outboxClientId: string;
  name: string;
  mime: string;
  kind: "image" | "file";
  size: number;
  mediaId: string;
}): Promise<DurableMediaUpload> {
  if (!row.mediaId) throw new Error("reused media identity is missing");
  const db = await openDatabase();
  const now = Date.now();
  const stored: DurableMediaUpload = {
    ...row,
    key: mediaUploadKey(row.ownerId, row.clientId),
    blob: null,
    sessionId: null,
    state: "completed",
    createdAt: now,
    updatedAt: now,
  };
  const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
  transaction.objectStore(STORE).put(stored);
  await done(transaction);
  if (durabilityFailures.size === 0) clearStorageIssue("media");
  return stored;
}

export async function readMediaUpload(ownerId: string, clientId: string): Promise<DurableMediaUpload | null> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE, "readonly");
  const request = transaction.objectStore(STORE).get(mediaUploadKey(ownerId, clientId));
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as DurableMediaUpload | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function patchMediaUpload(
  ownerId: string,
  clientId: string,
  patch: Partial<DurableMediaUpload>,
): Promise<DurableMediaUpload> {
  const current = await readMediaUpload(ownerId, clientId);
  if (!current) throw new Error("durable media source is missing");
  const next = { ...current, ...patch, key: current.key, updatedAt: Date.now() };
  const db = await openDatabase();
  const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
  transaction.objectStore(STORE).put(next);
  await done(transaction);
  if (durabilityFailures.size === 0) clearStorageIssue("media");
  return next;
}

export async function listRoomMediaUploads(ownerId: string, roomId: string): Promise<DurableMediaUpload[]> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE, "readonly");
  const index = transaction.objectStore(STORE).index("ownerRoom");
  const range = IDBKeyRange.bound([ownerId, roomId, 0], [ownerId, roomId, Number.MAX_SAFE_INTEGER]);
  const request = index.getAll(range);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as DurableMediaUpload[]) ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function listOwnerMediaUploads(ownerId: string): Promise<DurableMediaUpload[]> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE, "readonly");
  const request = transaction.objectStore(STORE).index("owner").getAll(IDBKeyRange.only(ownerId));
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as DurableMediaUpload[]) ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function removeMediaUpload(ownerId: string, clientId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
  transaction.objectStore(STORE).delete(mediaUploadKey(ownerId, clientId));
  await done(transaction);
}

export async function clearMediaUploads(ownerId: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE, "readwrite");
  const index = transaction.objectStore(STORE).index("owner");
  const request = index.openKeyCursor(IDBKeyRange.only(ownerId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    transaction.objectStore(STORE).delete(cursor.primaryKey);
    cursor.continue();
  };
  await done(transaction);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const owner = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey;
    if (owner) {
      for (const key of durabilityPending) {
        if (key.startsWith(`${owner}:`)) durabilityPending.delete(key);
      }
      for (const key of durabilityFailures) {
        if (key.startsWith(`${owner}:`)) durabilityFailures.delete(key);
      }
      for (const key of activeTransfers) {
        if (key.startsWith(`${owner}:`)) activeTransfers.delete(key);
      }
      if (durabilityFailures.size === 0) clearStorageIssue("media");
      void clearMediaUploads(owner);
    }
  });
}
