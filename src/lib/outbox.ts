"use client";

import { clearStorageIssue, reportStorageIssue } from "./storage-health";
import {
  type AbuseChallenge,
  wasAbuseChallengeSolved,
} from "./abuse-challenge-store";
import { authStore } from "./auth";
import { deviceId } from "./device-id";
import {
  allocateTimelineIdentity,
  bindAcceptedTimelineEvent,
  identityFromPersistedFields,
  makeTimelineIdentity,
  readTimelineIdentity,
  restoreDurableTimelineIdentity,
  timelineSequenceFloor,
  type TimelineIdentity,
} from "./timeline-identity";
import { storeEvents } from "./chat-store";
import type { Event } from "./types";
import {
  isCorrectionAction,
  isSendFailureRecord,
  type CorrectionAction,
  type PendingSendState,
  type SendFailureRecord,
} from "./send-failure";
import { newTraceparent, validTraceparent } from "./trace-context";
import { beginClientDurableCommit } from "./reliability-telemetry";

/**
 * Persisted outbox for every send kind. IndexedDB is the primary queue and a
 * per-client localStorage journal is the recovery layer. Both are committed
 * before a caller may POST. Glass deduplicates the immutable client ID, so a
 * retained row is always safe to replay after a crash or lost response.
 *
 * The recovery journal deliberately does not use one owner-wide JSON array.
 * Array read/modify/write loses messages when two tabs enqueue concurrently.
 * Each intent and acknowledgement has its own atomic key instead. A separate
 * acknowledgement key shadows every stale intent copy (including the legacy
 * array), so an old tab cannot resurrect work that Glass already accepted.
 */

const PREFIX = "silicon-interface:outbox";
const MIRROR_VERSION = "v2";
const DB_NAME = "silicon-interface-outbox";
const DB_VERSION = 2;
const STORE = "entries";
const META = "meta";
let dbPromise: Promise<IDBDatabase> | null = null;

export interface OutboxEntry {
  roomId: string;
  clientId: string;
  /** Opaque W3C root committed with the intent and reused after restart. */
  traceparent?: string;
  /** Immutable timeline identity allocated before this intent may be sent. */
  localKey?: string;
  localSequence?: number;
  originDevice?: string;
  localCreatedAt?: string;
  /** Held sends retry the held-send endpoint, never the immediate-send path. */
  operation?: "event" | "held" | "media";
  type?: string;
  body: string;
  /** Extra event content to preserve across reload retries. */
  content?: Record<string, unknown>;
  /** reply_to_event_id, when the send quoted another message. */
  replyTo?: string;
  /** Original local deadline for a short held send. */
  releaseAt?: string;
  /** Enqueue time (epoch ms) — preserves retry order. */
  at: number;
  /** Last durable mutation, used to reconcile both durability layers. */
  updatedAt?: number;
  state?: PendingSendState;
  attempts?: number;
  nextAttemptAt?: number;
  lastError?: string;
  /** Body-free, finite failure contract used by recovery and accessible UX. */
  failure?: SendFailureRecord;
  /** Body-free proof that an explicit correction was durably applied to this
   * same scoped intent before any UI projection or recovery wake. */
  correction?: {
    action: CorrectionAction;
    appliedAt: number;
    priorIntentHash: string;
  };
  challenge?: AbuseChallenge;
  /** A media send owns a separately staged Blob until Glass accepts the event.
   * This descriptor is sufficient to resume upload and deterministically build
   * the final event without relying on a mounted composer. */
  media?: {
    ownerId: string;
    /** Copy-on-write source generation. Defaults to clientId for legacy rows. */
    sourceClientId?: string;
    /** Multipart idempotency identity. Replacement allocates a new generation. */
    uploadClientId?: string;
    kind: "image" | "file" | "voice";
    filename: string;
    mime: string;
    size: number;
    eventContent?: Record<string, unknown>;
    completionMeta?: Record<string, unknown>;
    transcribe?: boolean;
    phase?: "acquiring" | "staged";
    acquisition?: {
      provider: "giphy";
      id: string;
      url: string;
      title: string;
      width: number;
      height: number;
    };
  };
}

type StoredOutboxRow = {
  key: string;
  ownerId: string;
  at: number;
  entry?: OutboxEntry;
  /** Tombstone wins over every stale copy of the immutable client ID. */
  acknowledgedAt?: number;
  terminal?: "accepted" | "discarded";
  identity?: TimelineIdentity;
  scope?: { roomId: string; namespace: "event_send" | "held_send" };
  intentHash?: string;
};

type StoredMetaRow = { key: string; value: number };

type MirrorState = {
  entries: OutboxEntry[];
  acknowledgements: Map<string, number>;
};

type MirrorWrite = "written" | "acknowledged" | "failed";
type MirrorAckRecord = {
  acknowledgedAt: number;
  terminal: "accepted" | "discarded";
  roomId?: string;
  namespace?: "event_send" | "held_send";
  intentHash?: string;
};

function operationNamespace(entry: Pick<OutboxEntry, "operation">): "event_send" | "held_send" {
  return entry.operation === "held" ? "held_send" : "event_send";
}

function sameIntentScope(left: OutboxEntry, right: OutboxEntry): boolean {
  return (
    left.roomId === right.roomId &&
    operationNamespace(left) === operationNamespace(right)
  );
}

