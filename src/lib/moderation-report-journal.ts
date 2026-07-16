"use client";

export type ModerationReportReason =
  | "spam"
  | "harassment"
  | "inappropriate"
  | "other";

export type ModerationReportState =
  | "pending"
  | "sending"
  | "retry_wait"
  | "accepted"
  | "blocked";

export interface ModerationReportIntent {
  version: 1;
  ownerId: string;
  clientId: string;
  targetKind: "carbon" | "silicon";
  targetId: string;
  eventId: string;
  reason: ModerationReportReason;
  details: string;
  state: ModerationReportState;
  attempts: number;
  nextAttemptAt: number | null;
  reportId: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = "silicon-interface-moderation-reports";
const STORE = "reports";
const LOCAL_PREFIX = "silicon:moderation-report:v1:";
export const MODERATION_REPORT_RETRY_SCHEDULED_EVENT =
  "silicon:moderation-report-retry-scheduled";
const REASONS = new Set<ModerationReportReason>([
  "spam",
  "harassment",
  "inappropriate",
  "other",
]);
let dbPromise: Promise<IDBDatabase> | null = null;
const writes = new Map<string, Promise<void>>();

export interface ModerationReportRetryScheduledDetail {
  ownerId: string;
  clientId: string;
  nextAttemptAt: number;
}

function notifyRetryScheduled(row: ModerationReportIntent): void {
  if (
    row.state !== "retry_wait" ||
    row.nextAttemptAt === null ||
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent !== "function"
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ModerationReportRetryScheduledDetail>(
      MODERATION_REPORT_RETRY_SCHEDULED_EVENT,
      {
        detail: {
          ownerId: row.ownerId,
          clientId: row.clientId,
          nextAttemptAt: row.nextAttemptAt,
        },
      },
    ),
  );
}

function recordKey(ownerId: string, clientId: string): string {
  return `${ownerId}:${clientId}`;
}

function localKey(ownerId: string, clientId: string): string {
  return `${LOCAL_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(clientId)}`;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof window.indexedDB === "undefined") {
      reject(new Error("IndexedDB moderation journal is unavailable"));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

function validIntent(value: unknown): value is ModerationReportIntent {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ModerationReportIntent>;
  return (
    row.version === 1 &&
    typeof row.ownerId === "string" && row.ownerId.length > 0 &&
    typeof row.clientId === "string" && row.clientId.length > 0 && row.clientId.length <= 64 &&
    (row.targetKind === "carbon" || row.targetKind === "silicon") &&
    typeof row.targetId === "string" && row.targetId.length > 0 &&
    typeof row.eventId === "string" && row.eventId.length > 0 && row.eventId.length <= 26 &&
    REASONS.has(row.reason as ModerationReportReason) &&
    typeof row.details === "string" && row.details.length <= 1000 &&
    ["pending", "sending", "retry_wait", "accepted", "blocked"].includes(String(row.state)) &&
    Number.isSafeInteger(row.attempts) && Number(row.attempts) >= 0 &&
    (row.nextAttemptAt === null || Number.isFinite(row.nextAttemptAt)) &&
    (row.reportId === null || typeof row.reportId === "string") &&
    (row.errorCode === null || typeof row.errorCode === "string") &&
    Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt)
  );
}

function immutableIdentity(row: ModerationReportIntent): string {
  return JSON.stringify([
    row.ownerId,
    row.clientId,
    row.targetKind,
    row.targetId,
    row.eventId,
    row.reason,
    row.details,
  ]);
}

function randomClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Secure report identity generation is unavailable");
}

export function createModerationReportIntent(input: {
  ownerId: string;
  targetKind: "carbon" | "silicon";
  targetId: string;
  eventId: string;
  reason: ModerationReportReason;
  details?: string;
  now?: number;
}): ModerationReportIntent {
  const now = input.now ?? Date.now();
  const row: ModerationReportIntent = {
    version: 1,
    ownerId: input.ownerId,
    clientId: randomClientId(),
    targetKind: input.targetKind,
    targetId: input.targetId,
    eventId: input.eventId,
    reason: input.reason,
    details: input.details ?? "",
    state: "pending",
    attempts: 0,
    nextAttemptAt: null,
    reportId: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  };
  if (!validIntent(row)) throw new Error("Invalid moderation report intent");
  return row;
}

