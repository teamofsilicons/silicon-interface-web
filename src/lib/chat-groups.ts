"use client";

// Personal chat-folder state for the sidebar, scoped per team. This layer
// COEXISTS with the team-defined folders authored in Glass (Team.silicon_folders):
//
//   • Team folders provide the *default* grouping — a team's silicon chats land
//     in whatever folder Glass assigns their silicon to.
//   • The user can override any chat's placement personally; that always wins.
//   • The user can also create their own personal folders.
//
// So this store holds (a) the user's own folders and (b) an override map
// roomId → folderId (a personal OR team folder id; "" means explicitly
// ungrouped). Everything is per-user, in localStorage, keyed by carbon_id.
//
// Folder resolution (computed in the chat page, not here):
//   override present?  → use it ("" = ungrouped)
//   else silicon assigned to a team folder?  → that team folder
//   else  → ungrouped

const VERSION = 2;
const PREFIX = "silicon-interface:chat-groups";

/** A folder the user created themselves (team folders come from Glass). */
export interface PersonalFolder {
  id: string;
  teamSlug: string;
  name: string;
  order: number;
}

export interface GroupStore {
  /** user-created folders */
  folders: PersonalFolder[];
  /** roomId → folderId ("" = explicitly ungrouped). Absent → fall back to the
   *  team-folder default. */
  overrides: Record<string, string>;
}

interface PersistShape extends GroupStore {
  version: typeof VERSION;
  ownerId: string;
  savedAt: number;
}

/** The old v1 shape: groups that directly held their member room ids. */
interface LegacyGroup {
  id: string;
  teamSlug: string;
  name: string;
  roomIds: string[];
  order?: number;
}

export function newFolderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `f_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function empty(): GroupStore {
  return { folders: [], overrides: {} };
}

/** Migrate a v1 store (folders with roomIds) into the v2 folders+overrides
 *  shape so the user's existing personal groupings are preserved. */
function migrateV1(groups: LegacyGroup[]): GroupStore {
  const folders: PersonalFolder[] = [];
  const overrides: Record<string, string> = {};
  groups.forEach((g, i) => {
    if (!g || typeof g.id !== "string") return;
    folders.push({
      id: g.id,
      teamSlug: typeof g.teamSlug === "string" ? g.teamSlug : "",
      name: typeof g.name === "string" ? g.name : "Group",
      order: typeof g.order === "number" ? g.order : i,
    });
    for (const roomId of Array.isArray(g.roomIds) ? g.roomIds : []) {
      if (typeof roomId === "string") overrides[roomId] = g.id;
    }
  });
  return { folders, overrides };
}

export function loadGroupStore(ownerId: string): GroupStore {
  if (typeof window === "undefined" || !ownerId) return empty();
  const raw = window.localStorage.getItem(key(ownerId));
  if (!raw) return empty();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.ownerId !== ownerId) return empty();
    if (parsed.version === 1 && Array.isArray(parsed.groups)) {
      return migrateV1(parsed.groups as LegacyGroup[]);
    }
    if (parsed.version !== VERSION) return empty();
    const folders = Array.isArray(parsed.folders)
      ? (parsed.folders as PersonalFolder[]).filter(
          (f) => f && typeof f.id === "string" && typeof f.teamSlug === "string",
        )
      : [];
    const overrides =
      parsed.overrides && typeof parsed.overrides === "object"
        ? (parsed.overrides as Record<string, string>)
        : {};
    return { folders, overrides };
  } catch {
    return empty();
  }
}

export function saveGroupStore(ownerId: string, store: GroupStore) {
  if (typeof window === "undefined" || !ownerId) return;
  const payload: PersistShape = {
    version: VERSION,
    ownerId,
    folders: store.folders,
    overrides: store.overrides,
    savedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(key(ownerId), JSON.stringify(payload));
  } catch {
    try {
      window.localStorage.removeItem(key(ownerId));
    } catch {
      /* nothing more we can do */
    }
  }
}

// ---- pure helpers (no React, no storage) -------------------------------------

export function createPersonalFolder(
  store: GroupStore,
  teamSlug: string,
  name: string,
): { store: GroupStore; id: string } {
  const id = newFolderId();
  const maxOrder = store.folders
    .filter((f) => f.teamSlug === teamSlug)
    .reduce((m, f) => Math.max(m, f.order), -1);
  const folder: PersonalFolder = { id, teamSlug, name: name.trim() || "New folder", order: maxOrder + 1 };
  return { store: { ...store, folders: [...store.folders, folder] }, id };
}

export function renamePersonalFolder(store: GroupStore, id: string, name: string): GroupStore {
  const trimmed = name.trim();
  if (!trimmed) return store;
  return { ...store, folders: store.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) };
}

/** Delete a personal folder and clear any overrides that pointed at it (those
 *  rooms revert to their team-folder default). */
export function deletePersonalFolder(store: GroupStore, id: string): GroupStore {
  const overrides: Record<string, string> = {};
  for (const [roomId, fid] of Object.entries(store.overrides)) {
    if (fid !== id) overrides[roomId] = fid;
  }
  return { folders: store.folders.filter((f) => f.id !== id), overrides };
}

/** Set a chat's personal placement: a folder id, or null to mark it explicitly
 *  ungrouped (overriding any team-folder default). */
export function setRoomFolder(store: GroupStore, roomId: string, folderId: string | null): GroupStore {
  return { ...store, overrides: { ...store.overrides, [roomId]: folderId ?? "" } };
}
