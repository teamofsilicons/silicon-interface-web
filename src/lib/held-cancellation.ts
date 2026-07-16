"use client";

import { api, ApiError } from "./api";
import { authStore } from "./auth";
import { acceptedHeldSend, eventForSentHeld } from "./operation-recovery";
import { isOutboxAcknowledged } from "./outbox";
import type { ClientOperationStatus, Event, HeldSend } from "./types";

const DB_NAME = "silicon-interface-held-cancellations";
const STORE = "cancellations";
const MIRROR_PREFIX = "silicon-interface:held-cancel:v1";
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
let database: Promise<IDBDatabase> | null = null;

export type HeldCancellationState = "pending" | "cancelled" | "failed" | "sent";

/**
 * A cancellation is deliberately independent from the send outbox. Glass may
 * already own a held row by the time the user deletes its optimistic bubble,
 * while the send outbox may already contain an acknowledgement tombstone.
 * Keeping the immutable payload here lets recovery materialize the same
 * idempotent held operation and cancel it after a lost create response.
 */
export interface HeldCancellation {
  key: string;
  ownerId: string;
  roomId: string;
  clientId: string;
  heldSendId?: string;
  body: string;
  content: Record<string, unknown>;
  replyTo?: string;
  releaseAt?: string;
  state: HeldCancellationState;
  requestedAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  sentEventId?: string;
  terminalAt?: number;
  /** Sent projections are marked only after the authoritative Event is in the
   * durable timeline cache. Cancelled/failed rows project themselves. */
  projectedAt?: number;
  expiresAt?: number;
}

export interface HeldCancellationRequest {
  roomId: string;
  clientId: string;
  heldSendId?: string;
  body: string;
  content?: Record<string, unknown>;
  replyTo?: string;
  releaseAt?: string;
}

function rowKey(ownerId: string, clientId: string): string {
  return `${ownerId}:${clientId}`;
}

function mirrorPrefix(ownerId: string): string {
  return `${MIRROR_PREFIX}:${encodeURIComponent(ownerId)}:`;
}

function mirrorKey(ownerId: string, clientId: string): string {
  return `${mirrorPrefix(ownerId)}${encodeURIComponent(clientId)}`;
}

function parseCancellation(value: unknown): HeldCancellation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as HeldCancellation;
  if (
    typeof row.key !== "string" ||
    typeof row.ownerId !== "string" ||
    typeof row.roomId !== "string" ||
    typeof row.clientId !== "string" ||
    typeof row.body !== "string" ||
    !row.content ||
    typeof row.content !== "object" ||
    !["pending", "cancelled", "failed", "sent"].includes(row.state) ||
    typeof row.requestedAt !== "number" ||
    typeof row.updatedAt !== "number" ||
    typeof row.attempts !== "number" ||
    typeof row.nextAttemptAt !== "number"
  ) {
    return null;
  }
  if (
    (row.sentEventId != null && typeof row.sentEventId !== "string") ||
    (row.terminalAt != null && typeof row.terminalAt !== "number") ||
    (row.projectedAt != null && typeof row.projectedAt !== "number") ||
    (row.expiresAt != null && typeof row.expiresAt !== "number")
  ) return null;
  return row;
}

function terminal(row: HeldCancellation): boolean {
  return row.state !== "pending";
}

/** Terminal knowledge always beats a stale pending writer. Otherwise the most
 * recent strict commit wins. A stale pending copy can cause a redundant DELETE,
 * but can never make a cancelled message send. */
function winner(
  left: HeldCancellation | null,
  right: HeldCancellation | null,
): HeldCancellation | null {
  if (!left) return right;
  if (!right) return left;
  if (terminal(left) !== terminal(right)) return terminal(left) ? left : right;
  return left.updatedAt >= right.updatedAt ? left : right;
}

