import type { Room } from "./types";

/**
 * A direct room without a resolvable counterpart cannot be identified or
 * acted on safely in the conversation list. These rows can survive an account
 * or Silicon deletion and otherwise render as repeated "new chat" entries.
 * Groups remain valid without peer projections because their room identity is
 * carried by the group itself.
 */
export function roomVisibleInSidebar(
  room: Pick<Room, "kind" | "peers">,
): boolean {
  return room.kind !== "direct" || (Array.isArray(room.peers) && room.peers.length > 0);
}
