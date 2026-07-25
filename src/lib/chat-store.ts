"use client";

import type { AccountSyncUpdate, ClientOperationStatus, DraftState, Event, HeldSend, Room, StreamVectorPosition } from "./types";
import type {
  SyncIntegrityDetails,
  SyncIntegrityReason,
  SyncStream,
} from "./sync-integrity";
import {
  isNonBlankString,
  streamVectorBeforeOrEqual,
  streamVectorEqual,
  SUPPORTED_ACCOUNT_SYNC_KINDS,
  validateStreamVectorPosition,
  validateInitialAccountManifest,
  validateInitialRoomNotificationProjection,
} from "./sync-integrity";
import { clearStorageIssue, reportStorageIssue } from "./storage-health";
import { decorateAuthoritativeTimelineEvent } from "./timeline-identity";
import { mergeDeliverySummaries } from "./delivery-state";
import { mergeEventRevision } from "./event-revision";

const DB_NAME = "silicon-interface-chat-cache";
// v8 shipped in pre-release/dev builds. Never request an older IndexedDB
// version: browsers reject that before any recovery code can run. v9 also
// guarantees the compatibility store exists for those profiles.
const DB_VERSION = 9;
const EVENTS = "events";
const SYNC_CHECKPOINTS = "syncCheckpoints";
const SYNC_RECOVERY = "syncRecovery";
const PENDING_ACCOUNT_REPLAY = "pendingAccountReplay";
const ACCOUNT_PROJECTIONS = "accountProjections";
const INITIAL_SYNC_BUNDLES = "initialSyncBundles";
const OWNER_ROOM_TIMELINE = "ownerRoomTimeline";
const DELIVERY_ACKS = "deliveryAcks";
const DELIVERY_ACK_OWNER = "ownerId";

export interface SyncCursors {
  event: string;
  account: string;
}

export interface SyncCheckpoint extends SyncCursors {
  eventPosition: number;
  eventVector?: StreamVectorPosition;
  accountPosition: number;
}

export interface SyncRecoveryRecord {
  ownerId: string;
  phase: "degraded" | "rebuilding" | "recovered";
  reason: SyncIntegrityReason;
  stream: SyncStream;
  details: SyncIntegrityDetails;
  detectedAt: number;
  updatedAt: number;
  recoveredAt: number | null;
  occurrences: number;
  revision: number;
}

export interface PendingAccountReplay {
  ownerId: string;
  fromPosition: number;
  nextPosition: number;
  throughPosition: number;
  updates: AccountSyncUpdate[];
  eventPage: null | {
    cursor: string;
    fromPosition: number;
    nextPosition: number;
    fromVector?: StreamVectorPosition;
    nextVector?: StreamVectorPosition;
    eventIds: string[];
  };
  committedAt: number;
}

interface AccountProjectionLedger {
  ownerId: string;
  updates: AccountSyncUpdate[];
  lastPosition: number;
  updatedAt: number;
}

export interface InitialSyncAccountData {
  drafts: DraftState[];
  held_sends: HeldSend[];
  operations: ClientOperationStatus[];
  chat_preferences: { read_receipts_enabled: boolean };
  devices: Array<Record<string, unknown>>;
  blocks: Array<Record<string, unknown>>;
}

export interface InitialSyncBundle {
  ownerId: string;
  rooms: Room[];
  accountData: InitialSyncAccountData;
  checkpoint: SyncCheckpoint;
  completedAt: number;
}

export interface TimelineCachePruneResult {
  reason: "pruned" | "offline" | "not_pressured" | "unavailable";
  deleted: number;
  retained: number;
}

export interface ChatCacheRebuildResult {
  deletedEvents: number;
}

interface StoredEvent {
  key: string;
  ownerId: string;
  roomId: string;
  eventId: string;
  createdAt: string;
  event: Event;
  storedAt: number;
}