function readMirror(ownerId: string, clientId: string): HeldCancellation | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(mirrorKey(ownerId, clientId));
    return raw ? parseCancellation(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeMirror(row: HeldCancellation): boolean {
  if (typeof window === "undefined") return false;
  try {
    const current = readMirror(row.ownerId, row.clientId);
    const next = winner(current, row) ?? row;
    window.localStorage.setItem(mirrorKey(row.ownerId, row.clientId), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

function listMirror(ownerId: string): HeldCancellation[] {
  if (typeof window === "undefined") return [];
  const prefix = mirrorPrefix(ownerId);
  const rows: HeldCancellation[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key);
      const row = raw ? parseCancellation(JSON.parse(raw) as unknown) : null;
      if (row) rows.push(row);
    }
  } catch {
    // IndexedDB remains an independent recovery layer.
  }
  return rows;
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("ownerAt", ["ownerId", "requestedAt"]);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (database === opening) database = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("cancellation database failed"));
  });
  database = opening;
  void opening.catch(() => {
    if (database === opening) database = null;
  });
  return opening;
}

function done(transaction: IDBTransaction): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("cancellation transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("cancellation transaction aborted"));
  });
  void result.catch(() => undefined);
  return result;
}

async function writeDatabase(row: HeldCancellation): Promise<boolean> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    const completion = done(transaction);
    const store = transaction.objectStore(STORE);
    const request = store.get(row.key);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const current = parseCancellation(request.result as unknown);
        store.put(winner(current, row) ?? row);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    await completion;
    return true;
  } catch {
    return false;
  }
}

async function readDatabase(ownerId: string, clientId: string): Promise<HeldCancellation | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(rowKey(ownerId, clientId));
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(parseCancellation(request.result as unknown));
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function persist(row: HeldCancellation): Promise<void> {
  const mirrorDurable = writeMirror(row);
  const databaseDurable = await writeDatabase(row);
  if (!mirrorDurable && !databaseDurable) {
    throw new Error("Unable to durably cancel this held message");
  }
}

export async function getHeldCancellation(
  ownerId: string,
  clientId: string,
): Promise<HeldCancellation | null> {
  const mirror = readMirror(ownerId, clientId);
  const primary = await readDatabase(ownerId, clientId);
  const resolved = winner(mirror, primary);
  if (resolved) {
    // Repair either stale/missing layer opportunistically. The caller never
    // waits on repair to decide that the send is cancelled.
    writeMirror(resolved);
    void writeDatabase(resolved);
  }
  return resolved;
}

export async function listHeldCancellations(ownerId: string): Promise<HeldCancellation[]> {
  const rows = new Map<string, HeldCancellation>();
  for (const row of listMirror(ownerId)) rows.set(row.clientId, row);
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readonly");
    const index = transaction.objectStore(STORE).index("ownerAt");
    const range = IDBKeyRange.bound([ownerId, 0], [ownerId, Number.MAX_SAFE_INTEGER]);
    const request = index.getAll(range);
    const primary = await new Promise<HeldCancellation[]>((resolve, reject) => {
      request.onsuccess = () =>
        resolve(
          (request.result as unknown[])
            .map(parseCancellation)
            .filter((row): row is HeldCancellation => row != null),
        );
      request.onerror = () => reject(request.error);
    });
    for (const row of primary) {
      rows.set(row.clientId, winner(rows.get(row.clientId) ?? null, row) ?? row);
    }
  } catch {
    // The per-client mirror is independently durable.
  }
  const resolved = [...rows.values()].sort((left, right) => left.requestedAt - right.requestedAt);
  for (const row of resolved) writeMirror(row);
  return resolved;
}

export async function requestHeldCancellation(
  ownerId: string,
  request: HeldCancellationRequest,
): Promise<HeldCancellation> {
  const existing = await getHeldCancellation(ownerId, request.clientId);
  if (existing && terminal(existing)) return existing;
  const now = Date.now();
  const row: HeldCancellation = {
    key: rowKey(ownerId, request.clientId),
    ownerId,
    roomId: request.roomId,
    clientId: request.clientId,
    heldSendId: request.heldSendId ?? existing?.heldSendId,
    body: request.body || existing?.body || "",
    content: { ...(existing?.content ?? {}), ...(request.content ?? {}) },
    replyTo: request.replyTo ?? existing?.replyTo,
    releaseAt: request.releaseAt ?? existing?.releaseAt,
    state: "pending",
    requestedAt: existing?.requestedAt ?? now,
    updatedAt: now,
    attempts: existing?.attempts ?? 0,
    nextAttemptAt: now,
    lastError: undefined,
  };
  await persist(row);
  return (await getHeldCancellation(ownerId, request.clientId)) ?? row;
}

