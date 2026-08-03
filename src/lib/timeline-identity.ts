"use client";

import type { Event } from "./types";

const IDENTITY_PREFIX = "silicon-interface:timeline-identity:v1";
const SEQUENCE_PREFIX = "silicon-interface:timeline-sequence:v1";
const memoryIdentities = new Map<string, TimelineIdentity>();
const memorySequences = new Map<string, number>();
const sequenceChains = new Map<string, Promise<void>>();

export interface TimelineIdentity {
  clientId: string;
  localKey: string;
  localSequence: number;
  originDevice: string;
  localCreatedAt: string;
  eventId?: string;
  authoritativeCreatedAt?: string;
}

export type TimelineEvent = Event & {
  /** Immutable renderer identity. It never changes when a temp event is accepted. */
  _localKey?: string;
  /** Strictly increasing in the primary IDB outbox; degraded mirror fallback
   * uses localKey as a deterministic total-order tie-break. */
  _localSequence?: number;
  _originDevice?: string;
  _localCreatedAt?: string;
  _authoritativeCreatedAt?: string;
  _clientId?: string;
  [key: `_${string}`]: unknown;
};

export interface PersistedTimelineFields {
  localKey: string;
  localSequence: number;
  originDevice: string;
  localCreatedAt: string;
}

function identityKey(ownerId: string, clientId: string): string {
  return `${ownerId}\u0000${clientId}`;
}

function storageIdentityKey(ownerId: string, clientId: string): string {
  return `${IDENTITY_PREFIX}:${encodeURIComponent(ownerId)}:${encodeURIComponent(clientId)}`;
}

function storageSequenceKey(ownerId: string, originDevice: string): string {
  return `${SEQUENCE_PREFIX}:${encodeURIComponent(ownerId)}:${encodeURIComponent(originDevice)}`;
}

function parseIdentity(value: unknown): TimelineIdentity | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<TimelineIdentity>;
  if (
    typeof row.clientId !== "string" ||
    !row.clientId ||
    typeof row.localKey !== "string" ||
    !row.localKey ||
    typeof row.localSequence !== "number" ||
    !Number.isSafeInteger(row.localSequence) ||
    row.localSequence < 0 ||
    typeof row.originDevice !== "string" ||
    !row.originDevice ||
    typeof row.localCreatedAt !== "string" ||
    !row.localCreatedAt ||
    (row.eventId != null && typeof row.eventId !== "string") ||
    (row.authoritativeCreatedAt != null &&
      typeof row.authoritativeCreatedAt !== "string")
  ) {
    return null;
  }
  return row as TimelineIdentity;
}

function writeIdentity(ownerId: string, identity: TimelineIdentity): boolean {
  memoryIdentities.set(identityKey(ownerId, identity.clientId), identity);
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      storageIdentityKey(ownerId, identity.clientId),
      JSON.stringify(identity),
    );
    return true;
  } catch {
    return false;
  }
}

export function readTimelineIdentity(
  ownerId: string,
  clientId: string,
): TimelineIdentity | null {
  const key = identityKey(ownerId, clientId);
  const remembered = memoryIdentities.get(key);
  if (remembered) return remembered;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageIdentityKey(ownerId, clientId));
    const parsed = raw ? parseIdentity(JSON.parse(raw) as unknown) : null;
    if (parsed) memoryIdentities.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function localKey(originDevice: string, clientId: string): string {
  // The origin device is part of the key because client IDs are only unique
  // inside a device namespace. This prevents another device using the same
  // client_id from stealing or remounting our local row.
  return `local:${encodeURIComponent(originDevice)}:${encodeURIComponent(clientId)}`;
}

export function timelineSequenceFloor(at: number): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER - 1,
    Math.max(0, Math.trunc(at)) * 1_000,
  );
}

export function makeTimelineIdentity(
  clientId: string,
  originDevice: string,
  localSequence: number,
  at: number,
): TimelineIdentity {
  return {
    clientId,
    localKey: localKey(originDevice, clientId),
    localSequence,
    originDevice,
    localCreatedAt: new Date(at).toISOString(),
  };
}