interface PendingDeliveryAcknowledgement {
  key: string;
  ownerId: string;
  eventId: string;
  queuedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const finish = (db: IDBDatabase) => {
      const requiredStores = [
        EVENTS,
        SYNC_CHECKPOINTS,
        SYNC_RECOVERY,
        PENDING_ACCOUNT_REPLAY,
        ACCOUNT_PROJECTIONS,
        INITIAL_SYNC_BUNDLES,
        DELIVERY_ACKS,
      ];
      if (requiredStores.some((store) => !db.objectStoreNames.contains(store))) {
        db.close();
        fail(new Error("Chat cache schema is incomplete"));
        return;
      }
      db.addEventListener("versionchange", () => {
        db.close();
        dbPromise = null;
      });
      clearStorageIssue("timeline");
      resolve(db);
    };
    const fail = (error: unknown) => {
      dbPromise = null;
      reportStorageIssue({
        severity: "degraded",
        area: "timeline",
        message: "We couldn’t load saved chat history on this device. Your messages are still safe and will reconnect.",
      });
      reject(error);
    };
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (upgradeEvent) => {
      const db = request.result;
      const store = db.objectStoreNames.contains(EVENTS)
        ? request.transaction!.objectStore(EVENTS)
        : db.createObjectStore(EVENTS, { keyPath: "key" });
      if (!store.indexNames.contains(OWNER_ROOM_TIMELINE)) {
        store.createIndex(OWNER_ROOM_TIMELINE, [
          "ownerId",
          "roomId",
          "createdAt",
          "eventId",
        ]);
      }
      if (!store.indexNames.contains("storedAt")) {
        store.createIndex("storedAt", "storedAt");
      }
      // v1 sorted the room cache by event ID. Backfill an explicit timestamp
      // during the upgrade so pre-existing offline history remains readable in
      // chronological order rather than disappearing from the new index.
      if (upgradeEvent.oldVersion < 2) {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const row = cursor.value as StoredEvent;
          if (!row.createdAt) {
            row.createdAt = row.event.created_at;
            cursor.update(row);
          }
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains(SYNC_CHECKPOINTS)) {
        db.createObjectStore(SYNC_CHECKPOINTS, { keyPath: "ownerId" });
      }
      if (!db.objectStoreNames.contains(SYNC_RECOVERY)) {
        db.createObjectStore(SYNC_RECOVERY, { keyPath: "ownerId" });
      }
      if (!db.objectStoreNames.contains(PENDING_ACCOUNT_REPLAY)) {
        db.createObjectStore(PENDING_ACCOUNT_REPLAY, { keyPath: "ownerId" });
      }
      if (!db.objectStoreNames.contains(ACCOUNT_PROJECTIONS)) {
        db.createObjectStore(ACCOUNT_PROJECTIONS, { keyPath: "ownerId" });
      }
      if (!db.objectStoreNames.contains(INITIAL_SYNC_BUNDLES)) {
        db.createObjectStore(INITIAL_SYNC_BUNDLES, { keyPath: "ownerId" });
      }
      if (!db.objectStoreNames.contains(DELIVERY_ACKS)) {
        const acknowledgements = db.createObjectStore(DELIVERY_ACKS, { keyPath: "key" });
        acknowledgements.createIndex(DELIVERY_ACK_OWNER, "ownerId");
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => {
      if (request.error?.name === "VersionError") {
        // Another tab or a newer app may already have upgraded this cache.
        // Open its current version and use it only after verifying every store
        // this build needs. This preserves history instead of deleting data or
        // trapping the user in a repeated version warning.
        const compatible = window.indexedDB.open(DB_NAME);
        compatible.onsuccess = () => finish(compatible.result);
        compatible.onerror = () => fail(compatible.error);
        return;
      }
      fail(request.error);
    };
  });
  return dbPromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function abortTransactionOnSignal(
  transaction: IDBTransaction,
  signal?: AbortSignal,
): void {
  if (!signal) return;
  if (signal.aborted) {
    transaction.abort();
    throw new DOMException("Sync generation was superseded", "AbortError");
  }
  const abort = () => {
    try { transaction.abort(); } catch { /* transaction already settled */ }
  };
  const cleanup = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  transaction.addEventListener("complete", cleanup, { once: true });
  transaction.addEventListener("abort", cleanup, { once: true });
  transaction.addEventListener("error", cleanup, { once: true });
}

function sanitizedPendingAccountReplay(
  ownerId: string,
  value: Omit<PendingAccountReplay, "ownerId" | "committedAt">,
  committedAt: number,
): PendingAccountReplay {
  if (
    !Number.isSafeInteger(value.fromPosition) || value.fromPosition < 0 ||
    !Number.isSafeInteger(value.nextPosition) || value.nextPosition < value.fromPosition ||
    !Number.isSafeInteger(value.throughPosition) || value.throughPosition < value.nextPosition ||
    !Array.isArray(value.updates) || value.updates.length > 500
  ) {
    throw new Error("Invalid pending account replay range");
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(value.updates);
  } catch {
    throw new Error("Pending account replay is not serializable");
  }
  if (serialized.length > 2_000_000) {
    throw new Error("Pending account replay exceeds its storage bound");
  }
  const updates = JSON.parse(serialized) as AccountSyncUpdate[];
  if (
    updates.length !== value.updates.length ||
    updates.some((update, index) =>
      !update ||
      !Number.isSafeInteger(update.position) ||
      update.position !== value.fromPosition + index + 1 ||
      update.position > value.nextPosition ||
      typeof update.kind !== "string" || !update.kind ||
      typeof update.room_id !== "string" ||
      typeof update.object_id !== "string" ||
      !update.data || typeof update.data !== "object" || Array.isArray(update.data)
    ) ||
    (updates.length > 0 && updates[updates.length - 1].position !== value.nextPosition) ||
    (updates.length === 0 && value.fromPosition !== value.nextPosition)
  ) {
    throw new Error("Pending account replay is discontinuous or malformed");
  }
  let eventPage: PendingAccountReplay["eventPage"] = null;
  if (value.eventPage) {
    const page = value.eventPage;
    if (
      !isNonBlankString(page.cursor) ||
      !Number.isSafeInteger(page.fromPosition) || page.fromPosition < 0 ||
      !Number.isSafeInteger(page.nextPosition) || page.nextPosition < page.fromPosition ||
      Boolean(page.fromVector) !== Boolean(page.nextVector) ||
      (page.fromVector && validateStreamVectorPosition(page.fromVector).floor !== page.fromPosition) ||
      (page.nextVector && validateStreamVectorPosition(page.nextVector).floor !== page.nextPosition) ||
      !Array.isArray(page.eventIds) || page.eventIds.length > 500 ||
      page.eventIds.some((eventId) => typeof eventId !== "string" || eventId.length !== 26)
    ) {
      throw new Error("Pending account replay has invalid event-page metadata");
    }
    eventPage = {
      cursor: page.cursor,
      fromPosition: page.fromPosition,
      nextPosition: page.nextPosition,
      fromVector: page.fromVector
        ? validateStreamVectorPosition(page.fromVector)
        : undefined,
      nextVector: page.nextVector
        ? validateStreamVectorPosition(page.nextVector)
        : undefined,
      eventIds: [...page.eventIds],
    };
  }
  return {
    ownerId,
    fromPosition: value.fromPosition,
    nextPosition: value.nextPosition,
    throughPosition: value.throughPosition,
    updates,
    eventPage,
    committedAt,
  };
}

/** Commit events before acknowledging delivery to Glass. */
export async function storeEvents(
  ownerId: string,
  rows: Array<{ roomId: string; event: Event }>,
  checkpoint?: SyncCursors | SyncCheckpoint,
  pendingAccountReplay?: Omit<PendingAccountReplay, "ownerId" | "committedAt">,
  signal?: AbortSignal,
  expectedCheckpoint?: SyncCheckpoint,
): Promise<void> {
  if (!ownerId || (rows.length === 0 && !checkpoint && !pendingAccountReplay)) return;
  if (pendingAccountReplay && !checkpoint) {
    throw new Error("Account replay requires an atomic sync checkpoint");
  }
  if (
    pendingAccountReplay &&
    (!("accountPosition" in checkpoint!) ||
      checkpoint.accountPosition !== pendingAccountReplay.nextPosition)
  ) {
    throw new Error("Account replay does not match its sync checkpoint");
  }
  if (
    pendingAccountReplay?.eventPage &&
    (!("eventPosition" in checkpoint!) ||
      checkpoint.eventPosition !== pendingAccountReplay.eventPage.nextPosition ||
      !streamVectorEqual(
        checkpoint.eventVector,
        pendingAccountReplay.eventPage.nextVector,
      ) ||
      checkpoint.event !== pendingAccountReplay.eventPage.cursor)
  ) {
    throw new Error("Account replay event metadata does not match its checkpoint");
  }
  if (checkpoint) {
    const hasEventPosition = "eventPosition" in checkpoint;
    const hasAccountPosition = "accountPosition" in checkpoint;
    if (!isNonBlankString(checkpoint.event) || !isNonBlankString(checkpoint.account)) {
      throw new Error("Both signed sync cursors are required");
    }
    if (
      hasEventPosition !== hasAccountPosition ||
      (hasEventPosition &&
        (!Number.isSafeInteger(checkpoint.eventPosition) || checkpoint.eventPosition < 0 ||
          !Number.isSafeInteger(checkpoint.accountPosition) || checkpoint.accountPosition < 0))
    ) {
      throw new Error("Both numeric sync positions are required");
    }
    if (
      hasEventPosition && checkpoint.eventVector &&
      validateStreamVectorPosition(checkpoint.eventVector).floor !== checkpoint.eventPosition
    ) {
      throw new Error("Event vector does not match its compatibility position");
    }
  }
  const storedAt = Date.now();
  const preparedRows = rows.map((row) => {
    const event = decorateAuthoritativeTimelineEvent(ownerId, row.event);
    return {
      key: `${ownerId}:${event.event_id}`,
      ownerId,
      roomId: row.roomId,
      eventId: event.event_id,
      createdAt: event.created_at,
      event,
      storedAt,
    } satisfies StoredEvent;
  });
  const preparedReplay = pendingAccountReplay
    ? sanitizedPendingAccountReplay(ownerId, pendingAccountReplay, storedAt)
    : null;
  if (typeof window.indexedDB === "undefined") throw new Error("IndexedDB unavailable");
  const db = await openDb();
  const storeNames = [EVENTS, DELIVERY_ACKS];
  if (checkpoint) storeNames.push(SYNC_CHECKPOINTS, PENDING_ACCOUNT_REPLAY);
  const transaction = db.transaction(
    storeNames,
    "readwrite",
    { durability: "strict" },
  );
  abortTransactionOnSignal(transaction, signal);
  let existingReplay: PendingAccountReplay | null = null;
  if (checkpoint) {
    const [currentCheckpoint, replay] = await Promise.all([
      new Promise<Partial<SyncCheckpoint> | null>((resolve, reject) => {
        const request = transaction.objectStore(SYNC_CHECKPOINTS).get(ownerId);
        request.onsuccess = () =>
          resolve((request.result as Partial<SyncCheckpoint> | undefined) ?? null);
        request.onerror = () => reject(request.error);
      }),
      new Promise<PendingAccountReplay | null>((resolve, reject) => {
        const request = transaction.objectStore(PENDING_ACCOUNT_REPLAY).get(ownerId);
        request.onsuccess = () =>
          resolve((request.result as PendingAccountReplay | undefined) ?? null);
        request.onerror = () => reject(request.error);
      }),
    ]);
    existingReplay = replay;
    if (
      expectedCheckpoint &&
      (!currentCheckpoint ||
        currentCheckpoint.event !== expectedCheckpoint.event ||
        currentCheckpoint.account !== expectedCheckpoint.account ||
        currentCheckpoint.eventPosition !== expectedCheckpoint.eventPosition ||
        !streamVectorEqual(currentCheckpoint.eventVector, expectedCheckpoint.eventVector) ||
        currentCheckpoint.accountPosition !== expectedCheckpoint.accountPosition)
    ) {
      transaction.abort();
      throw new Error("Sync checkpoint changed concurrently");
    }
    if (!pendingAccountReplay && existingReplay) {
      transaction.abort();
      throw new Error("Account replay must finish before a newer checkpoint");
    }
    if (
      preparedReplay &&
      existingReplay &&
      JSON.stringify({ ...existingReplay, committedAt: 0 }) !==
        JSON.stringify({ ...preparedReplay, committedAt: 0 })
    ) {
      transaction.abort();
      throw new Error("A different account replay is still pending");
    }
  }
  const store = transaction.objectStore(EVENTS);
  const existingRows = await Promise.all(preparedRows.map((row) =>
    new Promise<StoredEvent | null>((resolve, reject) => {
      const request = store.get(row.key);
      request.onsuccess = () => resolve((request.result as StoredEvent | undefined) ?? null);
      request.onerror = () => reject(request.error);
    })
  ));
  const deliveryStore = transaction.objectStore(DELIVERY_ACKS);
  for (const [index, prepared] of preparedRows.entries()) {
    const previous = existingRows[index];
    const event = previous
      ? mergeEventRevision(previous.event, prepared.event)
      : prepared.event;
    const row: StoredEvent = { ...prepared, event };
    store.put(row);
    deliveryStore.put({
      key: `${ownerId}:${row.eventId}`,
      ownerId,
      eventId: row.eventId,
      queuedAt: storedAt,
    } satisfies PendingDeliveryAcknowledgement);
  }
  if (checkpoint) {
    const hasEventPosition = "eventPosition" in checkpoint;
    const hasAccountPosition = "accountPosition" in checkpoint;
    transaction.objectStore(SYNC_CHECKPOINTS).put({
      ownerId,
      event: checkpoint.event,
      account: checkpoint.account,
      eventPosition:
        hasEventPosition ? checkpoint.eventPosition : undefined,
      eventVector:
        hasEventPosition && checkpoint.eventVector
          ? validateStreamVectorPosition(checkpoint.eventVector)
          : undefined,
      accountPosition:
        hasAccountPosition ? checkpoint.accountPosition : undefined,
      updatedAt: storedAt,
    });
    if (preparedReplay) {
      transaction.objectStore(PENDING_ACCOUNT_REPLAY).put(existingReplay ?? preparedReplay);
    }
  }
  await transactionDone(transaction);
}

export async function readSyncCheckpoint(ownerId: string): Promise<SyncCheckpoint | null> {
  if (!ownerId || typeof window.indexedDB === "undefined") return null;
  const db = await openDb();
  const transaction = db.transaction(SYNC_CHECKPOINTS, "readonly");
  const row = await new Promise<Partial<SyncCheckpoint> | undefined>((resolve, reject) => {
    const request = transaction.objectStore(SYNC_CHECKPOINTS).get(ownerId);
    request.onsuccess = () => resolve(request.result as Partial<SyncCheckpoint> | undefined);
    request.onerror = () => reject(request.error);
  });
  if (!(row && isNonBlankString(row.event) &&
    isNonBlankString(row.account) &&
    Number.isSafeInteger(row.eventPosition) && Number(row.eventPosition) >= 0 &&
    Number.isSafeInteger(row.accountPosition) && Number(row.accountPosition) >= 0)) {
    return null;
  }
  const eventVector = row.eventVector
    ? validateStreamVectorPosition(row.eventVector)
    : undefined;
  if (eventVector && eventVector.floor !== Number(row.eventPosition)) return null;
  return {
    event: row.event,
    account: row.account,
    eventPosition: Number(row.eventPosition),
    ...(eventVector ? { eventVector } : {}),
    accountPosition: Number(row.accountPosition),
  };
}

export async function readSyncCursors(ownerId: string): Promise<SyncCursors | null> {
  if (!ownerId || typeof window.indexedDB === "undefined") return null;
  const db = await openDb();
  const transaction = db.transaction(SYNC_CHECKPOINTS, "readonly");
  const row = await new Promise<Partial<SyncCursors> | undefined>((resolve, reject) => {
    const request = transaction.objectStore(SYNC_CHECKPOINTS).get(ownerId);
    request.onsuccess = () => resolve(request.result as Partial<SyncCursors> | undefined);
    request.onerror = () => reject(request.error);
  });
  return row && isNonBlankString(row.event) &&
    isNonBlankString(row.account)
    ? { event: row.event, account: row.account }
    : null;
}

export async function writeSyncCursors(
  ownerId: string,
  cursors: SyncCursors,
): Promise<void> {
  await storeEvents(ownerId, [], cursors);
}

export async function writeSyncCheckpoint(
  ownerId: string,
  checkpoint: SyncCheckpoint,
): Promise<void> {
  if (
    !Number.isSafeInteger(checkpoint.eventPosition) || checkpoint.eventPosition < 0 ||
    !Number.isSafeInteger(checkpoint.accountPosition) || checkpoint.accountPosition < 0
  ) {
    throw new Error("Both numeric sync positions are required");
  }
  if (
    checkpoint.eventVector &&
    validateStreamVectorPosition(checkpoint.eventVector).floor !== checkpoint.eventPosition
  ) {
    throw new Error("Event vector does not match its compatibility position");
  }
  await storeEvents(ownerId, [], checkpoint);
}

/** Delivery is acknowledged only after the event is durably stored. Pending
 * rows survive reloads and are deleted only after Glass accepts the batch. */
export async function pendingDeliveryAcknowledgements(
  ownerId: string,
  limit = 500,
): Promise<string[]> {
  if (!ownerId || typeof window.indexedDB === "undefined") return [];
  const db = await openDb();
  const transaction = db.transaction(DELIVERY_ACKS, "readonly");
  const index = transaction.objectStore(DELIVERY_ACKS).index(DELIVERY_ACK_OWNER);
  const eventIds: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(ownerId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || eventIds.length >= Math.max(1, Math.min(500, limit))) {
        resolve();
        return;
      }
      const row = cursor.value as PendingDeliveryAcknowledgement;
      if (row.ownerId === ownerId && typeof row.eventId === "string" && row.eventId) {
        eventIds.push(row.eventId);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return eventIds;
}

export async function completeDeliveryAcknowledgements(
  ownerId: string,
  eventIds: readonly string[],
): Promise<void> {
  if (!ownerId || !eventIds.length || typeof window.indexedDB === "undefined") return;
  const db = await openDb();
  const transaction = db.transaction(DELIVERY_ACKS, "readwrite", { durability: "strict" });
  const store = transaction.objectStore(DELIVERY_ACKS);
  for (const eventId of new Set(eventIds)) store.delete(`${ownerId}:${eventId}`);
  await transactionDone(transaction);
}

export async function updateStoredEventDeliveries(
  ownerId: string,
  deliveries: Record<string, NonNullable<Event["delivery"]>>,
): Promise<void> {
  if (!ownerId || typeof window.indexedDB === "undefined") return;
  const entries = Object.entries(deliveries).slice(0, 500);
  if (!entries.length) return;
  const db = await openDb();
  const transaction = db.transaction(EVENTS, "readwrite", { durability: "strict" });
  const store = transaction.objectStore(EVENTS);
  await Promise.all(entries.map(([eventId, incoming]) =>
    new Promise<void>((resolve, reject) => {
      const request = store.get(`${ownerId}:${eventId}`);
      request.onsuccess = () => {
        const row = (request.result as StoredEvent | undefined) ?? null;
        if (row) {
          const delivery = mergeDeliverySummaries(row.event.delivery, incoming);
          if (delivery) store.put({ ...row, event: { ...row.event, delivery } });
        }
        resolve();
      };
      request.onerror = () => reject(request.error);
    })
  ));
  await transactionDone(transaction);
}

export async function deleteSyncCursors(ownerId: string, signal?: AbortSignal): Promise<void> {
  if (!ownerId || typeof window.indexedDB === "undefined") return;
  const db = await openDb();
  const transaction = db.transaction(SYNC_CHECKPOINTS, "readwrite", {
    durability: "strict",
  });
  abortTransactionOnSignal(transaction, signal);
  transaction.objectStore(SYNC_CHECKPOINTS).delete(ownerId);
  await transactionDone(transaction);
}

export async function readPendingAccountReplay(
  ownerId: string,
): Promise<PendingAccountReplay | null> {
  if (!ownerId || typeof window.indexedDB === "undefined") return null;
  const db = await openDb();
  const transaction = db.transaction([PENDING_ACCOUNT_REPLAY, EVENTS], "readonly");
  const raw = await new Promise<PendingAccountReplay | null>((resolve, reject) => {
    const request = transaction.objectStore(PENDING_ACCOUNT_REPLAY).get(ownerId);
    request.onsuccess = () => resolve((request.result as PendingAccountReplay | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!raw) return null;
  if (raw.ownerId !== ownerId) throw new Error("Pending account replay owner mismatch");
  const sanitized = sanitizedPendingAccountReplay(ownerId, {
    fromPosition: raw.fromPosition,
    nextPosition: raw.nextPosition,
    throughPosition: raw.throughPosition,
    updates: raw.updates,
    eventPage: raw.eventPage,
  }, raw.committedAt);
  if (sanitized.eventPage?.eventIds.length) {
    const eventStore = transaction.objectStore(EVENTS);
    const rows = await Promise.all(sanitized.eventPage.eventIds.map((eventId) =>
      new Promise<StoredEvent | null>((resolve, reject) => {
        const request = eventStore.get(`${ownerId}:${eventId}`);
        request.onsuccess = () => resolve((request.result as StoredEvent | undefined) ?? null);
        request.onerror = () => reject(request.error);
      })
    ));
    if (rows.some((row) => !row)) {
      throw new Error("Pending account replay references an incomplete event commit");
    }
  }
  return sanitized;
}

export async function clearPendingAccountReplay(
  ownerId: string,
  nextPosition: number,
  signal?: AbortSignal,
): Promise<"cleared" | "absent" | "mismatch"> {
  if (!ownerId || typeof window.indexedDB === "undefined") return "mismatch";
  const db = await openDb();
  const transaction = db.transaction(PENDING_ACCOUNT_REPLAY, "readwrite", {
    durability: "strict",
  });
  abortTransactionOnSignal(transaction, signal);
  const store = transaction.objectStore(PENDING_ACCOUNT_REPLAY);
  const existing = await new Promise<PendingAccountReplay | null>((resolve, reject) => {
    const request = store.get(ownerId);
    request.onsuccess = () => resolve((request.result as PendingAccountReplay | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!existing) {
    await transactionDone(transaction);
    return "absent";
  }
  if (existing.nextPosition !== nextPosition) {
    await transactionDone(transaction);
    return "mismatch";
  }
  store.delete(ownerId);
  await transactionDone(transaction);
  return "cleared";
}

function accountProjectionKey(update: AccountSyncUpdate): string {
  if (update.kind === "draft") return `draft:${update.room_id}`;
  if (update.kind === "held_send") return `held:${update.object_id}`;
  if (update.kind === "read_receipt") {
    return `read:${update.room_id}:${update.object_id}`;
  }
  if (update.kind === "thread.read_receipt") {
    return `thread.read:${update.room_id}:${update.object_id}`;
  }
  if (update.kind === "delivery_receipt") {
    return `delivery:${update.room_id}:${String(update.data.member_kind ?? "")}:${String(update.data.member_id ?? "")}`;
  }
  if (update.kind === "room.upsert" || update.kind === "room.remove") {
    return `room:${update.room_id}`;
  }
  if (update.kind === "room.notifications") return `room.notifications:${update.room_id}`;
  if (update.kind === "room.list_preferences") return `room.list_preferences:${update.room_id}`;
  if (update.kind === "client.operation") return `client.operation:${update.object_id}`;
  if (update.kind === "extend.request") return `extend.request:${update.object_id}`;
  return `${update.kind}:${update.object_id}`;
}

function initialAccountProjectionUpdates(
  accountData: InitialSyncAccountData,
  position: number,
): AccountSyncUpdate[] {
  const updates: AccountSyncUpdate[] = [];
  updates.push({
    position,
    kind: "chat.preferences",
    room_id: "",
    object_id: "chat.preferences",
    data: accountData.chat_preferences,
    created_at: "",
  });
  for (const draft of accountData.drafts) {
    updates.push({
      position,
      kind: "draft",
      room_id: draft.room_id,
      object_id: draft.room_id,
      data: draft as unknown as Record<string, unknown>,
      created_at: draft.updated_at,
    });
  }
  for (const held of accountData.held_sends) {
    updates.push({
      position,
      kind: "held_send",
      room_id: held.room_id,
      object_id: held.held_send_id,
      data: held as unknown as Record<string, unknown>,
      created_at: held.updated_at || held.created_at,
    });
  }
  for (const operation of accountData.operations) {
    updates.push({
      position,
      kind: "client.operation",
      room_id: operation.room_id,
      object_id: operation.operation_id,
      data: operation as unknown as Record<string, unknown>,
      created_at: operation.terminal_at || operation.accepted_at,
    });
  }
  for (const device of accountData.devices) {
    const deviceId = typeof device.device_id === "string" ? device.device_id : "";
    if (!deviceId) continue;
    updates.push({
      position,
      kind: "device",
      room_id: "",
      object_id: deviceId,
      data: device,
      created_at: typeof device.last_seen_at === "string" ? device.last_seen_at : "",
    });
  }
  for (const block of accountData.blocks) {
    const targetKind = typeof block.target_kind === "string" ? block.target_kind : "";
    const targetId = typeof block.target_id === "string" ? block.target_id : "";
    if (!targetKind || !targetId) continue;
    updates.push({
      position,
      kind: "moderation.block",
      room_id: "",
      object_id: `${targetKind}:${targetId}`,
      data: { action: "block", ...block },
      created_at: typeof block.created_at === "string" ? block.created_at : "",
    });
  }
  return updates;
}

/** Commit a complete initial projection as one crash-atomic bundle. UI state
 * swaps only after this transaction succeeds. */
export async function commitInitialSyncBundle(
  ownerId: string,
  input: {
    rooms: Room[];
    accountData: InitialSyncAccountData;
    events: Array<{ roomId: string; event: Event }>;
    checkpoint: SyncCheckpoint;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (!ownerId || typeof window.indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable");
  }
  if (
    !isNonBlankString(input.checkpoint.event) ||
    !isNonBlankString(input.checkpoint.account) ||
    !Number.isSafeInteger(input.checkpoint.eventPosition) || input.checkpoint.eventPosition < 0 ||
    (input.checkpoint.eventVector != null &&
      validateStreamVectorPosition(input.checkpoint.eventVector).floor !== input.checkpoint.eventPosition) ||
    !Number.isSafeInteger(input.checkpoint.accountPosition) || input.checkpoint.accountPosition < 0 ||
    !Array.isArray(input.rooms) || !Array.isArray(input.events)
  ) {
    throw new Error("Initial sync bundle is incomplete");
  }
  validateInitialAccountManifest(input.accountData);
  for (const room of input.rooms) validateInitialRoomNotificationProjection(room);
  let cloned: { rooms: Room[]; accountData: InitialSyncAccountData };
  try {
    const serialized = JSON.stringify({ rooms: input.rooms, accountData: input.accountData });
    if (serialized.length > 50_000_000) throw new Error("Initial sync bundle is too large");
    cloned = JSON.parse(serialized) as typeof cloned;
  } catch (error) {
    throw error instanceof Error ? error : new Error("Initial sync bundle is not serializable");
  }
  validateInitialAccountManifest(cloned.accountData);
  for (const room of cloned.rooms) validateInitialRoomNotificationProjection(room);
  const storedAt = Date.now();
  const preparedRows = input.events.map((row) => {
    const event = decorateAuthoritativeTimelineEvent(ownerId, row.event);
    return {
      key: `${ownerId}:${event.event_id}`,
      ownerId,
      roomId: row.roomId,
      eventId: event.event_id,
      createdAt: event.created_at,
      event,
      storedAt,
    } satisfies StoredEvent;
  });
  const seed = initialAccountProjectionUpdates(
    cloned.accountData,
    input.checkpoint.accountPosition,
  );
  for (const room of cloned.rooms) {
    if (room.notification_preferences) {
      seed.push({
        position: input.checkpoint.accountPosition,
        kind: "room.notifications",
        room_id: room.room_id,
        object_id: room.room_id,
        data: {
          room_id: room.room_id,
          preferences: room.notification_preferences,
        },
        created_at: room.updated_at,
      });
    }
  }
  const latest = new Map<string, AccountSyncUpdate>();
  for (const update of seed) latest.set(accountProjectionKey(update), update);
  const db = await openDb();
  const transaction = db.transaction(
    [
      EVENTS,
      SYNC_CHECKPOINTS,
      PENDING_ACCOUNT_REPLAY,
      ACCOUNT_PROJECTIONS,
      INITIAL_SYNC_BUNDLES,
      DELIVERY_ACKS,
    ],
    "readwrite",
    { durability: "strict" },
  );
  abortTransactionOnSignal(transaction, signal);
  const pendingStore = transaction.objectStore(PENDING_ACCOUNT_REPLAY);
  const [pending, currentCheckpoint] = await Promise.all([
    new Promise<PendingAccountReplay | null>((resolve, reject) => {
      const request = pendingStore.get(ownerId);
      request.onsuccess = () => resolve((request.result as PendingAccountReplay | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
    new Promise<Partial<SyncCheckpoint> | null>((resolve, reject) => {
      const request = transaction.objectStore(SYNC_CHECKPOINTS).get(ownerId);
      request.onsuccess = () =>
        resolve((request.result as Partial<SyncCheckpoint> | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
  ]);
  if (pending) {
    transaction.abort();
    throw new Error("Pending account replay must finish before initial resnapshot");
  }
  const currentEventVector = currentCheckpoint && Number.isSafeInteger(currentCheckpoint.eventPosition)
    ? currentCheckpoint.eventVector
      ? validateStreamVectorPosition(currentCheckpoint.eventVector)
      : { floor: Number(currentCheckpoint.eventPosition), writers: {} }
    : null;
  const incomingEventVector = input.checkpoint.eventVector
    ? validateStreamVectorPosition(input.checkpoint.eventVector)
    : { floor: input.checkpoint.eventPosition, writers: {} };
  if (
    currentCheckpoint &&
    ((currentEventVector != null && !streamVectorBeforeOrEqual(currentEventVector, incomingEventVector)) ||
      Number(currentCheckpoint.accountPosition) > input.checkpoint.accountPosition)
  ) {
    transaction.abort();
    throw new Error("Initial sync bundle is older than the durable checkpoint");
  }
  const eventStore = transaction.objectStore(EVENTS);
  await new Promise<void>((resolve, reject) => {
    const range = IDBKeyRange.bound(`${ownerId}:`, `${ownerId}:\uffff`);
    const request = eventStore.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const deliveryStore = transaction.objectStore(DELIVERY_ACKS);
  for (const row of preparedRows) {
    eventStore.put(row);
    deliveryStore.put({
      key: `${ownerId}:${row.eventId}`,
      ownerId,
      eventId: row.eventId,
      queuedAt: storedAt,
    } satisfies PendingDeliveryAcknowledgement);
  }
  transaction.objectStore(ACCOUNT_PROJECTIONS).put({
    ownerId,
    updates: [...latest.values()],
    lastPosition: input.checkpoint.accountPosition,
    updatedAt: storedAt,
  } satisfies AccountProjectionLedger);
  transaction.objectStore(INITIAL_SYNC_BUNDLES).put({
    ownerId,
    rooms: cloned.rooms,
    accountData: cloned.accountData,
    checkpoint: input.checkpoint,
    completedAt: storedAt,
  } satisfies InitialSyncBundle);
  transaction.objectStore(SYNC_CHECKPOINTS).put({
    ownerId,
    event: input.checkpoint.event,
    account: input.checkpoint.account,
    eventPosition: input.checkpoint.eventPosition,
    eventVector: input.checkpoint.eventVector,
    accountPosition: input.checkpoint.accountPosition,
    updatedAt: storedAt,
  });
  await transactionDone(transaction);
}

export async function readInitialSyncBundle(ownerId: string): Promise<InitialSyncBundle | null> {
  if (!ownerId || typeof window.indexedDB === "undefined") return null;
  const db = await openDb();
  const transaction = db.transaction([INITIAL_SYNC_BUNDLES, SYNC_CHECKPOINTS], "readonly");
  const [bundle, checkpoint] = await Promise.all([
    new Promise<InitialSyncBundle | null>((resolve, reject) => {
      const request = transaction.objectStore(INITIAL_SYNC_BUNDLES).get(ownerId);
      request.onsuccess = () => resolve((request.result as InitialSyncBundle | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
    new Promise<Partial<SyncCheckpoint> | null>((resolve, reject) => {
      const request = transaction.objectStore(SYNC_CHECKPOINTS).get(ownerId);
      request.onsuccess = () => resolve((request.result as Partial<SyncCheckpoint> | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
  ]);
  if (!bundle) return null;
  let eventCheckpointConsistent = true;
  if (checkpoint != null && Number.isSafeInteger(checkpoint.eventPosition)) {
    const storedVector = checkpoint.eventVector
      ? validateStreamVectorPosition(checkpoint.eventVector)
      : { floor: Number(checkpoint.eventPosition), writers: {} };
    const bundleVector = bundle.checkpoint.eventVector
      ? validateStreamVectorPosition(bundle.checkpoint.eventVector)
      : { floor: bundle.checkpoint.eventPosition, writers: {} };
    eventCheckpointConsistent = streamVectorBeforeOrEqual(bundleVector, storedVector);
  }
  if (
    bundle.ownerId !== ownerId ||
    (checkpoint != null &&
      (!Number.isSafeInteger(checkpoint.eventPosition) || !eventCheckpointConsistent ||
        !Number.isSafeInteger(checkpoint.accountPosition) ||
        Number(checkpoint.accountPosition) < bundle.checkpoint.accountPosition)) ||
    !Array.isArray(bundle.rooms) ||
    !Array.isArray(bundle.accountData?.drafts) ||
    !Array.isArray(bundle.accountData?.held_sends) ||
    !Array.isArray(bundle.accountData?.operations) ||
    !Array.isArray(bundle.accountData?.devices) ||
    !Array.isArray(bundle.accountData?.blocks) ||
    typeof bundle.accountData?.chat_preferences?.read_receipts_enabled !== "boolean"
  ) {
    throw new Error("Initial sync bundle and checkpoint are inconsistent");
  }
  validateInitialAccountManifest(bundle.accountData);
  for (const room of bundle.rooms) validateInitialRoomNotificationProjection(room);
  return bundle;
}

export async function updateInitialRoomProjection(
  ownerId: string,
  rooms: Room[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ownerId || typeof window.indexedDB === "undefined") return false;
  if (!Array.isArray(rooms)) throw new Error("Room projection is not an array");
  for (const room of rooms) validateInitialRoomNotificationProjection(room);
  let cloned: Room[];
  try {
    cloned = JSON.parse(JSON.stringify(rooms)) as Room[];
  } catch {
    throw new Error("Room projection is not serializable");
  }
  const db = await openDb();
  const transaction = db.transaction(INITIAL_SYNC_BUNDLES, "readwrite", {
    durability: "strict",
  });
  abortTransactionOnSignal(transaction, signal);
  const store = transaction.objectStore(INITIAL_SYNC_BUNDLES);
  const bundle = await new Promise<InitialSyncBundle | null>((resolve, reject) => {
    const request = store.get(ownerId);
    request.onsuccess = () => resolve((request.result as InitialSyncBundle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!bundle) {
    await transactionDone(transaction);
    return false;
  }
  store.put({ ...bundle, rooms: cloned });
  await transactionDone(transaction);
  return true;
}

/** Persist every supported account projection and clear its replay marker in
 * one strict transaction. The bounded ledger is restart evidence; it is not a
 * substitute for the feature-specific draft/room stores applied beforehand. */
export async function commitPendingAccountProjection(
  ownerId: string,
  nextPosition: number,
  signal?: AbortSignal,
): Promise<"committed" | "absent" | "mismatch"> {
  if (!ownerId || typeof window.indexedDB === "undefined") return "mismatch";
  const db = await openDb();
  const transaction = db.transaction(
    [PENDING_ACCOUNT_REPLAY, ACCOUNT_PROJECTIONS],
    "readwrite",
    { durability: "strict" },
  );
  abortTransactionOnSignal(transaction, signal);
  const replayStore = transaction.objectStore(PENDING_ACCOUNT_REPLAY);
  const projectionStore = transaction.objectStore(ACCOUNT_PROJECTIONS);
  const [replay, current] = await Promise.all([
    new Promise<PendingAccountReplay | null>((resolve, reject) => {
      const request = replayStore.get(ownerId);
      request.onsuccess = () => resolve((request.result as PendingAccountReplay | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
    new Promise<AccountProjectionLedger | null>((resolve, reject) => {
      const request = projectionStore.get(ownerId);
      request.onsuccess = () => resolve((request.result as AccountProjectionLedger | undefined) ?? null);
      request.onerror = () => reject(request.error);
    }),
  ]);
  if (!replay) {
    await transactionDone(transaction);
    return "absent";
  }
  if (replay.nextPosition !== nextPosition) {
    await transactionDone(transaction);
    return "mismatch";
  }
  const latest = new Map<string, AccountSyncUpdate>();
  for (const update of current?.updates ?? []) {
    if (SUPPORTED_ACCOUNT_SYNC_KINDS.has(update.kind)) {
      latest.set(accountProjectionKey(update), update);
    }
  }
  for (const update of replay.updates) {
    if (!SUPPORTED_ACCOUNT_SYNC_KINDS.has(update.kind)) {
      transaction.abort();
      throw new Error("Unsupported account projection cannot be committed");
    }
    latest.set(accountProjectionKey(update), update);
  }
  const updates = [...latest.values()]
    .sort((left, right) => left.position - right.position)
    .slice(-1_000);
  projectionStore.put({
    ownerId,
    updates,
    lastPosition: Math.max(current?.lastPosition ?? 0, replay.nextPosition),
    updatedAt: Date.now(),
  } satisfies AccountProjectionLedger);
  replayStore.delete(ownerId);
  await transactionDone(transaction);
  return "committed";
}

export async function readAccountProjections(ownerId: string): Promise<AccountSyncUpdate[]> {
  if (!ownerId || typeof window.indexedDB === "undefined") return [];
  const db = await openDb();
  const transaction = db.transaction(ACCOUNT_PROJECTIONS, "readonly");
  const ledger = await new Promise<AccountProjectionLedger | null>((resolve, reject) => {
    const request = transaction.objectStore(ACCOUNT_PROJECTIONS).get(ownerId);
    request.onsuccess = () => resolve((request.result as AccountProjectionLedger | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!ledger) return [];
  if (
    !Array.isArray(ledger.updates) || ledger.updates.length > 1_000 ||
    !Number.isSafeInteger(ledger.lastPosition) || ledger.lastPosition < 0 ||
    ledger.updates.some((update) =>
      !update ||
      !Number.isSafeInteger(update.position) || update.position < 0 ||
      update.position > ledger.lastPosition ||
      !SUPPORTED_ACCOUNT_SYNC_KINDS.has(update.kind) ||
      typeof update.room_id !== "string" ||
      typeof update.object_id !== "string" ||
      !update.data || typeof update.data !== "object" || Array.isArray(update.data)
    )
  ) {
    throw new Error("Durable account projection ledger is malformed");
  }
  return [...ledger.updates].sort((left, right) => left.position - right.position);
}

export async function loadStoredRoomEvents(
  ownerId: string,
  roomId: string,
  limit = 100,
): Promise<Event[]> {
  if (!ownerId || typeof window.indexedDB === "undefined") return [];
  const db = await openDb();
  const transaction = db.transaction(EVENTS, "readonly");
  const index = transaction.objectStore(EVENTS).index(OWNER_ROOM_TIMELINE);
  const range = IDBKeyRange.bound(
    [ownerId, roomId, "", ""],
    [ownerId, roomId, "\uffff", "\uffff"],
  );
  const rows: StoredEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) {
        resolve();
        return;
      }
      rows.push(cursor.value as StoredEvent);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return rows.reverse().map((row) => row.event);
}

/**
 * Delete only the signed-in owner's replaceable Glass projections after exact
 * HTTPS reachability has been proved. Drafts, queued sends, attachment blobs,
 * voice drafts, and their recovery journals live in different databases and
 * are deliberately outside this transaction.
 */
export async function rebuildReachableChatCache(
  ownerId: string,
  reachable: boolean,
): Promise<ChatCacheRebuildResult> {
  if (!reachable) {
    throw new Error("Glass must be reachable before offline history can be rebuilt");
  }
  if (!ownerId || typeof window.indexedDB === "undefined") {
    throw new Error("Offline history storage is unavailable");
  }
  const db = await openDb();
  const transaction = db.transaction(
    [
      EVENTS,
      SYNC_CHECKPOINTS,
      SYNC_RECOVERY,
      PENDING_ACCOUNT_REPLAY,
      ACCOUNT_PROJECTIONS,
      INITIAL_SYNC_BUNDLES,
    ],
    "readwrite",
    { durability: "strict" },
  );
  const events = transaction.objectStore(EVENTS);
  for (const storeName of [
    SYNC_CHECKPOINTS,
    SYNC_RECOVERY,
    PENDING_ACCOUNT_REPLAY,
    ACCOUNT_PROJECTIONS,
    INITIAL_SYNC_BUNDLES,
  ]) {
    transaction.objectStore(storeName).delete(ownerId);
  }
  let deletedEvents = 0;
  await new Promise<void>((resolve, reject) => {
    const request = events.openCursor(
      IDBKeyRange.bound(`${ownerId}:`, `${ownerId}:\uffff`),
    );
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const row = cursor.value as Partial<StoredEvent>;
      if (row.ownerId === ownerId) {
        cursor.delete();
        deletedEvents += 1;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  await transactionDone(transaction);
  clearStorageIssue("timeline");
  return { deletedEvents };
}

/**
 * Bound authoritative history only when exact API reachability has already been
 * proved and browser storage is under pressure. The latest rows in every room
 * and explicit viewport/anchor identities are never candidates. Unresolved
 * local overlays live in the separate non-evictable outbox. A caller must not
 * substitute navigator.onLine for `reachable`.
 */
export async function pruneReachableTimelineCache(
  ownerId: string,
  input: {
    reachable: boolean;
    usage: number;
    quota: number;
    highWatermark?: number;
    keepPerRoom?: number;
    maxDeletes?: number;
    protectedEventIds?: Iterable<string>;
  },
): Promise<TimelineCachePruneResult> {
  if (!input.reachable) return { reason: "offline", deleted: 0, retained: 0 };
  if (!ownerId || typeof window.indexedDB === "undefined") {
    return { reason: "unavailable", deleted: 0, retained: 0 };
  }
  const highWatermark = input.highWatermark ?? 0.85;
  if (
    !Number.isFinite(input.usage) || input.usage < 0 ||
    !Number.isFinite(input.quota) || input.quota <= 0 ||
    !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1 ||
    input.usage / input.quota < highWatermark
  ) {
    return { reason: "not_pressured", deleted: 0, retained: 0 };
  }
  const keepPerRoom = Math.max(25, Math.min(2_000, Math.trunc(input.keepPerRoom ?? 250)));
  const maxDeletes = Math.max(1, Math.min(5_000, Math.trunc(input.maxDeletes ?? 1_000)));
  const protectedIds = new Set(input.protectedEventIds ?? []);
  const db = await openDb();
  const transaction = db.transaction(EVENTS, "readwrite", { durability: "strict" });
  const store = transaction.objectStore(EVENTS);
  const rows: StoredEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor(IDBKeyRange.bound(`${ownerId}:`, `${ownerId}:\uffff`));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const row = cursor.value as StoredEvent;
      if (row.ownerId === ownerId) rows.push(row);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  const byRoom = new Map<string, StoredEvent[]>();
  for (const row of rows) {
    const room = byRoom.get(row.roomId) ?? [];
    room.push(row);
    byRoom.set(row.roomId, room);
  }
  const candidates: StoredEvent[] = [];
  for (const room of byRoom.values()) {
    room.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId)
    );
    for (const row of room.slice(keepPerRoom)) {
      if (protectedIds.has(row.eventId)) continue;
      candidates.push(row);
    }
  }
  candidates.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId)
  );
  const deleted = candidates.slice(0, maxDeletes);
  for (const row of deleted) store.delete(row.key);
  await transactionDone(transaction);
  return { reason: "pruned", deleted: deleted.length, retained: rows.length - deleted.length };
}

function sanitizedRecoveryDetails(details: SyncIntegrityDetails): SyncIntegrityDetails {
  const safe: SyncIntegrityDetails = {};
  for (const key of [
    "expectedPosition",
    "observedPosition",
    "fromPosition",
    "nextPosition",
    "throughPosition",
    "itemCount",
  ] as const) {
    const value = details[key];
    if (Number.isSafeInteger(value) && Number(value) >= 0) safe[key] = Number(value);
  }
  if (typeof details.roomId === "string" && details.roomId.length <= 64) {
    safe.roomId = details.roomId;
  }
  return safe;
}

export async function readSyncRecovery(ownerId: string): Promise<SyncRecoveryRecord | null> {
  if (!ownerId || typeof window.indexedDB === "undefined") return null;
  const db = await openDb();
  const transaction = db.transaction(SYNC_RECOVERY, "readonly");
  return new Promise<SyncRecoveryRecord | null>((resolve, reject) => {
    const request = transaction.objectStore(SYNC_RECOVERY).get(ownerId);
    request.onsuccess = () => resolve((request.result as SyncRecoveryRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function writeSyncRecovery(
  ownerId: string,
  incident: Pick<SyncRecoveryRecord, "phase" | "reason" | "stream"> & {
    details?: SyncIntegrityDetails;
  },
): Promise<SyncRecoveryRecord> {
  if (!ownerId || typeof window.indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable");
  }
  const db = await openDb();
  const transaction = db.transaction(SYNC_RECOVERY, "readwrite", { durability: "strict" });
  const store = transaction.objectStore(SYNC_RECOVERY);
  const previous = await new Promise<SyncRecoveryRecord | null>((resolve, reject) => {
    const request = store.get(ownerId);
    request.onsuccess = () => resolve((request.result as SyncRecoveryRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  const now = Date.now();
  const record: SyncRecoveryRecord = {
    ownerId,
    phase: incident.phase,
    reason: incident.reason,
    stream: incident.stream,
    details: sanitizedRecoveryDetails(incident.details ?? {}),
    detectedAt:
      previous && previous.phase !== "recovered" ? previous.detectedAt : now,
    updatedAt: now,
    recoveredAt: incident.phase === "recovered" ? now : null,
    occurrences:
      previous && previous.reason === incident.reason && previous.stream === incident.stream
        ? previous.occurrences + 1
        : 1,
    revision: (previous?.revision ?? 0) + 1,
  };
  store.put(record);
  await transactionDone(transaction);
  return record;
}

/** Mark exactly the incident the caller observed as recovered. A newer
 * diagnostic wins, so a late room-history success cannot hide a socket gap. */
export async function resolveSyncRecovery(
  ownerId: string,
  expectedRevision: number,
): Promise<SyncRecoveryRecord | null> {
  if (!ownerId || typeof window.indexedDB === "undefined") return null;
  const db = await openDb();
  const transaction = db.transaction(SYNC_RECOVERY, "readwrite", { durability: "strict" });
  const store = transaction.objectStore(SYNC_RECOVERY);
  const current = await new Promise<SyncRecoveryRecord | null>((resolve, reject) => {
    const request = store.get(ownerId);
    request.onsuccess = () => resolve((request.result as SyncRecoveryRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!current || current.phase === "recovered" || current.revision !== expectedRevision) {
    await transactionDone(transaction);
    return current;
  }
  const now = Date.now();
  const recovered: SyncRecoveryRecord = {
    ...current,
    phase: "recovered",
    updatedAt: now,
    recoveredAt: now,
    revision: current.revision + 1,
  };
  store.put(recovered);
  await transactionDone(transaction);
  return recovered;
}