async function patchCancellation(
  row: HeldCancellation,
  patch: Partial<HeldCancellation>,
): Promise<HeldCancellation> {
  const next = { ...row, ...patch, key: row.key, updatedAt: Date.now() };
  await persist(next);
  return (await getHeldCancellation(row.ownerId, row.clientId)) ?? next;
}

/** Web Locks serialize the final cancellation check with every held create /
 * send-now performed by this client across tabs. The server's idempotent held
 * operation remains the correctness fallback on browsers without Web Locks. */
export async function withOutboxClientLock<T>(
  ownerId: string,
  clientId: string,
  work: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return work();
  return locks.request(
    `silicon-interface:outbox:${encodeURIComponent(ownerId)}:${encodeURIComponent(clientId)}`,
    { mode: "exclusive" },
    work,
  );
}

export interface HeldCancellationTransport {
  lookup(roomId: string, clientId: string): Promise<ClientOperationStatus>;
  create(row: HeldCancellation, holdSeconds: number): Promise<HeldSend>;
  cancel(roomId: string, heldSendId: string): Promise<HeldSend>;
}

export const heldCancellationApiTransport: HeldCancellationTransport = {
  lookup: (roomId, clientId) => api.clientOperation(roomId, "held_send", clientId),
  create: (row, holdSeconds) =>
    api.createHeldSend(row.roomId, {
      type: "m.text",
      content: { ...row.content, body: row.body, client_id: row.clientId },
      client_id: row.clientId,
      reply_to_event_id: row.replyTo,
      hold_seconds: holdSeconds,
    }),
  cancel: (roomId, heldSendId) => api.cancelHeldSend(roomId, heldSendId),
};

function validateHeld(row: HeldCancellation, held: HeldSend): HeldSend {
  if (held.room_id !== row.roomId || held.client_id !== row.clientId) {
    throw new Error("Held cancellation response did not match the saved message");
  }
  return held;
}