export function rememberTimelineIdentity(
  ownerId: string,
  identity: TimelineIdentity,
): boolean {
  const existing = readTimelineIdentity(ownerId, identity.clientId);
  if (existing) {
    if (
      existing.localKey !== identity.localKey ||
      existing.localSequence !== identity.localSequence ||
      existing.originDevice !== identity.originDevice ||
      existing.localCreatedAt !== identity.localCreatedAt
    ) {
      throw new Error("timeline client id was reused with a changed immutable identity");
    }
    return writeIdentity(ownerId, {
      ...identity,
      eventId: identity.eventId ?? existing.eventId,
      authoritativeCreatedAt:
        identity.authoritativeCreatedAt ?? existing.authoritativeCreatedAt,
    });
  }
  return writeIdentity(ownerId, identity);
}

/** A committed strict-IDB outbox row is the recovery authority. Repair a
 * stale/quota-truncated mirror copy instead of throwing after the transaction
 * has already succeeded. Bound aliases are preserved only when immutable
 * identity fields agree. */
export function restoreDurableTimelineIdentity(
  ownerId: string,
  identity: TimelineIdentity,
): boolean {
  const existing = readTimelineIdentity(ownerId, identity.clientId);
  const sameImmutable = Boolean(
    existing &&
      existing.localKey === identity.localKey &&
      existing.localSequence === identity.localSequence &&
      existing.originDevice === identity.originDevice &&
      existing.localCreatedAt === identity.localCreatedAt,
  );
  return writeIdentity(ownerId, {
    ...identity,
    ...(sameImmutable && existing?.eventId ? { eventId: existing.eventId } : {}),
    ...(sameImmutable && existing?.authoritativeCreatedAt
      ? { authoritativeCreatedAt: existing.authoritativeCreatedAt }
      : {}),
  });
}

function nextSequence(ownerId: string, originDevice: string, at: number): number {
  const key = storageSequenceKey(ownerId, originDevice);
  let persisted = -1;
  if (typeof window !== "undefined") {
    try {
      const raw = Number(window.localStorage.getItem(key));
      if (Number.isSafeInteger(raw) && raw >= 0) persisted = raw;
    } catch {
      // The in-memory Lamport clock below still prevents clock-regression
      // reordering for the lifetime of this renderer.
    }
  }
  const memory = memorySequences.get(key) ?? -1;
  // Reserve 1,000 sequence values per wall-clock millisecond. The persisted
  // Lamport maximum, not Date.now(), wins after a system-clock regression.
  const wallBase = timelineSequenceFloor(at);
  const next = Math.max(persisted + 1, memory + 1, wallBase);
  memorySequences.set(key, next);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(key, String(next));
    } catch {
      // The outbox itself carries this exact allocated value in IndexedDB.
    }
  }
  return next;
}

async function withSequenceLock<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(name, { mode: "exclusive" }, work);
  }
  // Browsers without Web Locks still serialize every allocation in this tab.
  // The deterministic device+client local key remains collision-proof across
  // tabs; modern multi-tab browsers take the cross-context Web Lock path.
  const prior = sequenceChains.get(name) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => turn);
  sequenceChains.set(name, tail);
  await prior.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (sequenceChains.get(name) === tail) sequenceChains.delete(name);
  }
}

/** Allocate once before an outbox intent is committed. Re-enqueueing the same
 * client ID returns the existing immutable identity and cannot change order. */
export async function allocateTimelineIdentity(
  ownerId: string,
  clientId: string,
  originDevice: string,
  at = Date.now(),
): Promise<TimelineIdentity> {
  const existing = readTimelineIdentity(ownerId, clientId);
  if (existing) {
    if (existing.originDevice !== originDevice) {
      throw new Error("timeline client id is already bound to another device");
    }
    return existing;
  }
  const lockName = `timeline-sequence:${ownerId}:${originDevice}`;
  return withSequenceLock(lockName, () => {
    const raced = readTimelineIdentity(ownerId, clientId);
    if (raced) return raced;
    const identity = makeTimelineIdentity(
      clientId,
      originDevice,
      nextSequence(ownerId, originDevice, at),
      at,
    );
    writeIdentity(ownerId, identity);
    return identity;
  });
}

