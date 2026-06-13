"use client";

// Personal, per-user chat groups — "folders" a Carbon arranges their own
// sidebar into, scoped per team. Purely client-side: nobody else sees them, so
// this lives in localStorage keyed by the owner's carbon_id, mirroring the
// per-user persistence in `sidebar-cache.ts` and the sidebar-width key in the
// chat page. A room belongs to at most one group within a given team.

const VERSION = 1;
const PREFIX = "silicon-interface:chat-groups";

export interface ChatGroup {
  id: string;
  /** the team this group organizes; groups never span teams */
  teamSlug: string;
  name: string;
  /** member room ids, in display order */
  roomIds: string[];
  collapsed: boolean;
  /** sort order among a team's groups (ascending) */
  order: number;
}

interface GroupStore {
  version: typeof VERSION;
  ownerId: string;
  groups: ChatGroup[];
  savedAt: number;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `g_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

export function loadGroups(ownerId: string): ChatGroup[] {
  if (typeof window === "undefined" || !ownerId) return [];
  const raw = window.localStorage.getItem(key(ownerId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<GroupStore>;
    if (parsed.version !== VERSION || parsed.ownerId !== ownerId || !Array.isArray(parsed.groups)) {
      return [];
    }
    // Tolerate older / partial rows — coerce each field to a safe default.
    return parsed.groups
      .filter((g): g is ChatGroup => !!g && typeof g.id === "string" && typeof g.teamSlug === "string")
      .map((g, i) => ({
        id: g.id,
        teamSlug: g.teamSlug,
        name: typeof g.name === "string" ? g.name : "Group",
        roomIds: Array.isArray(g.roomIds) ? g.roomIds.filter((r) => typeof r === "string") : [],
        collapsed: !!g.collapsed,
        order: typeof g.order === "number" ? g.order : i,
      }));
  } catch {
    return [];
  }
}

export function saveGroups(ownerId: string, groups: ChatGroup[]) {
  if (typeof window === "undefined" || !ownerId) return;
  const payload: GroupStore = { version: VERSION, ownerId, groups, savedAt: Date.now() };
  try {
    window.localStorage.setItem(key(ownerId), JSON.stringify(payload));
  } catch {
    // localStorage full / unavailable — drop the persisted copy rather than
    // throwing; the in-memory state still drives this session.
    try {
      window.localStorage.removeItem(key(ownerId));
    } catch {
      /* nothing more we can do */
    }
  }
}

// ---- pure helpers (no React, no storage) -------------------------------------
// Each returns a new array so callers can drive React state directly.

export function createGroup(groups: ChatGroup[], teamSlug: string, name: string): ChatGroup[] {
  const trimmed = name.trim() || "New group";
  const maxOrder = groups
    .filter((g) => g.teamSlug === teamSlug)
    .reduce((m, g) => Math.max(m, g.order), -1);
  const group: ChatGroup = {
    id: newId(),
    teamSlug,
    name: trimmed,
    roomIds: [],
    collapsed: false,
    order: maxOrder + 1,
  };
  return [...groups, group];
}

export function renameGroup(groups: ChatGroup[], groupId: string, name: string): ChatGroup[] {
  const trimmed = name.trim();
  if (!trimmed) return groups;
  return groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g));
}

export function deleteGroup(groups: ChatGroup[], groupId: string): ChatGroup[] {
  // Dropping a group simply removes it; its rooms fall back to "ungrouped"
  // because group membership is derived from the surviving groups' roomIds.
  return groups.filter((g) => g.id !== groupId);
}

export function setGroupCollapsed(groups: ChatGroup[], groupId: string, collapsed: boolean): ChatGroup[] {
  return groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g));
}

/** Move `roomId` into `groupId` (or out of every group when `groupId` is null).
 *  Enforces single membership within the room's team: the room is first pulled
 *  from any group in `teamSlug`, then appended to the target. */
export function assignRoomToGroup(
  groups: ChatGroup[],
  teamSlug: string,
  roomId: string,
  groupId: string | null,
): ChatGroup[] {
  const cleared = groups.map((g) =>
    g.teamSlug === teamSlug && g.roomIds.includes(roomId)
      ? { ...g, roomIds: g.roomIds.filter((r) => r !== roomId) }
      : g,
  );
  if (!groupId) return cleared;
  return cleared.map((g) =>
    g.id === groupId && !g.roomIds.includes(roomId)
      ? { ...g, roomIds: [...g.roomIds, roomId] }
      : g,
  );
}

/** The group a room currently belongs to within a team, or null. */
export function groupOfRoom(groups: ChatGroup[], teamSlug: string, roomId: string): ChatGroup | null {
  return (
    groups.find((g) => g.teamSlug === teamSlug && g.roomIds.includes(roomId)) ?? null
  );
}
