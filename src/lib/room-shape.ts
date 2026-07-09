import type { Kind, Room, RoomLastEvent, RoomPeer } from "./types";

const KINDS = new Set<Kind>(["carbon", "silicon", "system"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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
  if (!id && !handle) return null;
  return {
    kind: peerKind,
    id: id || handle,
    handle: handle || id,
    name: str(raw.name, handle || id),
    profile_photo_url: nullableStr(raw.profile_photo_url),
    profile_ascii_url: nullableStr(raw.profile_ascii_url),
    connection_state: str(raw.connection_state, "online"),
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
    observed: Boolean(raw.observed),
    last_event: normalizeLastEvent(raw.last_event),
    name: str(raw.name),
    topic: str(raw.topic),
    settings: asRecord(raw.settings) ?? {},
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