async function readIndexedDb(ownerId: string, clientId: string): Promise<ModerationReportIntent | null> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readonly");
    return await new Promise((resolve, reject) => {
      const request = transaction.objectStore(STORE).get(recordKey(ownerId, clientId));
      request.onsuccess = () => resolve(validIntent(request.result) ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

function readLocal(ownerId: string, clientId: string): ModerationReportIntent | null {
  try {
    const raw = window.localStorage.getItem(localKey(ownerId, clientId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return validIntent(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readModerationReportIntent(
  ownerId: string,
  clientId: string,
): Promise<ModerationReportIntent | null> {
  await writes.get(recordKey(ownerId, clientId))?.catch(() => undefined);
  const [indexed, local] = await Promise.all([
    readIndexedDb(ownerId, clientId),
    Promise.resolve(readLocal(ownerId, clientId)),
  ]);
  if (indexed && local && immutableIdentity(indexed) !== immutableIdentity(local)) {
    // A client id can never be rebound to another report. Keep the older copy
    // for diagnosis and fail closed instead of picking whichever store won.
    throw new Error("Moderation report identity conflict");
  }
  if (!indexed) return local;
  if (!local) return indexed;
  return indexed.updatedAt >= local.updatedAt ? indexed : local;
}

export function writeModerationReportIntent(row: ModerationReportIntent): Promise<void> {
  if (!validIntent(row)) return Promise.reject(new Error("Invalid moderation report intent"));
  const key = recordKey(row.ownerId, row.clientId);
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const [indexedExisting, localExisting] = await Promise.all([
        readIndexedDb(row.ownerId, row.clientId),
        Promise.resolve(readLocal(row.ownerId, row.clientId)),
      ]);
      if (
        indexedExisting && localExisting &&
        immutableIdentity(indexedExisting) !== immutableIdentity(localExisting)
      ) {
        throw new Error("Moderation report identity conflict");
      }
      const existing = indexedExisting ?? localExisting;
      if (existing && immutableIdentity(existing) !== immutableIdentity(row)) {
        throw new Error("Moderation report client id cannot be rebound");
      }
      const results = await Promise.allSettled([
        (async () => {
          window.localStorage.setItem(localKey(row.ownerId, row.clientId), JSON.stringify(row));
        })(),
        (async () => {
          const db = await openDb();
          const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
          transaction.objectStore(STORE).put(row, key);
          await transactionDone(transaction);
        })(),
      ]);
      if (results.every((result) => result.status === "rejected")) {
        throw new Error("No durable moderation report storage is available");
      }
      // A deadline becomes actionable only after at least one durable store
      // owns it. Notify the recovery worker here so a failure created while
      // already online cannot wait indefinitely for a mount/online event.
      notifyRetryScheduled(row);
    })
    .finally(() => {
      if (writes.get(key) === next) writes.delete(key);
    });
  writes.set(key, next);
  return next;
}

export async function listModerationReportIntents(
  ownerId: string,
): Promise<ModerationReportIntent[]> {
  if (!ownerId) return [];
  await Promise.all([...writes.values()].map((write) => write.catch(() => undefined)));
  const merged = new Map<string, ModerationReportIntent>();
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readonly");
    await new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        if (validIntent(cursor.value) && cursor.value.ownerId === ownerId) {
          merged.set(cursor.value.clientId, cursor.value);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    // local mirror may still be healthy
  }
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(LOCAL_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const value: unknown = JSON.parse(raw);
      if (!validIntent(value) || value.ownerId !== ownerId) continue;
      const prior = merged.get(value.clientId);
      if (prior && immutableIdentity(prior) !== immutableIdentity(value)) {
        throw new Error("Moderation report identity conflict");
      }
      if (!prior || value.updatedAt > prior.updatedAt) merged.set(value.clientId, value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("identity conflict")) throw error;
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function clearModerationReportsForOwner(ownerId: string): Promise<void> {
  if (!ownerId) return;
  // Cleanup must not depend on successfully reconciling the two mirrors.  A
  // conflicting/corrupt mirror is exactly when privacy cleanup matters most.
  await Promise.all([...writes.values()].map((write) => write.catch(() => undefined)));
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(LOCAL_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const value: unknown = JSON.parse(raw);
        if (validIntent(value) && value.ownerId === ownerId) window.localStorage.removeItem(key);
      } catch {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // IndexedDB cleanup below remains authoritative.
  }
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    const store = transaction.objectStore(STORE);
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const value = cursor.value as Partial<ModerationReportIntent> | null;
        // Canonical Carbon ids cannot contain ':'.  Checking both the value
        // and key also removes malformed rows whose payload no longer parses.
        if (
          value?.ownerId === ownerId ||
          (typeof cursor.key === "string" && cursor.key.startsWith(`${ownerId}:`))
        ) {
          cursor.delete();
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await transactionDone(transaction);
  } catch {
    // Logout must continue even when a browser storage provider is unhealthy.
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const ownerKey = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey;
    const ownerId = ownerKey?.startsWith("carbon:") ? ownerKey.slice("carbon:".length) : "";
    if (ownerId) void clearModerationReportsForOwner(ownerId);
  });
}
