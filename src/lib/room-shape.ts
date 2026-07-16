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
  return {
    event_id: str(raw.event_id) || undefined,
    preview,
    at,
    sender_handle: nullableStr(raw.sender_handle),
    sender_kind: raw.sender_kind == null ? null : kind(raw.sender_kind, "system"),
    type: str(raw.type, "m.text"),
    read: typeof raw.read === "boolean" ? raw.read : undefined,
    stream_position: Number.isSafeInteger(raw.stream_position)
      ? Number(raw.stream_position)
      : undefined,
    stream_writer: typeof raw.stream_writer === "string" ? raw.stream_writer : undefined,
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
    unread: Boolean(raw.unread),
    unread_count: typeof raw.unread_count === "number" ? raw.unread_count : undefined,
    unread_boundary: normalizeUnreadBoundary(raw.unread_boundary),
    observed: Boolean(raw.observed),
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
  return value.map(normalizeRoom).filter((room): room is Room => room !== null);
}