/** Synchronous renderer-side lookup used after enqueueOutbox has already
 * committed. It also covers sessions without an account outbox namespace. */
export function ensureTimelineIdentitySync(
  ownerId: string,
  clientId: string,
  originDevice: string,
  at = Date.now(),
): TimelineIdentity {
  const existing = readTimelineIdentity(ownerId, clientId);
  if (existing) {
    if (existing.originDevice !== originDevice) {
      throw new Error("timeline client id is already bound to another device");
    }
    return existing;
  }
  const identity = makeTimelineIdentity(
    clientId,
    originDevice,
    nextSequence(ownerId, originDevice, at),
    at,
  );
  writeIdentity(ownerId, identity);
  return identity;
}

export function identityFromPersistedFields(
  ownerId: string,
  clientId: string,
  fields: PersistedTimelineFields,
): TimelineIdentity {
  const existing = readTimelineIdentity(ownerId, clientId);
  if (existing) {
    if (
      existing.localKey !== fields.localKey ||
      existing.localSequence !== fields.localSequence ||
      existing.originDevice !== fields.originDevice ||
      existing.localCreatedAt !== fields.localCreatedAt
    ) {
      throw new Error("timeline client id was reused with a changed immutable identity");
    }
    // Keep an event alias learned after this stale outbox copy was written.
    return existing;
  }
  const identity: TimelineIdentity = {
    clientId,
    localKey: fields.localKey,
    localSequence: fields.localSequence,
    originDevice: fields.originDevice,
    localCreatedAt: fields.localCreatedAt,
  };
  writeIdentity(ownerId, identity);
  return identity;
}

/** Bind a direct response or validated operation result before its outbox row
 * is acknowledged. This alias survives reload and lets history restore the
 * exact local renderer key and timestamp. */
export function bindAcceptedTimelineEvent(
  ownerId: string,
  clientId: string,
  event: Event,
): TimelineIdentity | null {
  const existing = readTimelineIdentity(ownerId, clientId);
  if (!existing) return null;
  const bound: TimelineIdentity = {
    ...existing,
    eventId: event.event_id,
    authoritativeCreatedAt: event.created_at,
  };
  writeIdentity(ownerId, bound);
  return bound;
}

export function applyTimelineIdentity<T extends Event>(
  event: T,
  identity: TimelineIdentity,
  authoritative = false,
): T & TimelineEvent {
  const authoritativeCreatedAt = authoritative
    ? event.created_at
    : identity.authoritativeCreatedAt;
  return {
    ...event,
    created_at: identity.localCreatedAt,
    _localKey: identity.localKey,
    _localSequence: identity.localSequence,
    _originDevice: identity.originDevice,
    _localCreatedAt: identity.localCreatedAt,
    ...(authoritativeCreatedAt
      ? { _authoritativeCreatedAt: authoritativeCreatedAt }
      : {}),
    _clientId: identity.clientId,
  } as T & TimelineEvent;
}

/** Decorate the HTTP response for one exact client intent before it enters
 * shared persistence or websocket-style fan-out. Recovery-owned media sends
 * do not have a mounted composer callback, so delaying this binding until the
 * outbox acknowledgement would briefly append a second timeline row. */
export function decorateDirectAcceptedTimelineEvent<T extends Event>(
  ownerId: string,
  clientId: string,
  event: T,
): T & TimelineEvent {
  const identity =
    bindAcceptedTimelineEvent(ownerId, clientId, event) ??
    readTimelineIdentity(ownerId, clientId);
  return identity ? applyTimelineIdentity(event, identity, true) : (event as T & TimelineEvent);
}

