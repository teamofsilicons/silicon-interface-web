"use client";

import type { Contact, Room, Team, TeamMembership } from "./types";
import { normalizeRooms } from "./room-shape";
import { normalizeTeams } from "./team-shape";

// v3: membership map is keyed by carbon_id/silicon_id (was name/handle in v≤2).
const VERSION = 3;
const PREFIX = "silicon-interface:sidebar-cache";

interface SidebarCache {
  version: typeof VERSION;
  ownerId: string;
  rooms: Room[];
  contacts: Contact[];
  teams: Team[];
  /** `${kind}:${handle}` → team slugs that member belongs to. Lets a direct
   *  chat land in the right team tab on first paint instead of flashing in
   *  "Others" while the team rosters refetch. */
  memberships: Record<string, string[]>;
  /** Full team rosters keyed by slug, used to style mentions on first paint. */
  teamRosters: Record<string, TeamMembership[]>;
  savedAt: number;
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function empty(ownerId: string): SidebarCache {
  return {
    version: VERSION,
    ownerId,
    rooms: [],
    contacts: [],
    teams: [],
    memberships: {},
    teamRosters: {},
    savedAt: Date.now(),
  };
}

function read(ownerId: string): SidebarCache | null {
  if (typeof window === "undefined" || !ownerId) return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key(ownerId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SidebarCache>;
    if (
      parsed.version !== VERSION ||
      parsed.ownerId !== ownerId ||
      !Array.isArray(parsed.rooms) ||
      !Array.isArray(parsed.contacts)
    ) {
      return null;
    }
    return {
      version: VERSION,
      ownerId,
      rooms: normalizeRooms(parsed.rooms),
      contacts: parsed.contacts,
      teams: normalizeTeams(parsed.teams),
      memberships:
        parsed.memberships && typeof parsed.memberships === "object"
          ? (parsed.memberships as Record<string, string[]>)
          : {},
      teamRosters:
        parsed.teamRosters && typeof parsed.teamRosters === "object"
          ? (parsed.teamRosters as Record<string, TeamMembership[]>)
          : {},
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function write(
  ownerId: string,
  patch: Partial<
    Pick<SidebarCache, "rooms" | "contacts" | "teams" | "memberships" | "teamRosters">
  >,
) {
  if (typeof window === "undefined" || !ownerId) return;
  const next: SidebarCache = {
    ...(read(ownerId) ?? empty(ownerId)),
    ...patch,
    savedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(key(ownerId), JSON.stringify(next));
  } catch {
    // Keep the most recent sidebar usable even under a tight localStorage quota.
    const pruned = { ...next, rooms: next.rooms.slice(0, 200) };
    try {
      window.localStorage.setItem(key(ownerId), JSON.stringify(pruned));
    } catch {
      try {
        window.localStorage.removeItem(key(ownerId));
      } catch {
        /* storage unavailable — cache is best-effort */
      }
    }
  }
}

export function loadCachedRooms(ownerId: string): Room[] | null {
  const cached = read(ownerId);
  if (!cached || cached.rooms.length === 0) return null;
  return cached.rooms;
}

export function saveCachedRooms(ownerId: string, rooms: Room[]) {
  write(ownerId, { rooms: normalizeRooms(rooms) });
}

export function loadCachedContacts(ownerId: string): Contact[] | null {
  const cached = read(ownerId);
  return cached ? cached.contacts : null;
}

export function saveCachedContacts(ownerId: string, contacts: Contact[]) {
  write(ownerId, { contacts });
}

export function loadCachedTeams(ownerId: string): Team[] | null {
  const cached = read(ownerId);
  return cached ? cached.teams : null;
}

export function saveCachedTeams(ownerId: string, teams: Team[]) {
  write(ownerId, { teams: normalizeTeams(teams) });
}

/** Returns the cached `${kind}:${handle}` → team-slugs map, or null when there
 *  is no cache yet (so callers can tell "no data" from "empty roster"). */
export function loadCachedMemberships(ownerId: string | null): Map<string, Set<string>> | null {
  if (!ownerId) return null;
  const cached = read(ownerId);
  if (!cached) return null;
  const entries = Object.entries(cached.memberships);
  if (entries.length === 0) return null;
  const map = new Map<string, Set<string>>();
  for (const [k, slugs] of entries) {
    if (Array.isArray(slugs)) map.set(k, new Set(slugs));
  }
  return map.size ? map : null;
}

export function saveCachedMemberships(
  ownerId: string | null,
  memberships: Map<string, Set<string>>,
) {
  if (!ownerId) return;
  const rec: Record<string, string[]> = {};
  for (const [k, set] of memberships) rec[k] = [...set];
  write(ownerId, { memberships: rec });
}

export function loadCachedTeamRoster(
  ownerId: string | null,
  teamSlug: string | null,
): TeamMembership[] | null {
  if (!ownerId || !teamSlug) return null;
  const cached = read(ownerId);
  if (!cached || !Object.prototype.hasOwnProperty.call(cached.teamRosters, teamSlug)) {
    return null;
  }
  const rows = cached.teamRosters[teamSlug];
  return Array.isArray(rows) ? rows : null;
}

export function saveCachedTeamRoster(
  ownerId: string | null,
  teamSlug: string | null,
  rows: TeamMembership[],
) {
  if (!ownerId || !teamSlug) return;
  const current = read(ownerId)?.teamRosters ?? {};
  write(ownerId, { teamRosters: { ...current, [teamSlug]: rows } });
}