function assertCompatibleClientScope(current: OutboxEntry, incoming: OutboxEntry): void {
  if (!sameIntentScope(current, incoming)) {
    throw new Error(
      "client id is already queued for a different room or operation namespace",
    );
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    // Renderer/acquisition-only values may change during the crash-safe media
    // handoff but never alter the Glass event intent.
    if (key === "local_url" || key === "acquiring" || key === "phase" || key === "size") {
      continue;
    }
    result[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Canonical payload fingerprint. Tombstones store only this digest, never
 * message text or media URLs. Two independent seeded lanes make accidental
 * corruption collisions vanishingly unlikely while keeping ack writes sync. */
function intentHash(entry: OutboxEntry): string {
  const canonical = JSON.stringify(canonicalValue({
    roomId: entry.roomId,
    namespace: operationNamespace(entry),
    type: entry.type ?? "m.text",
    body: entry.body,
    content: entry.content ?? {},
    replyTo: entry.replyTo ?? "",
    releaseAt: entry.releaseAt ?? "",
    media: entry.media
      ? {
          ownerId: entry.media.ownerId,
          sourceClientId: entry.media.sourceClientId ?? entry.clientId,
          uploadClientId: entry.media.uploadClientId ?? entry.clientId,
          kind: entry.media.kind,
          filename: entry.media.filename,
          mime: entry.media.mime,
          eventContent: entry.media.eventContent ?? {},
          completionMeta: entry.media.completionMeta ?? {},
          transcribe: entry.media.transcribe ?? false,
          acquisition: entry.media.acquisition ?? null,
        }
      : null,
  }));
  return `${hash32(canonical, 0x811c9dc5)}${hash32(canonical, 0x9e3779b9)}`;
}

function sameTimelineBinding(left: OutboxEntry, right: OutboxEntry): boolean {
  return (
    left.clientId === right.clientId &&
    left.at === right.at &&
    left.localKey === right.localKey &&
    left.localSequence === right.localSequence &&
    left.originDevice === right.originDevice &&
    left.localCreatedAt === right.localCreatedAt
  );
}

/** Validate an intentional payload revision across the two durability layers.
 * A newer row names the exact predecessor hash and a closed correction action;
 * arbitrary changed bytes still fail closed as client-ID reuse. */
function isAuthorizedCorrectionTransition(
  previous: OutboxEntry,
  next: OutboxEntry,
): boolean {
  const correction = next.correction;
  if (
    !correction ||
    correction.priorIntentHash !== intentHash(previous) ||
    revision(next) <= revision(previous) ||
    !sameIntentScope(previous, next) ||
    !sameTimelineBinding(previous, next)
  ) {
    return false;
  }
  if (correction.action === "remove_reply") {
    return Boolean(previous.replyTo) &&
      !next.replyTo &&
      intentHash({ ...previous, replyTo: undefined }) === intentHash(next);
  }
  if (correction.action === "edit_message" || correction.action === "review_input") {
    const withoutText = (entry: OutboxEntry): OutboxEntry => ({
      ...entry,
      body: "",
      content: { ...(entry.content ?? {}), body: "", caption: "" },
      media: entry.media
        ? {
            ...entry.media,
            eventContent: {
              ...(entry.media.eventContent ?? {}),
              body: "",
              caption: "",
            },
          }
        : undefined,
    });
    return previous.type === next.type &&
      previous.operation === next.operation &&
      intentHash(withoutText(previous)) === intentHash(withoutText(next));
  }
  if (correction.action === "replace_attachment") {
    const attachmentKeys = new Set([
      "acquiring",
      "duration_ms",
      "filename",
      "height",
      "local_url",
      "media_id",
      "mime",
      "size",
      "waveform",
      "width",
    ]);
    const withoutAttachmentFields = (value?: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value ?? {}).filter(([key]) => !attachmentKeys.has(key)),
      );
    const withoutAttachment = (entry: OutboxEntry): OutboxEntry => ({
      ...entry,
      type: "m.file",
      content: withoutAttachmentFields(entry.content),
      media: entry.media
        ? {
            ...entry.media,
            sourceClientId: "",
            uploadClientId: "",
            kind: "file",
            filename: "",
            mime: "",
            size: 0,
            eventContent: withoutAttachmentFields(entry.media.eventContent),
            completionMeta: withoutAttachmentFields(entry.media.completionMeta),
            transcribe: false,
            phase: "staged",
            acquisition: undefined,
          }
        : undefined,
    });
    return previous.operation === "media" &&
      next.operation === "media" &&
      intentHash(withoutAttachment(previous)) === intentHash(withoutAttachment(next));
  }
  if (correction.action === "restart_upload") {
    const withoutUploadIdentity = (entry: OutboxEntry): OutboxEntry => ({
      ...entry,
      media: entry.media ? { ...entry.media, uploadClientId: "" } : undefined,
    });
    return previous.operation === "media" &&
      next.operation === "media" &&
      intentHash(withoutUploadIdentity(previous)) ===
        intentHash(withoutUploadIdentity(next));
  }
  return intentHash(previous) === intentHash(next);
}

function legacyKey(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function mirrorIntentPrefix(ownerId: string): string {
  return `${PREFIX}:${MIRROR_VERSION}:intent:${encodeURIComponent(ownerId)}:`;
}

function mirrorIntentKey(ownerId: string, clientId: string): string {
  return `${mirrorIntentPrefix(ownerId)}${encodeURIComponent(clientId)}`;
}

function mirrorAckPrefix(ownerId: string): string {
  return `${PREFIX}:${MIRROR_VERSION}:ack:${encodeURIComponent(ownerId)}:`;
}

function mirrorAckKey(ownerId: string, clientId: string): string {
  return `${mirrorAckPrefix(ownerId)}${encodeURIComponent(clientId)}`;
}

function parseEntry(value: unknown): OutboxEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as OutboxEntry;
  if (
    typeof entry.roomId !== "string" ||
    typeof entry.clientId !== "string" ||
    typeof entry.body !== "string" ||
    typeof entry.at !== "number" ||
    (entry.traceparent != null && !validTraceparent(entry.traceparent)) ||
    (entry.operation != null &&
      entry.operation !== "event" &&
      entry.operation !== "held" &&
      entry.operation !== "media") ||
    (entry.type != null && typeof entry.type !== "string") ||
    (entry.localKey != null && typeof entry.localKey !== "string") ||
    (entry.localSequence != null &&
      (typeof entry.localSequence !== "number" ||
        !Number.isSafeInteger(entry.localSequence) ||
        entry.localSequence < 0)) ||
    (entry.originDevice != null && typeof entry.originDevice !== "string") ||
    (entry.localCreatedAt != null && typeof entry.localCreatedAt !== "string") ||
    (entry.content != null && typeof entry.content !== "object") ||
    (entry.releaseAt != null && typeof entry.releaseAt !== "string") ||
    (entry.state != null &&
      entry.state !== "queued" &&
      entry.state !== "resolving" &&
      entry.state !== "retry_wait" &&
      entry.state !== "blocked" &&
      entry.state !== "challenge") ||
    (entry.attempts != null && typeof entry.attempts !== "number") ||
    (entry.nextAttemptAt != null && typeof entry.nextAttemptAt !== "number") ||
    (entry.lastError != null && typeof entry.lastError !== "string") ||
    (entry.correction != null &&
      (typeof entry.correction !== "object" ||
        !isCorrectionAction(entry.correction.action) ||
        typeof entry.correction.appliedAt !== "number" ||
        !Number.isFinite(entry.correction.appliedAt) ||
        typeof entry.correction.priorIntentHash !== "string" ||
        !/^[0-9a-f]{16}$/.test(entry.correction.priorIntentHash))) ||
    (entry.challenge != null &&
      (typeof entry.challenge !== "object" || typeof entry.challenge.token !== "string")) ||
    (entry.updatedAt != null && typeof entry.updatedAt !== "number")
  ) {
    return null;
  }
  if (
    entry.media != null &&
    (typeof entry.media !== "object" ||
      typeof entry.media.ownerId !== "string" ||
      (entry.media.sourceClientId != null &&
        typeof entry.media.sourceClientId !== "string") ||
      (entry.media.uploadClientId != null &&
        typeof entry.media.uploadClientId !== "string") ||
      !["image", "file", "voice"].includes(entry.media.kind) ||
      typeof entry.media.filename !== "string" ||
      typeof entry.media.mime !== "string" ||
      typeof entry.media.size !== "number" ||
      (entry.media.eventContent != null && typeof entry.media.eventContent !== "object") ||
      (entry.media.completionMeta != null && typeof entry.media.completionMeta !== "object") ||
      (entry.media.transcribe != null && typeof entry.media.transcribe !== "boolean") ||
      (entry.media.phase != null &&
        entry.media.phase !== "acquiring" &&
        entry.media.phase !== "staged") ||
      (entry.media.acquisition != null &&
        (typeof entry.media.acquisition !== "object" ||
          entry.media.acquisition.provider !== "giphy" ||
          typeof entry.media.acquisition.id !== "string" ||
          typeof entry.media.acquisition.url !== "string" ||
          typeof entry.media.acquisition.title !== "string" ||
          typeof entry.media.acquisition.width !== "number" ||
          typeof entry.media.acquisition.height !== "number")))
  ) {
    return null;
  }
  if (entry.operation === "media" && !entry.media) return null;
  if (entry.failure != null && !isSendFailureRecord(entry.failure)) {
    // Recovery metadata is mutable and must never be allowed to erase the
    // immutable user intent. Retain the row but fail closed: no automatic POST
    // is permitted until the user reviews it or a trusted repair rewrites the
    // structured failure record.
    return {
      ...entry,
      state: "blocked",
      nextAttemptAt: 0,
      lastError: "This saved send has invalid recovery metadata.",
      failure: undefined,
      challenge: undefined,
    };
  }
  return entry;
}

function revision(entry: OutboxEntry): number {
  return entry.updatedAt ?? entry.at;
}

function storageKeys(): string[] {
  if (typeof window === "undefined") return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const candidate = window.localStorage.key(index);
      if (candidate) keys.push(candidate);
    }
  } catch {
    // The caller will still be able to use IndexedDB.
  }
  return keys;
}