/** Decorate a history/socket event only from Glass' device-scoped, top-level
 * transaction_id. content.client_id is deliberately never inspected. */
export function decorateAuthoritativeTimelineEvent<T extends Event>(
  ownerId: string,
  event: T,
): T & TimelineEvent {
  const transactionId =
    typeof event.transaction_id === "string" && event.transaction_id
      ? event.transaction_id
      : null;
  if (!transactionId) return event as T & TimelineEvent;
  // A device-scoped transaction id is authoritative acceptance. Persist the
  // server event binding immediately so reload/outbox recovery cannot later
  // reinterpret this already-accepted send as a local failure.
  const identity =
    bindAcceptedTimelineEvent(ownerId, transactionId, event) ??
    readTimelineIdentity(ownerId, transactionId);
  return identity ? applyTimelineIdentity(event, identity, true) : (event as T & TimelineEvent);
}

export interface ReconcileTimelineOptions<T extends TimelineEvent> {
  ownerId: string;
  currentDevice: string | null;
  /** Only a response returned to this exact POST may bind without transaction_id. */
  directClientId?: string;
  merge?: (existing: T, incoming: T) => T;
}

function trustedTransactionId<T extends TimelineEvent>(
  event: T,
  currentDevice: string | null,
): string | null {
  const transactionId =
    typeof event.transaction_id === "string" && event.transaction_id
      ? event.transaction_id
      : null;
  if (!transactionId) return null;
  // Glass only projects transaction_id when X-Device-ID exactly matches the
  // authoring device. Requiring the local identity's origin as well makes that
  // trust boundary explicit on the client.
  if (event._originDevice && currentDevice && event._originDevice !== currentDevice) {
    return null;
  }
  return transactionId;
}

function compareTimelineOrder(left: TimelineEvent, right: TimelineEvent): number {
  if (
    left._localSequence != null &&
    right._localSequence != null &&
    left._originDevice &&
    left._originDevice === right._originDevice
  ) {
    const sequenceOrder = left._localSequence - right._localSequence;
    if (sequenceOrder !== 0) return sequenceOrder;
    const leftKey = left._localKey ?? left.event_id;
    const rightKey = right._localKey ?? right.event_id;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }
  // The numeric stream position is Glass' cross-writer commit authority. ULIDs
  // are monotonic only within one generator, so two web workers accepting in
  // the same millisecond can produce lexical IDs in the opposite order. That
  // used to insert forwarded/live events into the middle of the conversation.
  const leftAccepted = Boolean(left.event_id && !left.event_id.startsWith("temp-"));
  const rightAccepted = Boolean(right.event_id && !right.event_id.startsWith("temp-"));
  // stream_position advances for edits/redactions. accepted_at never does, so
  // an old message mutation cannot move its row or disturb scroll anchoring.
  if (leftAccepted && rightAccepted && left.accepted_at && right.accepted_at) {
    const acceptedOrder = left.accepted_at.localeCompare(right.accepted_at);
    if (acceptedOrder !== 0) return acceptedOrder;
    if (
      Number.isSafeInteger(left.stream_position) &&
      Number.isSafeInteger(right.stream_position) &&
      left.stream_position !== right.stream_position
    ) {
      return Number(left.stream_position) - Number(right.stream_position);
    }
    if (left.event_id !== right.event_id) return left.event_id < right.event_id ? -1 : 1;
  }
  if (
    leftAccepted &&
    rightAccepted &&
    Number.isSafeInteger(left.stream_position) &&
    Number.isSafeInteger(right.stream_position) &&
    left.stream_position !== right.stream_position
  ) {
    return Number(left.stream_position) - Number(right.stream_position);
  }
  // Legacy cached rows may predate stream positions. Keep their established
  // server ULID order rather than allowing skewed client clocks to reshuffle.
  if (leftAccepted && rightAccepted && left.event_id !== right.event_id) {
    return left.event_id < right.event_id ? -1 : 1;
  }
  const leftAt = left._localCreatedAt ?? left.created_at;
  const rightAt = right._localCreatedAt ?? right.created_at;
  if (leftAt < rightAt) return -1;
  if (leftAt > rightAt) return 1;
  return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
}

