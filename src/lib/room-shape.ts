import type {
  Kind,
  Room,
  RoomLastEvent,
  RoomListPreferences,
  RoomListProjection,
  RoomPeer,
  PresenceProjection,
  UnreadBoundary,
} from "./types";
import { validateStreamVectorPosition } from "./sync-integrity";
import { mergeDeliverySummaries, normalizeDeliverySummary } from "./delivery-state";

const KINDS = new Set<Kind>(["carbon", "silicon", "system"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalVector(value: unknown) {
  if (value == null) return undefined;
  try { return validateStreamVectorPosition(value); } catch { return undefined; }
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function kind(value: unknown, fallback: Kind = "carbon"): Kind {
  return typeof value === "string" && KINDS.has(value as Kind) ? (value as Kind) : fallback;
}

function normalizePeer(value: unknown): RoomPeer | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const peerKind = kind(raw.kind, "carbon");
  if (peerKind === "system") return null;
  const id = str(raw.id, str(raw.handle));
  const handle = str(raw.handle, id);
  const rawPresence = asRecord(raw.presence);
  const presenceState = rawPresence?.state;
  let presence: PresenceProjection | undefined;
  if (
    peerKind === "carbon" &&
    rawPresence &&
    (presenceState === "online" || presenceState === "offline" || presenceState === "hidden")
  ) {
    presence = {
      state: presenceState,
      expires_at: str(rawPresence.expires_at),
      last_seen_at: str(rawPresence.last_seen_at),
      revision: Number.isSafeInteger(rawPresence.revision)
        ? Math.max(0, Number(rawPresence.revision))
        : 0,
    };
  }
  if (!id && !handle) return null;
  return {
    kind: peerKind,
    id: id || handle,
    handle: handle || id,
    name: str(raw.name, handle || id),
    profile_photo_url: nullableStr(raw.profile_photo_url),
    profile_ascii_url: nullableStr(raw.profile_ascii_url),
    connection_state: str(raw.connection_state, "online"),
    ...(presence ? { presence } : {}),
  };
}

function normalizeLastEvent(value: unknown): RoomLastEvent | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const preview = str(raw.preview);
  const at = str(raw.at);
  if (!preview && !at) return null;
  const rawDelivery = asRecord(raw.delivery);
  const delivery = rawDelivery &&
    Number.isSafeInteger(rawDelivery.recipient_count) &&
    Number.isSafeInteger(rawDelivery.delivered_count) &&
    Number.isSafeInteger(rawDelivery.read_count)
    ? normalizeDeliverySummary(
        Number(rawDelivery.recipient_count),
        Number(rawDelivery.delivered_count),
        Number(rawDelivery.read_count),
      )
    : undefined;
  return {
    event_id: str(raw.event_id) || undefined,
    preview,
    at,
    sender_handle: nullableStr(raw.sender_handle),
    sender_kind: raw.sender_kind == null ? null : kind(raw.sender_kind, "system"),
    type: str(raw.type, "m.text"),
    read: typeof raw.read === "boolean" ? raw.read : undefined,
    ...(delivery ? { delivery } : {}),
    stream_position: Number.isSafeInteger(raw.stream_position)
      ? Number(raw.stream_position)
      : undefined,
    stream_writer: typeof raw.stream_writer === "string" ? raw.stream_writer : undefined,
    edit_version: Number.isSafeInteger(raw.edit_version)
      ? Number(raw.edit_version)
      : undefined,
    edited_at: typeof raw.edited_at === "string" ? raw.edited_at : null,
  };
}

function normalizeListPreferences(value: unknown): RoomListPreferences | null {
  const raw = asRecord(value);
  if (!raw) return null;
  return { pinned: raw.pinned === true, archived: raw.archived === true };
}

function normalizeListProjection(value: unknown, lastEvent: RoomLastEvent | null): RoomListProjection {
  const raw = asRecord(value);
  const draft = asRecord(raw?.draft);
  const held = asRecord(raw?.held);
  const activity = Number.isSafeInteger(raw?.activity_stream_position)
    ? Number(raw?.activity_stream_position)
    : (lastEvent?.stream_position ?? 0);
  const through = Number.isSafeInteger(raw?.through_stream_position)
    ? Math.max(activity, Number(raw?.through_stream_position))
    : activity;
  const throughVector = optionalVector(raw?.through_stream_vector);
  return {
    version: 1,
    complete: true,
    through_stream_position: through,
    ...(throughVector ? { through_stream_vector: throughVector } : {}),
    activity_stream_position: activity,
    activity_at: str(raw?.activity_at, lastEvent?.at ?? ""),
    draft: {
      active: draft?.active === true,
      version: Number.isSafeInteger(draft?.version) ? Math.max(0, Number(draft?.version)) : 0,
      updated_at: str(draft?.updated_at),
      ...(str(draft?.content_updated_at)
        ? { content_updated_at: str(draft?.content_updated_at) }
        : {}),
      ...(str(draft?.origin_device) ? { origin_device: str(draft?.origin_device) } : {}),
    },
    held: {
      active_count: Number.isSafeInteger(held?.active_count) ? Math.max(0, Number(held?.active_count)) : 0,
      attention_count: Number.isSafeInteger(held?.attention_count) ? Math.max(0, Number(held?.attention_count)) : 0,
      next_release_at: str(held?.next_release_at),
    },
  };
}

function normalizeUnreadBoundary(value: unknown): UnreadBoundary {
  const raw = asRecord(value);
  const lastRead = Number.isSafeInteger(raw?.last_read_stream_position)
    ? Number(raw?.last_read_stream_position)
    : 0;
  const through = Number.isSafeInteger(raw?.through_stream_position)
    ? Math.max(lastRead, Number(raw?.through_stream_position))
    : lastRead;
  const count = Number.isSafeInteger(raw?.unread_count)
    ? Math.max(0, Number(raw?.unread_count))
    : 0;
  const firstId = typeof raw?.first_unread_event_id === "string"
    ? raw.first_unread_event_id
    : null;
  const firstPosition = Number.isSafeInteger(raw?.first_unread_stream_position)
    ? Number(raw?.first_unread_stream_position)
    : null;
  const firstWriter = typeof raw?.first_unread_stream_writer === "string"
    ? raw.first_unread_stream_writer
    : null;
  const lastReadVector = optionalVector(raw?.last_read_stream_vector);
  const throughVector = optionalVector(raw?.through_stream_vector);
  // Legacy sidebar caches did not have boundaries. Treat them as empty only
  // for the instant cached paint; the strict initial/network path replaces it.
  if (!count || !firstId || firstPosition == null) {
    return {
      last_read_stream_position: lastRead,
      ...(lastReadVector ? { last_read_stream_vector: lastReadVector } : {}),
      first_unread_event_id: null,
      first_unread_stream_position: null,
      first_unread_stream_writer: null,
      unread_count: 0,
      through_stream_position: through,
      ...(throughVector ? { through_stream_vector: throughVector } : {}),
    };
  }
  return {
    last_read_stream_position: lastRead,
    ...(lastReadVector ? { last_read_stream_vector: lastReadVector } : {}),
    first_unread_event_id: firstId,
    first_unread_stream_position: firstPosition,
    first_unread_stream_writer: firstWriter,
    unread_count: count,
    through_stream_position: through,
    ...(throughVector ? { through_stream_vector: throughVector } : {}),
  };
}

export function normalizeRoom(value: unknown): Room | null {
  const raw = asRecord(value);
  const roomId = str(raw?.room_id);
  if (!raw || !roomId) return null;

  const peers = Array.isArray(raw.peers)
    ? raw.peers.map(normalizePeer).filter((peer): peer is RoomPeer => peer !== null)
    : [];
  const peerKinds = Array.isArray(raw.peer_kinds)
    ? raw.peer_kinds.map((item) => kind(item)).filter((item) => item !== "system")
    : peers.map((peer) => peer.kind);

  const lastEvent = normalizeLastEvent(raw.last_event);
  return {
    ...(raw as Partial<Room>),
    room_id: roomId,
    kind: raw.kind === "group" ? "group" : "direct",
    team: typeof raw.team === "number" ? raw.team : null,
    team_slug: nullableStr(raw.team_slug),
    peer_kinds: peerKinds,
    peers,
    ...(raw.profile_photo_url !== undefined
      ? { profile_photo_url: nullableStr(raw.profile_photo_url) }
      : {}),
    unread: Boolean(raw.unread),
    unread_count: typeof raw.unread_count === "number" ? raw.unread_count : undefined,
    unread_boundary: normalizeUnreadBoundary(raw.unread_boundary),
    observed: Boolean(raw.observed),
    ...(raw.lord_access_state === "active" || raw.lord_access_state === "revoked"
      ? { lord_access_state: raw.lord_access_state }
      : {}),
    last_event: lastEvent,
    list_preferences: normalizeListPreferences(raw.list_preferences),
    list_projection: normalizeListProjection(raw.list_projection, lastEvent),
    name: str(raw.name),
    topic: str(raw.topic),
    settings: asRecord(raw.settings) ?? {},
    // Legacy cached rooms predate this field and were necessarily managed.
    // Any explicit unrecognized mode is treated as unsupported/private so the
    // composer cannot accidentally send plaintext after a protocol upgrade.
    security_mode:
      raw.security_mode == null || raw.security_mode === "server_managed"
        ? "server_managed"
        : "private_e2ee",
    security_version:
      typeof raw.security_version === "number" ? Math.max(0, Math.trunc(raw.security_version)) : 0,
    security_frozen_at: nullableStr(raw.security_frozen_at),
    created_by_kind: str(raw.created_by_kind),
    created_by_id: typeof raw.created_by_id === "number" ? raw.created_by_id : null,
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  };
}

export function normalizeRooms(value: unknown): Room[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.map(normalizeRoom).filter((room): room is Room => room !== null);
  const directByPeer = new Map<string, Room>();
  const result: Room[] = [];
  for (const room of normalized) {
    // A normal direct-room projection contains exactly the other principal.
    // During a rolling deploy or cache recovery, collapse legacy duplicate
    // room ids for that peer to the oldest ULID—the same canonical choice as
    // the server migration. Malformed/observer projections stay untouched.
    const peer = room.kind === "direct" && room.peers.length === 1 ? room.peers[0] : null;
    if (!peer) {
      result.push(room);
      continue;
    }
    const key = `${peer.kind}:${peer.id}`;
    const existing = directByPeer.get(key);
    if (!existing) {
      directByPeer.set(key, room);
      result.push(room);
      continue;
    }
    if (room.room_id >= existing.room_id) continue;
    directByPeer.set(key, room);
    const index = result.findIndex((candidate) => candidate.room_id === existing.room_id);
    if (index !== -1) result[index] = room;
  }
  return result;
}

function roomActivityAt(room: Room): string {
  return room.list_projection?.activity_at || room.last_event?.at || "";
}

function roomActivityPosition(room: Room): number {
  const projected = room.list_projection?.activity_stream_position;
  if (Number.isSafeInteger(projected)) return Number(projected);
  const last = room.last_event?.stream_position;
  return Number.isSafeInteger(last) ? Number(last) : 0;
}

/** Compare the visible last-message projections in application order.
 * A zero timestamp/position tie deliberately favors the already-painted
 * projection: an eventually-consistent room refresh must never roll a live or
 * just-accepted sidebar row back to a different event. */
function compareRoomActivity(current: Room, incoming: Room): number {
  const currentLast = current.last_event;
  const incomingLast = incoming.last_event;
  if (currentLast?.event_id && currentLast.event_id === incomingLast?.event_id) return 0;

  const currentAt = roomActivityAt(current);
  const incomingAt = roomActivityAt(incoming);
  if (currentAt !== incomingAt) {
    if (!currentAt) return -1;
    if (!incomingAt) return 1;
    return currentAt.localeCompare(incomingAt);
  }

  const currentPosition = roomActivityPosition(current);
  const incomingPosition = roomActivityPosition(incoming);
  if (currentPosition !== incomingPosition) {
    return currentPosition < incomingPosition ? -1 : 1;
  }

  if (currentLast && !incomingLast) return 1;
  if (!currentLast && incomingLast) return -1;
  return currentLast && incomingLast ? 1 : 0;
}

function mergeListProjectionProgress(
  current: Room,
  incoming: Room,
  preserveCurrentActivity: boolean,
): Room["list_projection"] {
  const currentProjection = current.list_projection;
  const incomingProjection = incoming.list_projection;
  if (!currentProjection) return incomingProjection;
  if (!incomingProjection) return currentProjection;

  const currentThrough = currentProjection.through_stream_position;
  const incomingThrough = incomingProjection.through_stream_position;
  const preserveCurrentThrough = currentThrough > incomingThrough;
  const throughVector = preserveCurrentThrough
    ? currentProjection.through_stream_vector
    : incomingProjection.through_stream_vector;

  return {
    ...incomingProjection,
    through_stream_position: Math.max(currentThrough, incomingThrough),
    ...(throughVector ? { through_stream_vector: throughVector } : {}),
    activity_stream_position: preserveCurrentActivity
      ? currentProjection.activity_stream_position
      : incomingProjection.activity_stream_position,
    activity_at: preserveCurrentActivity
      ? currentProjection.activity_at
      : incomingProjection.activity_at,
  };
}

/** Merge an authoritative room snapshot without allowing eventually-consistent
 * refreshes to roll back the visible tail, edit revision, receipt state, or
 * stream checkpoint that the live timeline has already established. */
export function mergeRoomReceiptProjection(current: Room, incoming: Room): Room {
  const currentLast = current.last_event;
  const incomingLast = incoming.last_event;
  const sameEvent = Boolean(
    currentLast?.event_id &&
    incomingLast?.event_id &&
    currentLast.event_id === incomingLast.event_id,
  );

  if (!sameEvent || !currentLast || !incomingLast) {
    const preserveCurrentActivity = compareRoomActivity(current, incoming) > 0;
    if (!preserveCurrentActivity) {
      return {
        ...incoming,
        list_projection: mergeListProjectionProgress(current, incoming, false),
      };
    }
    return {
      ...incoming,
      last_event: currentLast,
      list_projection: mergeListProjectionProgress(current, incoming, true),
    };
  }

  const currentEditVersion = Number.isSafeInteger(currentLast?.edit_version)
    ? Number(currentLast?.edit_version)
    : 0;
  const incomingEditVersion = Number.isSafeInteger(incomingLast?.edit_version)
    ? Number(incomingLast?.edit_version)
    : 0;
  const newestRevision = currentEditVersion > incomingEditVersion
    ? currentLast!
    : incomingLast!;
  const delivery = mergeDeliverySummaries(currentLast.delivery, incomingLast.delivery);
  const read = currentLast.read === true || incomingLast.read === true || delivery?.state === "read";
  return {
    ...incoming,
    last_event: {
      ...newestRevision,
      ...(delivery ? { delivery } : {}),
      read,
    },
    list_projection: mergeListProjectionProgress(current, incoming, false),
  };
}

export function replaceRoomsPreservingReceiptFacts(
  current: Room[],
  incoming: Room[],
): Room[] {
  const currentById = new Map(current.map((room) => [room.room_id, room]));
  return incoming.map((room) => {
    const existing = currentById.get(room.room_id);
    return existing ? mergeRoomReceiptProjection(existing, room) : room;
  });
}