function readLegacyEntries(ownerId: string): OutboxEntry[] {
  try {
    const raw = window.localStorage.getItem(legacyKey(ownerId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseEntry).filter((entry): entry is OutboxEntry => entry != null);
  } catch {
    reportStorageIssue({
      severity: "degraded",
      area: "outbox",
      message:
        "The legacy recovery mirror for outgoing messages is unreadable; its original bytes were left untouched.",
    });
    return [];
  }
}

function hasMirrorAck(ownerId: string, clientId: string): boolean {
  try {
    return window.localStorage.getItem(mirrorAckKey(ownerId, clientId)) != null;
  } catch {
    return false;
  }
}

function readMirrorAck(ownerId: string, clientId: string): MirrorAckRecord | null {
  try {
    const raw = window.localStorage.getItem(mirrorAckKey(ownerId, clientId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<MirrorAckRecord>;
      if (typeof parsed.acknowledgedAt === "number") {
        return {
          acknowledgedAt: parsed.acknowledgedAt,
          terminal: parsed.terminal === "discarded" ? "discarded" : "accepted",
          ...(typeof parsed.roomId === "string" ? { roomId: parsed.roomId } : {}),
          ...(parsed.namespace === "event_send" || parsed.namespace === "held_send"
            ? { namespace: parsed.namespace }
            : {}),
          ...(typeof parsed.intentHash === "string" && parsed.intentHash
            ? { intentHash: parsed.intentHash }
            : {}),
        };
      }
    } catch {
      // Legacy acknowledgements stored the timestamp as a plain string.
    }
    const timestamp = Number(raw);
    return {
      acknowledgedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      terminal: "accepted",
    };
  } catch {
    return null;
  }
}

function assertMirrorAckCompatible(
  record: MirrorAckRecord,
  entry: OutboxEntry,
  hash: string,
): void {
  if (!record.roomId || !record.namespace || !record.intentHash) {
    throw new Error(
      "legacy acknowledgement has ambiguous client scope or payload; allocate a new client id",
    );
  }
  if (
    record.roomId !== entry.roomId ||
    record.namespace !== operationNamespace(entry)
  ) {
    throw new Error(
      "client id was already acknowledged for a different room or operation namespace",
    );
  }
  if (record.intentHash !== hash) {
    throw new Error("client id was already acknowledged for a different payload");
  }
}

function readMirrorIntent(ownerId: string, clientId: string): OutboxEntry | null {
  try {
    const raw = window.localStorage.getItem(mirrorIntentKey(ownerId, clientId));
    return raw ? parseEntry(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeMirrorIntent(ownerId: string, entry: OutboxEntry): MirrorWrite {
  if (typeof window === "undefined" || !ownerId) return "failed";
  if (hasMirrorAck(ownerId, entry.clientId)) return "acknowledged";
  try {
    window.localStorage.setItem(mirrorIntentKey(ownerId, entry.clientId), JSON.stringify(entry));
    // An acknowledgement may have raced the write in a browser without Web
    // Locks. It lives under a different key and always wins during reads.
    return hasMirrorAck(ownerId, entry.clientId) ? "acknowledged" : "written";
  } catch {
    return "failed";
  }
}

function writeMirrorAck(
  ownerId: string,
  clientId: string,
  acknowledgedAt: number,
  scope?: { roomId: string; namespace: "event_send" | "held_send" },
  hash?: string,
  terminal: "accepted" | "discarded" = "accepted",
): boolean {
  try {
    const existing = readMirrorAck(ownerId, clientId);
    if (
      existing?.roomId &&
      existing.namespace &&
      scope &&
      (existing.roomId !== scope.roomId || existing.namespace !== scope.namespace)
    ) {
      return false;
    }
    if (existing?.intentHash && hash && existing.intentHash !== hash) return false;
    const resolvedScope = scope ??
      (existing?.roomId && existing.namespace
        ? { roomId: existing.roomId, namespace: existing.namespace }
        : undefined);
    const resolvedHash = hash ?? existing?.intentHash;
    const resolvedTerminal =
      existing?.terminal === "accepted" || terminal === "accepted"
        ? "accepted"
        : "discarded";
    window.localStorage.setItem(
      mirrorAckKey(ownerId, clientId),
      JSON.stringify({
        acknowledgedAt: Math.max(acknowledgedAt, existing?.acknowledgedAt ?? 0),
        terminal: resolvedTerminal,
        ...resolvedScope,
        ...(resolvedHash ? { intentHash: resolvedHash } : {}),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function removeMirrorIntent(ownerId: string, clientId: string): void {
  try {
    window.localStorage.removeItem(mirrorIntentKey(ownerId, clientId));
  } catch {
    // The separate acknowledgement key continues to shadow these bytes.
  }
}

/** Read and opportunistically migrate the old owner-wide array. Migration is
 * copy-first: the legacy key is removed only after every unacknowledged item
 * has its own committed per-client key. */
function readMirror(ownerId: string): MirrorState {
  if (typeof window === "undefined" || !ownerId) {
    return { entries: [], acknowledgements: new Map() };
  }
  const entries = new Map<string, OutboxEntry>();
  const acknowledgements = new Map<string, number>();
  const intentPrefix = mirrorIntentPrefix(ownerId);
  const ackPrefix = mirrorAckPrefix(ownerId);

  for (const storageKey of storageKeys()) {
    if (storageKey.startsWith(ackPrefix)) {
      try {
        const clientId = decodeURIComponent(storageKey.slice(ackPrefix.length));
        const record = readMirrorAck(ownerId, clientId);
        acknowledgements.set(clientId, record?.acknowledgedAt ?? Date.now());
      } catch {
        // Ignore only this malformed tombstone.
      }
      continue;
    }
    if (!storageKey.startsWith(intentPrefix)) continue;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const entry = raw ? parseEntry(JSON.parse(raw) as unknown) : null;
      if (entry) entries.set(entry.clientId, entry);
    } catch {
      reportStorageIssue({
        severity: "degraded",
        area: "outbox",
        message:
          "One outgoing recovery row is unreadable; it was retained for a later recovery attempt.",
      });
    }
  }

  const legacy = readLegacyEntries(ownerId);
  let migrationComplete = true;
  for (const entry of legacy) {
    if (acknowledgements.has(entry.clientId) || hasMirrorAck(ownerId, entry.clientId)) continue;
    const current = entries.get(entry.clientId);
    const winner = !current || revision(entry) > revision(current) ? entry : current;
    entries.set(entry.clientId, winner);
    if (winner === entry) {
      const result = writeMirrorIntent(ownerId, entry);
      if (result === "failed") migrationComplete = false;
      if (result === "acknowledged") {
        entries.delete(entry.clientId);
        acknowledgements.set(entry.clientId, Date.now());
      }
    }
  }
  if (legacy.length > 0 && migrationComplete) {
    try {
      window.localStorage.removeItem(legacyKey(ownerId));
    } catch {
      // Keeping the legacy copy is harmless; per-client revisions win.
    }
  }

  for (const clientId of acknowledgements.keys()) entries.delete(clientId);
  return {
    entries: [...entries.values()].sort((left, right) => left.at - right.at),
    acknowledgements,
  };
}

type OutboxPatch = Partial<
  Pick<
    OutboxEntry,
    | "state"
    | "attempts"
    | "nextAttemptAt"
    | "lastError"
    | "challenge"
    | "content"
    | "media"
    | "localKey"
    | "localSequence"
    | "originDevice"
    | "localCreatedAt"
    | "failure"
    | "correction"
    | "replyTo"
    | "body"
    | "type"
  >
>;

function updateMirror(
  ownerId: string,
  clientId: string,
  patch: OutboxPatch,
  updatedAt: number,
): MirrorWrite {
  if (hasMirrorAck(ownerId, clientId)) return "acknowledged";
  const current = readMirrorIntent(ownerId, clientId) ??
    readLegacyEntries(ownerId).find((entry) => entry.clientId === clientId) ??
    null;
  if (!current) return "failed";
  return writeMirrorIntent(ownerId, { ...current, ...patch, updatedAt });
}

function liveMirrorEntries(ownerId: string, entries: OutboxEntry[]): OutboxEntry[] {
  return entries.filter((entry) => {
    if (!hasMirrorAck(ownerId, entry.clientId)) return true;
    removeMirrorIntent(ownerId, entry.clientId);
    return false;
  });
}

async function ensureEntryIdentities(
  ownerId: string,
  entries: OutboxEntry[],
  durableAuthority = false,
): Promise<OutboxEntry[]> {
  return Promise.all(entries.map(async (entry) => {
    if (
      entry.localKey &&
      typeof entry.localSequence === "number" &&
      entry.originDevice &&
      entry.localCreatedAt &&
      validTraceparent(entry.traceparent)
    ) {
      const fields = {
        localKey: entry.localKey,
        localSequence: entry.localSequence,
        originDevice: entry.originDevice,
        localCreatedAt: entry.localCreatedAt,
      };
      if (durableAuthority) {
        restoreDurableTimelineIdentity(ownerId, {
          clientId: entry.clientId,
          ...fields,
        });
      } else {
        identityFromPersistedFields(ownerId, entry.clientId, fields);
      }
      return entry;
    }
    // Upgrade legacy live rows in place before exposing them to the renderer or
    // flusher. enqueueOutbox preserves the immutable client/payload and writes
    // the new identity to both durability layers before any retry may POST.
    return enqueueOutbox(ownerId, entry);
  }));
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : request.result.createObjectStore(STORE, { keyPath: "key" });
      if (!store.indexNames.contains("ownerAt")) {
        store.createIndex("ownerAt", ["ownerId", "at"]);
      }
      if (!request.result.objectStoreNames.contains(META)) {
        request.result.createObjectStore(META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  dbPromise = opening;
  // Private-mode/storage-policy failures can be transient. Never memoize a
  // rejected open forever or a recovered browser would remain mirror-only.
  void opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function done(transaction: IDBTransaction): Promise<void> {
  const completion = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  // Request.onerror and transaction.onabort often fire together. A caller may
  // leave the transaction await early because the request already failed; keep
  // that second rejection observed without changing what `await completion`
  // reports to callers that reach it.
  void completion.catch(() => undefined);
  return completion;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function persistedIdentity(entry: OutboxEntry): TimelineIdentity | null {
  if (
    !entry.localKey ||
    typeof entry.localSequence !== "number" ||
    !Number.isSafeInteger(entry.localSequence) ||
    !entry.originDevice ||
    !entry.localCreatedAt
  ) {
    return null;
  }
  return {
    clientId: entry.clientId,
    localKey: entry.localKey,
    localSequence: entry.localSequence,
    originDevice: entry.originDevice,
    localCreatedAt: entry.localCreatedAt,
  };
}

function withIdentity(entry: OutboxEntry, identity: TimelineIdentity): OutboxEntry {
  return {
    ...entry,
    localKey: identity.localKey,
    localSequence: identity.localSequence,
    originDevice: identity.originDevice,
    localCreatedAt: identity.localCreatedAt,
    updatedAt: Date.now(),
  };
}

async function enqueueOutboxUninstrumented(ownerId: string, entry: OutboxEntry): Promise<OutboxEntry> {
  if (typeof window === "undefined" || !ownerId) return entry;
  const mirrorCurrent =
    readMirrorIntent(ownerId, entry.clientId) ??
    readLegacyEntries(ownerId).find((candidate) => candidate.clientId === entry.clientId) ??
    null;
  entry = {
    ...entry,
    traceparent:
      validTraceparent(mirrorCurrent?.traceparent) ||
      validTraceparent(entry.traceparent) ||
      newTraceparent(),
  };
  const incomingIntentHash = intentHash(entry);
  if (mirrorCurrent) {
    assertCompatibleClientScope(mirrorCurrent, entry);
    if (intentHash(mirrorCurrent) !== incomingIntentHash) {
      throw new Error("client id was reused with a changed immutable payload");
    }
  }
  const mirrorAck = readMirrorAck(ownerId, entry.clientId);
  if (mirrorAck) {
    assertMirrorAckCompatible(mirrorAck, entry, incomingIntentHash);
  }

  const requestedIdentity = persistedIdentity(entry);
  const originDevice = requestedIdentity?.originDevice ??
    authStore.getBoundDeviceId() ??
    deviceId();

  const persistMirrorFallback = async (): Promise<OutboxEntry> => {
    const identity = requestedIdentity
      ? identityFromPersistedFields(ownerId, entry.clientId, {
          localKey: requestedIdentity.localKey,
          localSequence: requestedIdentity.localSequence,
          originDevice: requestedIdentity.originDevice,
          localCreatedAt: requestedIdentity.localCreatedAt,
        })
      : await allocateTimelineIdentity(
          ownerId,
          entry.clientId,
          originDevice,
          entry.at,
        );
    const persistedEntry = withIdentity(entry, identity);
    const mirrorResult = writeMirrorIntent(ownerId, persistedEntry);
    if (mirrorResult === "failed") {
      reportStorageIssue({
        severity: "blocked",
        area: "outbox",
        message:
          "No durable browser storage is available. The composer was not cleared and this message was not sent.",
      });
      throw new Error("Unable to persist the outgoing message");
    }
    if (mirrorResult === "acknowledged") {
      const racedAck = readMirrorAck(ownerId, entry.clientId);
      if (!racedAck) throw new Error("outbox acknowledgement disappeared during enqueue");
      assertMirrorAckCompatible(racedAck, entry, incomingIntentHash);
      removeMirrorIntent(ownerId, entry.clientId);
    }
    reportStorageIssue({
      severity: "degraded",
      area: "outbox",
      message:
        "IndexedDB is unavailable. Outgoing text is preserved in the per-message recovery journal, but media sends are disabled until browser storage recovers.",
    });
    return persistedEntry;
  };

  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return persistMirrorFallback();
  }

  let persistedEntry: OutboxEntry | null = null;
  let committedIdentity: TimelineIdentity | null = null;
  let acknowledged = hasMirrorAck(ownerId, entry.clientId);
  try {
    // The Lamport counter and the new outbox row share one strict transaction.
    // A crash can commit both or neither; there is no IDB state containing an
    // optimistic identity without its immutable send intent (or vice versa).
    const transaction = db.transaction([STORE, META], "readwrite", {
      durability: "strict",
    });
    const completion = done(transaction);
    const store = transaction.objectStore(STORE);
    const meta = transaction.objectStore(META);
    const rowKey = `${ownerId}:${entry.clientId}`;
    const sequenceKey = `sequence:${ownerId}:${originDevice}`;
    const rowRequest = store.get(rowKey);
    const sequenceRequest = meta.get(sequenceKey);
    const [current, sequenceRow] = await Promise.all([
      requestResult(rowRequest) as Promise<StoredOutboxRow | undefined>,
      requestResult(sequenceRequest) as Promise<StoredMetaRow | undefined>,
    ]);
    const durableTraceparent = validTraceparent(current?.entry?.traceparent);
    if (durableTraceparent && durableTraceparent !== entry.traceparent) {
      entry = { ...entry, traceparent: durableTraceparent };
    }
    if (current?.entry) {
      assertCompatibleClientScope(current.entry, entry);
      const currentHash = current.intentHash ?? intentHash(current.entry);
      if (currentHash !== incomingIntentHash) {
        transaction.abort();
        throw new Error("client id was reused with a changed immutable payload");
      }
    }
    if (
      current?.acknowledgedAt &&
      (!current.scope ||
        !current.intentHash ||
        current.scope.roomId !== entry.roomId ||
        current.scope.namespace !== operationNamespace(entry) ||
        current.intentHash !== incomingIntentHash)
    ) {
      transaction.abort();
      throw new Error(
        "client id was already acknowledged with ambiguous or different scope",
      );
    }
    if (current?.acknowledgedAt || acknowledged) {
      acknowledged = true;
      committedIdentity = current?.identity ?? requestedIdentity ??
        readTimelineIdentity(ownerId, entry.clientId);
      persistedEntry = committedIdentity ? withIdentity(entry, committedIdentity) : entry;
    } else {
      const currentIdentity = current?.entry ? persistedIdentity(current.entry) : null;
      const rememberedIdentity = readTimelineIdentity(ownerId, entry.clientId);
      const identity = currentIdentity ?? requestedIdentity ?? rememberedIdentity;
      if (identity && identity.originDevice !== originDevice) {
        transaction.abort();
        throw new Error("timeline client id is already bound to another device");
      }
      if (currentIdentity && requestedIdentity && (
        currentIdentity.localKey !== requestedIdentity.localKey ||
        currentIdentity.localSequence !== requestedIdentity.localSequence ||
        currentIdentity.originDevice !== requestedIdentity.originDevice ||
        currentIdentity.localCreatedAt !== requestedIdentity.localCreatedAt
      )) {
        transaction.abort();
        throw new Error("timeline client id was reused with a changed immutable identity");
      }
      const lastSequence =
        sequenceRow && Number.isSafeInteger(sequenceRow.value) ? sequenceRow.value : -1;
      committedIdentity = identity ?? makeTimelineIdentity(
        entry.clientId,
        originDevice,
        Math.max(lastSequence + 1, timelineSequenceFloor(entry.at)),
        entry.at,
      );
      meta.put({
        key: sequenceKey,
        value: Math.max(lastSequence, committedIdentity.localSequence),
      } satisfies StoredMetaRow);
      persistedEntry = withIdentity(entry, committedIdentity);
      store.put({
        key: rowKey,
        ownerId,
        at: entry.at,
        entry: persistedEntry,
        intentHash: incomingIntentHash,
      } satisfies StoredOutboxRow);
    }
    await completion;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("different room or operation namespace") ||
        error.message.includes("acknowledged with ambiguous or different scope") ||
        error.message.includes("changed immutable payload") ||
        error.message.includes("changed immutable identity") ||
        error.message.includes("another device"))
    ) {
      throw error;
    }
    reportStorageIssue({
      severity: "degraded",
      area: "outbox",
      message:
        "The IndexedDB outbox failed, so this outgoing message remains in its recovery journal until storage recovers.",
    });
    return persistMirrorFallback();
  }

  if (!persistedEntry) throw new Error("Unable to persist the outgoing message");
  if (committedIdentity) restoreDurableTimelineIdentity(ownerId, committedIdentity);
  if (acknowledged) {
    writeMirrorAck(
      ownerId,
      entry.clientId,
      Date.now(),
      { roomId: entry.roomId, namespace: operationNamespace(entry) },
      incomingIntentHash,
    );
    removeMirrorIntent(ownerId, entry.clientId);
    clearStorageIssue("outbox");
    return persistedEntry;
  }
  const mirrorResult = writeMirrorIntent(ownerId, persistedEntry);
  if (mirrorResult === "acknowledged") {
    const racedAck = readMirrorAck(ownerId, entry.clientId);
    if (!racedAck) throw new Error("outbox acknowledgement disappeared during enqueue");
    assertMirrorAckCompatible(racedAck, entry, incomingIntentHash);
    removeMirrorIntent(ownerId, entry.clientId);
  }
  clearStorageIssue("outbox");
  return persistedEntry;
}

export async function enqueueOutbox(ownerId: string, entry: OutboxEntry): Promise<OutboxEntry> {
  if (typeof window === "undefined" || !ownerId) {
    return enqueueOutboxUninstrumented(ownerId, entry);
  }
  const finish = beginClientDurableCommit("send");
  try {
    const committed = await enqueueOutboxUninstrumented(ownerId, entry);
    finish(true);
    return committed;
  } catch (error) {
    finish(false);
    throw error;
  }
}

/** Return the trace root from the durable authority. Missing legacy metadata is
 * upgraded and committed before the caller may issue its network request. */
export async function outboxTraceparent(ownerId: string, clientId: string): Promise<string> {
  const entry = (await listOutbox(ownerId)).find((candidate) => candidate.clientId === clientId);
  return validTraceparent(entry?.traceparent);
}

/** Record authoritative server acceptance. Local cleanup is deliberately
 * non-throwing: an accepted send stays successful in the UI even when browser
 * storage is sick. At least one tombstone is attempted before intent cleanup;
 * if neither commits, the original intent remains safe to replay idempotently. */
async function tombstoneOutbox(
  ownerId: string,
  clientId: string,
  accepted?: { roomId: string; event: Event },
  terminal: "accepted" | "discarded" = "accepted",
): Promise<boolean> {
  if (typeof window === "undefined" || !ownerId) return false;
  if (accepted) {
    // Commit the event+local alias before replacing the send intent with an
    // acknowledgement tombstone. If the cache is unavailable, retain the
    // idempotent outbox row; replay is safer than losing stable identity.
    const identity = bindAcceptedTimelineEvent(ownerId, clientId, accepted.event);
    if (!identity) return false;
    try {
      await storeEvents(ownerId, [
        { roomId: accepted.roomId, event: accepted.event },
      ]);
    } catch {
      return false;
    }
  }
  const knownIdentity = readTimelineIdentity(ownerId, clientId);
  const pendingMirror = readMirrorIntent(ownerId, clientId);
  let pendingPrimary: OutboxEntry | null = null;
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readonly");
    const row = await requestResult(
      transaction.objectStore(STORE).get(`${ownerId}:${clientId}`),
    ) as StoredOutboxRow | undefined;
    pendingPrimary = row?.entry && !row.acknowledgedAt ? parseEntry(row.entry) : null;
  } catch {
    // The recovery mirror remains sufficient to write a scoped tombstone.
  }
  let knownPending = pendingPrimary ?? pendingMirror;
  if (pendingPrimary && pendingMirror) {
    assertCompatibleClientScope(pendingPrimary, pendingMirror);
    if (intentHash(pendingPrimary) !== intentHash(pendingMirror)) {
      if (
        !isAuthorizedCorrectionTransition(pendingPrimary, pendingMirror) &&
        !isAuthorizedCorrectionTransition(pendingMirror, pendingPrimary)
      ) {
        return false;
      }
      knownPending = revision(pendingPrimary) >= revision(pendingMirror)
        ? pendingPrimary
        : pendingMirror;
    }
  }
  let knownIntentHash = knownPending ? intentHash(knownPending) : undefined;
  let knownScope = accepted
    ? { roomId: accepted.roomId, namespace: "event_send" as const }
    : knownPending
      ? {
          roomId: knownPending.roomId,
          namespace: operationNamespace(knownPending),
        }
      : undefined;
  const acknowledgedAt = Date.now();
  let mirrorAcked = writeMirrorAck(
    ownerId,
    clientId,
    acknowledgedAt,
    knownScope,
    knownIntentHash,
    terminal,
  );
  let idbAcked = false;

  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    const store = transaction.objectStore(STORE);
    const current = await requestResult(
      store.get(`${ownerId}:${clientId}`),
    ) as StoredOutboxRow | undefined;
    const tombstoneIdentity = knownIdentity ??
      current?.identity ??
      (current?.entry ? persistedIdentity(current.entry) : null);
    knownScope = knownScope ?? current?.scope ?? (current?.entry
      ? {
          roomId: current.entry.roomId,
          namespace: operationNamespace(current.entry),
        }
      : undefined);
    knownIntentHash = knownIntentHash ?? current?.intentHash ??
      (current?.entry ? intentHash(current.entry) : undefined);
    store.put({
      key: `${ownerId}:${clientId}`,
      ownerId,
      at: acknowledgedAt,
      acknowledgedAt,
      terminal,
      ...(tombstoneIdentity ? { identity: tombstoneIdentity } : {}),
      ...(knownScope ? { scope: knownScope } : {}),
      ...(knownIntentHash ? { intentHash: knownIntentHash } : {}),
    } satisfies StoredOutboxRow);
    await done(transaction);
    idbAcked = true;
    if (knownScope) {
      mirrorAcked = writeMirrorAck(
        ownerId,
        clientId,
        acknowledgedAt,
        knownScope,
        knownIntentHash,
        terminal,
      ) || mirrorAcked;
    }
  } catch {
    reportStorageIssue({
      severity: "degraded",
      area: "outbox",
      message: terminal === "accepted"
        ? mirrorAcked
          ? "The server accepted a message. Its recovery acknowledgement is safe, and IndexedDB cleanup will retry."
          : "The server accepted a message, but local cleanup could not be recorded. Its unchanged client ID makes any recovery replay idempotent."
        : mirrorAcked
          ? "The local discard is safe, and IndexedDB cleanup will retry."
          : "The local discard could not be recorded, so the saved message remains visible.",
    });
  }

  if (mirrorAcked || idbAcked) removeMirrorIntent(ownerId, clientId);
  if (!mirrorAcked && !idbAcked) {
    // Do not remove any legacy or IndexedDB intent. Replay is safer than loss.
    return false;
  }
  return true;
}

export async function ackOutbox(
  ownerId: string,
  clientId: string,
  accepted?: { roomId: string; event: Event },
): Promise<boolean> {
  return tombstoneOutbox(ownerId, clientId, accepted, "accepted");
}

/** Explicit local discard is a distinct terminal fact, never an acceptance.
 * The body-free scoped tombstone commits before callers may hide the bubble or
 * remove retained media bytes. */
export async function discardOutbox(
  ownerId: string,
  clientId: string,
): Promise<boolean> {
  const pending = (await listOutbox(ownerId)).find((entry) => entry.clientId === clientId);
  if (
    !pending ||
    (pending.state !== "blocked" && pending.state !== "challenge") ||
    !pending.failure?.correctionActions.includes("discard_local")
  ) {
    return false;
  }
  return tombstoneOutbox(ownerId, clientId, undefined, "discarded");
}

/** Update retry metadata only while the entry still exists. A separate mirror
 * acknowledgement key and the IndexedDB tombstone both prevent resurrection. */
export async function updateOutbox(
  ownerId: string,
  clientId: string,
  patch: OutboxPatch,
): Promise<boolean> {
  if (typeof window === "undefined" || !ownerId || hasMirrorAck(ownerId, clientId)) return false;
  const updatedAt = Math.max(
    Date.now(),
    patch.correction?.appliedAt ?? 0,
  );
  let updated = false;
  let idbMutationAttempted = false;
  let acknowledged = false;
  let acknowledgedScope: StoredOutboxRow["scope"];
  let acknowledgedHash: string | undefined;
  let acknowledgedTerminal: StoredOutboxRow["terminal"];

  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    const completion = done(transaction);
    const store = transaction.objectStore(STORE);
    const request = store.get(`${ownerId}:${clientId}`);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const row = request.result as StoredOutboxRow | undefined;
        if (row?.acknowledgedAt) {
          acknowledged = true;
          acknowledgedScope = row.scope;
          acknowledgedHash = row.intentHash;
          acknowledgedTerminal = row.terminal;
        } else if (row?.entry) {
          row.entry = { ...row.entry, ...patch, updatedAt };
          row.intentHash = intentHash(row.entry);
          store.put(row);
          idbMutationAttempted = true;
        }
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    await completion;
    updated = idbMutationAttempted;
  } catch {
    // A request callback is not a commit. An abort after store.put must not
    // authorize a POST when the recovery mirror also failed.
    updated = false;
    // The mirror mutation below may still make the retry state durable.
  }

  if (acknowledged) {
    writeMirrorAck(
      ownerId,
      clientId,
      updatedAt,
      acknowledgedScope,
      acknowledgedHash,
      acknowledgedTerminal ?? "accepted",
    );
    removeMirrorIntent(ownerId, clientId);
    return false;
  }
  const mirrorResult = updateMirror(ownerId, clientId, patch, updatedAt);
  if (mirrorResult === "acknowledged") return false;
  return updated || mirrorResult === "written";
}

export type OutboxCorrectionPatch = Partial<
  Pick<
    OutboxEntry,
    | "body"
    | "type"
    | "content"
    | "replyTo"
    | "media"
    | "state"
    | "nextAttemptAt"
    | "failure"
    | "challenge"
    | "lastError"
  >
>;

/** Commit an enumerated correction to the same scoped row. The predecessor
 * hash makes a one-layer crash recoverable without accepting arbitrary client
 * ID/payload reuse. Callers may update UI or wake network only after this
 * function rereads and verifies the committed revision. */
export async function commitOutboxCorrection(
  ownerId: string,
  clientId: string,
  action: CorrectionAction,
  patch: OutboxCorrectionPatch = {},
): Promise<OutboxEntry> {
  const current = (await listOutbox(ownerId)).find((row) => row.clientId === clientId);
  if (!current) throw new Error("The saved message is no longer pending");
  if (!current.failure?.correctionActions.includes(action)) {
    throw new Error("That recovery action is not valid for this saved message");
  }
  const appliedAt = Math.max(Date.now(), revision(current) + 1);
  const correction = {
    action,
    appliedAt,
    priorIntentHash: intentHash(current),
  } satisfies NonNullable<OutboxEntry["correction"]>;
  const candidate: OutboxEntry = { ...current, ...patch, correction, updatedAt: appliedAt };
  if (
    intentHash(candidate) !== intentHash(current) &&
    !isAuthorizedCorrectionTransition(current, candidate)
  ) {
    throw new Error("That correction would change fields outside its safe scope");
  }
  if (!(await updateOutbox(ownerId, clientId, { ...patch, correction }))) {
    throw new Error("The recovery action could not be saved");
  }
  const committed = (await listOutbox(ownerId)).find((row) => row.clientId === clientId);
  if (
    !committed ||
    committed.correction?.action !== action ||
    committed.correction.appliedAt !== appliedAt
  ) {
    throw new Error("The recovery action could not be verified");
  }
  return committed;
}

/** Used by media cleanup recovery: bytes may be deleted only when one of the
 * two independent acknowledgement tombstones is durably visible. */
export async function isOutboxAcknowledged(
  ownerId: string,
  clientId: string,
): Promise<boolean> {
  if (typeof window === "undefined" || !ownerId) return false;
  const mirror = readMirrorAck(ownerId, clientId);
  if (mirror) return mirror.terminal === "accepted";
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(`${ownerId}:${clientId}`);
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const row = request.result as StoredOutboxRow | undefined;
        resolve(Boolean(row?.acknowledgedAt) && row?.terminal !== "discarded");
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return false;
  }
}

export async function outboxTerminalState(
  ownerId: string,
  clientId: string,
): Promise<"accepted" | "discarded" | null> {
  if (typeof window === "undefined" || !ownerId) return null;
  const mirror = readMirrorAck(ownerId, clientId);
  if (mirror) return mirror.terminal;
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(`${ownerId}:${clientId}`);
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const row = request.result as StoredOutboxRow | undefined;
        resolve(row?.acknowledgedAt ? row.terminal ?? "accepted" : null);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/** Pending entries, oldest first. No age-based deletion: only authoritative
 * acceptance or an explicit user discard may remove an intent. */
export async function listOutbox(ownerId: string): Promise<OutboxEntry[]> {
  if (typeof window === "undefined" || !ownerId) return [];
  const mirror = readMirror(ownerId);
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return ensureEntryIdentities(ownerId, liveMirrorEntries(ownerId, mirror.entries));
  }

  try {
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    const completion = done(transaction);
    const store = transaction.objectStore(STORE);

    // First propagate mirror acknowledgements. Preserve stronger scope/hash/
    // identity already held by IDB when importing a legacy scope-less marker.
    await Promise.all(
      [...mirror.acknowledgements].map(
        ([clientId, acknowledgedAt]) =>
          new Promise<void>((resolve, reject) => {
            const request = store.get(`${ownerId}:${clientId}`);
            request.onsuccess = () => {
              const current = request.result as StoredOutboxRow | undefined;
              const record = readMirrorAck(ownerId, clientId);
              const identity = current?.identity ??
                (current?.entry ? persistedIdentity(current.entry) : null) ??
                readTimelineIdentity(ownerId, clientId);
              const scope = current?.scope ??
                (current?.entry
                  ? {
                      roomId: current.entry.roomId,
                      namespace: operationNamespace(current.entry),
                    }
                  : record?.roomId && record.namespace
                    ? { roomId: record.roomId, namespace: record.namespace }
                    : undefined);
              const hash = current?.intentHash ??
                (current?.entry ? intentHash(current.entry) : undefined) ??
                record?.intentHash;
              store.put({
                key: `${ownerId}:${clientId}`,
                ownerId,
                at: acknowledgedAt,
                acknowledgedAt,
                terminal:
                  record?.terminal === "accepted" ||
                  (current?.acknowledgedAt && current.terminal !== "discarded")
                    ? "accepted"
                    : "discarded",
                ...(identity ? { identity } : {}),
                ...(scope ? { scope } : {}),
                ...(hash ? { intentHash: hash } : {}),
              } satisfies StoredOutboxRow);
              resolve();
            };
            request.onerror = () => reject(request.error);
          }),
      ),
    );

    await Promise.all(
      mirror.entries.map(
        (entry) =>
          new Promise<void>((resolve, reject) => {
            const request = store.get(`${ownerId}:${entry.clientId}`);
            request.onsuccess = () => {
              const current = request.result as StoredOutboxRow | undefined;
              if (current?.acknowledgedAt) {
                writeMirrorAck(
                  ownerId,
                  entry.clientId,
                  current.acknowledgedAt,
                  current.scope,
                  current.intentHash,
                  current.terminal ?? "accepted",
                );
                removeMirrorIntent(ownerId, entry.clientId);
                resolve();
                return;
              }
              if (current?.entry) {
                try {
                  assertCompatibleClientScope(current.entry, entry);
                  if (
                    (current.intentHash ?? intentHash(current.entry)) !== intentHash(entry) &&
                    !isAuthorizedCorrectionTransition(current.entry, entry) &&
                    !isAuthorizedCorrectionTransition(entry, current.entry)
                  ) {
                    throw new Error("client id was reused with a changed immutable payload");
                  }
                } catch (error) {
                  reject(error);
                  return;
                }
              }
              const currentRevision = current?.entry ? revision(current.entry) : -1;
              if (!current?.entry || revision(entry) > currentRevision) {
                store.put({
                  key: `${ownerId}:${entry.clientId}`,
                  ownerId,
                  at: entry.at,
                  entry,
                  intentHash: intentHash(entry),
                } satisfies StoredOutboxRow);
              }
              resolve();
            };
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    await completion;

    const readTransaction = db.transaction(STORE, "readonly");
    const index = readTransaction.objectStore(STORE).index("ownerAt");
    const range = IDBKeyRange.bound([ownerId, 0], [ownerId, Number.MAX_SAFE_INTEGER]);
    const entries = await new Promise<OutboxEntry[]>((resolve, reject) => {
      const request = index.getAll(range);
      request.onsuccess = () => {
        const parsed = (request.result as StoredOutboxRow[])
            .filter(
              (row): row is StoredOutboxRow & { entry: OutboxEntry } => {
                if (!row.entry || row.acknowledgedAt) return false;
                // An acknowledgement can commit in another tab after the
                // initial mirror snapshot but before this readonly result.
                // Recheck the independent tombstone key at the last possible
                // moment so list/import can never expose the stale intent.
                if (
                  mirror.acknowledgements.has(row.entry.clientId) ||
                  hasMirrorAck(ownerId, row.entry.clientId)
                ) {
                  removeMirrorIntent(ownerId, row.entry.clientId);
                  return false;
                }
                return true;
              },
            )
            .map((row) => parseEntry(row.entry))
            .filter((entry): entry is OutboxEntry => entry != null);
        resolve(parsed);
      };
      request.onerror = () => reject(request.error);
    });
    return ensureEntryIdentities(
      ownerId,
      entries.sort((left, right) => left.at - right.at),
      true,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("different room or operation namespace") ||
        error.message.includes("changed immutable payload"))
    ) {
      reportStorageIssue({
        severity: "blocked",
        area: "outbox",
        message:
          "Two saved sends reused one client ID with conflicting scope or payload. Recovery is paused to prevent incorrect delivery.",
      });
      throw error;
    }
    // A closed/aborted primary database must never hide a committed recovery
    // mirror. Drop the cached handle so the next call attempts a clean reopen.
    try {
      db.close();
    } catch {
      // no-op
    }
    dbPromise = null;
    reportStorageIssue({
      severity: "degraded",
      area: "outbox",
      message:
        "IndexedDB recovery was interrupted. Outgoing messages remain available from their per-message recovery journal.",
    });
    return ensureEntryIdentities(ownerId, liveMirrorEntries(ownerId, mirror.entries));
  }
}

export async function blockOutboxForChallenge(
  ownerId: string,
  clientId: string,
  challenge: AbuseChallenge,
  attempts: number,
): Promise<void> {
  await updateOutbox(ownerId, clientId, {
    state: "challenge",
    attempts,
    nextAttemptAt: 0,
    lastError: "Additional verification is required.",
    challenge,
  });
  // Close the solve-vs-catch race: if proof completed between the API response
  // being journaled and this mutation, release the unchanged intent now.
  if (wasAbuseChallengeSolved(challenge.token)) {
    await updateOutbox(ownerId, clientId, {
      state: "queued",
      nextAttemptAt: Date.now(),
      lastError: undefined,
      challenge: undefined,
    });
  }
}

export async function releaseOutboxChallenge(ownerId: string, token: string): Promise<void> {
  const rows = await listOutbox(ownerId);
  await Promise.all(
    rows
      .filter((row) => row.state === "challenge" && row.challenge?.token === token)
      .map((row) =>
        updateOutbox(ownerId, row.clientId, {
          state: "queued",
          nextAttemptAt: Date.now(),
          lastError: undefined,
          challenge: undefined,
        }),
      ),
  );
}