function retryDelay(attempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Resolve the device-scoped operation before cancelling. If Glass has no row,
 * create the exact same immutable held operation first and immediately cancel
 * it. This closes the lost-create-response race: a cancellation never assumes
 * that a 404 means another in-flight tab did not commit one millisecond later.
 */
export async function reconcileHeldCancellation(
  input: HeldCancellation,
  transport: HeldCancellationTransport = heldCancellationApiTransport,
  expectedDeviceId: string | null = authStore.getBoundDeviceId(),
): Promise<HeldCancellationState> {
  return withOutboxClientLock(input.ownerId, input.clientId, async () => {
    let row = (await getHeldCancellation(input.ownerId, input.clientId)) ?? input;
    if (terminal(row)) return row.state;
    try {
      let held: HeldSend | null = null;
      if (row.heldSendId) {
        try {
          held = validateHeld(row, await transport.cancel(row.roomId, row.heldSendId));
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
        }
      }

      if (!held) {
        try {
          const operation = await transport.lookup(row.roomId, row.clientId);
          held = acceptedHeldSend(operation, row.roomId, row.clientId, expectedDeviceId);
          if (!held) throw new Error("Held operation lookup was not bound to this device and message");
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          const remaining = row.releaseAt ? Date.parse(row.releaseAt) - Date.now() : 1_000;
          held = validateHeld(
            row,
            await transport.create(row, Math.max(1, Math.min(10, Math.ceil(remaining / 1_000)))),
          );
        }
      }

      held = validateHeld(row, held);
      if (held.state === "pending" || held.state === "releasing") {
        held = validateHeld(row, await transport.cancel(row.roomId, held.held_send_id));
      }
      const state: HeldCancellationState =
        held.state === "cancelled"
          ? "cancelled"
          : held.state === "failed"
            ? "failed"
            : held.state === "sent"
              ? "sent"
              : "pending";
      const now = Date.now();
      row = await patchCancellation(row, {
        heldSendId: held.held_send_id,
        state,
        sentEventId: held.sent_event_id || row.sentEventId,
        terminalAt: state === "pending" ? undefined : now,
        projectedAt:
          state === "cancelled" || state === "failed"
            ? now
            : row.projectedAt,
        expiresAt: state === "pending" ? undefined : now + TERMINAL_RETENTION_MS,
        nextAttemptAt: state === "pending" ? Date.now() + 1_000 : 0,
        lastError: state === "pending" ? "Glass has not confirmed cancellation yet" : undefined,
      }).catch(() => ({ ...row, heldSendId: held!.held_send_id, state }));
      return row.state;
    } catch (error) {
      const attempts = row.attempts + 1;
      await patchCancellation(row, {
        attempts,
        nextAttemptAt: Date.now() + retryDelay(attempts),
        lastError: error instanceof Error ? error.message : "Cancellation is waiting for Glass",
      }).catch(() => undefined);
      throw error;
    }
  });
}

/** Any cancellation record, including a terminal one, permanently shadows a
 * stale held outbox intent. */
export async function maySendHeldOutbox(ownerId: string, clientId: string): Promise<boolean> {
  return (await getHeldCancellation(ownerId, clientId)) == null;
}

export function heldCancellationCanHide(row: HeldCancellation): boolean {
  return row.state === "cancelled" ||
    row.state === "failed" ||
    (row.state === "sent" && Boolean(row.projectedAt));
}

export function findHeldCancellationEvent(
  row: HeldCancellation,
  events: Event[],
): Event | null {
  // content.client_id is only device-scoped on Glass. Another device may
  // legitimately reuse the same value, so only the exact held sent_event_id
  // can authorize projection and deletion of our last local representation.
  if (!row.sentEventId) return null;
  return eventForSentHeld(
    {
      held_send_id: row.heldSendId ?? "",
      room_id: row.roomId,
      client_id: row.clientId,
      type: "m.text",
      content: row.content,
      reply_to_event_id: row.replyTo ?? "",
      state: "sent",
      release_at: row.releaseAt ?? "",
      sent_event_id: row.sentEventId,
      version: 0,
      error: "",
      created_at: "",
      updated_at: "",
      terminal_at: "",
    },
    events,
  );
}

export async function markHeldCancellationProjected(
  ownerId: string,
  clientId: string,
): Promise<boolean> {
  const row = await getHeldCancellation(ownerId, clientId);
  if (!row || row.state !== "sent") return false;
  try {
    await patchCancellation(row, { projectedAt: Date.now() });
    return true;
  } catch {
    return false;
  }
}

async function deleteCancellation(row: HeldCancellation): Promise<boolean> {
  let mirrorDeleted = false;
  try {
    window.localStorage.removeItem(mirrorKey(row.ownerId, row.clientId));
    mirrorDeleted = true;
  } catch {
    // IndexedDB deletion may still bound this layer.
  }
  let databaseDeleted = false;
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    transaction.objectStore(STORE).delete(row.key);
    await done(transaction);
    databaseDeleted = true;
  } catch {
    // Retaining a terminal tombstone is safer than partial destructive repair.
  }
  return mirrorDeleted && databaseDeleted;
}

/** Terminal journals are bounded, but only after their UI projection is
 * durable, the send outbox has its independent ack tombstone, and a long
 * stale-tab safety window has elapsed. */
export async function garbageCollectHeldCancellations(
  ownerId: string,
  now = Date.now(),
): Promise<number> {
  const rows = await listHeldCancellations(ownerId);
  let removed = 0;
  for (const row of rows) {
    if (
      row.state === "pending" ||
      !row.projectedAt ||
      !row.expiresAt ||
      row.expiresAt > now ||
      !(await isOutboxAcknowledged(ownerId, row.clientId))
    ) continue;
    if (await deleteCancellation(row)) removed += 1;
  }
  return removed;
}
