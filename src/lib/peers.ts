// Tiny helpers for picking the "headline" peer of a room and projecting it
// for display. Centralized here so the sidebar, the chat header, and the
// profile drawer all label rooms identically.

import type { Room, RoomPeer } from "./types";

export interface RoomDisplay {
  /** What to show as the primary label (display name, falls back to handle). */
  name: string;
  /** The peer's handle (carbon_id or silicon name) — for avatar seed + copy. */
  handle: string;
  /** Photo URL for IdAvatar, or null to use the deterministic identicon. */
  photoUrl: string | null;
  /** Underlying peer object, if any — direct rooms have one. */
  peer: RoomPeer | null;
  /** For group rooms, the secondary line ("3 members" etc.). */
  subtitle: string;
}

/**
 * Resolve how a room should appear in the list / header.
 *
 * Direct rooms project the single peer. Groups keep `room.name` (or a fallback
 * derived from the member kinds) and a subtitle that summarizes membership.
 */
export function roomDisplay(room: Room): RoomDisplay {
  if (room.kind === "direct" && room.peers.length > 0) {
    const peer = room.peers[0];
    return {
      name: peer.name?.trim() || peer.handle,
      handle: peer.handle,
      photoUrl: peer.profile_photo_url,
      peer,
      subtitle: peer.kind === "silicon" ? "Silicon" : "Carbon",
    };
  }
  const groupName = room.name?.trim() || room.topic?.trim() || "group";
  return {
    name: groupName,
    handle: room.room_id,
    photoUrl: null,
    peer: null,
    subtitle:
      room.peers.length > 0
        ? `${room.peers.length + 1} members`
        : (room.topic || "group"),
  };
}