/** Reconcile history, socket echoes, and direct responses into one stable row.
 * All aliases are collapsed at the original local index; the local timestamp,
 * sequence, and React key survive while the authoritative timestamp is kept
 * separately. */
export function reconcileTimelineEvents<T extends TimelineEvent>(
  previous: T[],
  authoritative: Event[],
  options: ReconcileTimelineOptions<T>,
): T[] {
  const rows = [...previous];
  for (const raw of authoritative) {
    let incoming = decorateAuthoritativeTimelineEvent(options.ownerId, raw) as T;
    const directIdentity = options.directClientId
      ? readTimelineIdentity(options.ownerId, options.directClientId)
      : null;
    if (directIdentity) incoming = applyTimelineIdentity(incoming, directIdentity, true) as T;
    const transactionId = trustedTransactionId(incoming, options.currentDevice);
    const localKey = incoming._localKey ?? directIdentity?.localKey;
    const directClientId = options.directClientId ?? null;
    const matches: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const candidate = rows[index];
      const exactEvent = candidate.event_id === incoming.event_id;
      const exactLocal = Boolean(localKey && candidate._localKey === localKey);
      const transactionMatch = Boolean(
        transactionId &&
          candidate._clientId === transactionId &&
          (!candidate._originDevice ||
            !options.currentDevice ||
            candidate._originDevice === options.currentDevice),
      );
      const directMatch = Boolean(directClientId && candidate._clientId === directClientId);
      if (exactEvent || exactLocal || transactionMatch || directMatch) matches.push(index);
    }
    if (matches.length === 0) {
      rows.push(incoming);
      continue;
    }
    const localMatch = matches.find((index) => Boolean(rows[index]._localKey));
    const anchorIndex = localMatch ?? matches[0];
    const existing = rows[anchorIndex];
    const mergedBase = {
      ...incoming,
      _localKey: existing._localKey ?? incoming._localKey,
      _localSequence: existing._localSequence ?? incoming._localSequence,
      _originDevice: existing._originDevice ?? incoming._originDevice,
      _localCreatedAt: existing._localCreatedAt ?? incoming._localCreatedAt,
      _authoritativeCreatedAt:
        incoming._authoritativeCreatedAt ?? incoming.created_at,
      _clientId:
        existing._clientId ?? incoming._clientId ?? transactionId ?? directClientId ?? undefined,
      created_at:
        existing._localCreatedAt ?? incoming._localCreatedAt ?? existing.created_at,
    } as T;
    rows[anchorIndex] = options.merge ? options.merge(existing, mergedBase) : mergedBase;
    for (const index of matches.slice().sort((a, b) => b - a)) {
      if (index !== anchorIndex) rows.splice(index, 1);
    }
  }
  return rows.sort(compareTimelineOrder);
}

export function timelineRenderKey(event: Event): string {
  const localKey = (event as TimelineEvent)._localKey;
  return typeof localKey === "string" && localKey ? localKey : event.event_id;
}

export function hasAuthoritativeEventId(event: Event): boolean {
  return Boolean(
    event.event_id &&
    !event.event_id.startsWith("temp-") &&
    (event as TimelineEvent)._projectedRoomTail !== true
  );
}

export function authoritativeActionId(event: Event): string | null {
  return hasAuthoritativeEventId(event) ? event.event_id : null;
}

export function canEditAuthoritativeTimelineEvent(
  event: Event,
  options: {
    isMine: boolean;
    roomIncludesSilicon: boolean;
    hasEditableText: boolean;
  },
): boolean {
  return Boolean(
    options.isMine &&
      hasAuthoritativeEventId(event) &&
      !event.redacted_at &&
      event.is_final !== false &&
      options.hasEditableText &&
      !options.roomIncludesSilicon,
  );
}
