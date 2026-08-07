"use client";

import type { Contact, Room, Team, TeamMembership } from "./types";
import { normalizeRooms } from "./room-shape";
import { normalizeTeams } from "./team-shape";

// v3: membership map is keyed by carbon_id/silicon_id (was name/handle in v≤2).
// v4: per-slice write times, so an unbounded-staleness slice can expire without
//     a room-list write pretending the roster was just refreshed.
const VERSION = 4;
const PREFIX = "silicon-interface:sidebar-cache";

/**
 * Slices covered by the durable account-sync stream (`room.upsert`,
 * `room.remove`, `room.notifications`, `room.list_preferences`) are corrected by
 * cursor, not by age: a room the server never changed is not stale at any age,
 * and expiring it would only trade a correct instant paint for a spinner.
 *
 * Contacts, teams, and team rosters have no delta path in the sync stream at
 * all — their only correction is a full refetch that has to succeed. Left
 * untimed they could render a months-old roster after any run of failed
 * refreshes, styling mentions for people who have since left. Bound them so a
 * cache that old reports "no data" and the UI waits for the authoritative list
 * instead of asserting a wrong one.
 */
export const ROSTER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

type TimedSlice = "contacts" | "teams" | "teamRosters" | "memberships";
const TIMED_SLICES: readonly TimedSlice[] = [
  "contacts",
  "teams",
  "teamRosters",
  // Derived from the same rosters, and just as wrong when they age out: a
  // direct chat keeps landing in a team the member has already left.
  "memberships",
];

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
  /** Write time per age-bounded slice. Only the written slices advance. */
  sliceSavedAt: Partial<Record<TimedSlice, number>>;
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
    sliceSavedAt: {},
    savedAt: Date.now(),
  };
}

/** A slice with no recorded write time is treated as expired, never as fresh. */
function sliceIsFresh(
  cached: SidebarCache,
  slice: TimedSlice,
  now = Date.now(),
): boolean {
  const savedAt = cached.sliceSavedAt[slice];
  return typeof savedAt === "number" &&
    Number.isFinite(savedAt) &&
    now - savedAt < ROSTER_CACHE_MAX_AGE_MS;
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
    const sliceSavedAt: Partial<Record<TimedSlice, number>> = {};
    const rawSliceSavedAt =
      parsed.sliceSavedAt && typeof parsed.sliceSavedAt === "object"
        ? (parsed.sliceSavedAt as Record<string, unknown>)
        : {};
    for (const slice of TIMED_SLICES) {
      const value = rawSliceSavedAt[slice];
      if (typeof value === "number" && Number.isFinite(value)) sliceSavedAt[slice] = value;
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
      sliceSavedAt,
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
  const current = read(ownerId) ?? empty(ownerId);
  const now = Date.now();
  // Only slices present in this patch advance. A room-list write must never
  // renew the roster clock — that is exactly how an untimed cache appears
  // perpetually fresh while going perpetually stale.
  const sliceSavedAt = { ...current.sliceSavedAt };
  for (const slice of TIMED_SLICES) {
    if (slice in patch) sliceSavedAt[slice] = now;
  }
  const next: SidebarCache = {
    ...current,
    ...patch,
    sliceSavedAt,
    savedAt: now,
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
  return cached && sliceIsFresh(cached, "contacts") ? cached.contacts : null;
}

export function saveCachedContacts(ownerId: string, contacts: Contact[]) {
  write(ownerId, { contacts });
}

export function loadCachedTeams(ownerId: string): Team[] | null {
  const cached = read(ownerId);
  return cached && sliceIsFresh(cached, "teams") ? cached.teams : null;
}

export function saveCachedTeams(ownerId: string, teams: Team[]) {
  write(ownerId, { teams: normalizeTeams(teams) });
}

/** Returns the cached `${kind}:${handle}` → team-slugs map, or null when there
 *  is no cache yet (so callers can tell "no data" from "empty roster"). */
export function loadCachedMemberships(ownerId: string | null): Map<string, Set<string>> | null {
  if (!ownerId) return null;
  const cached = read(ownerId);
  if (!cached || !sliceIsFresh(cached, "memberships")) return null;
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
  if (
    !cached ||
    !sliceIsFresh(cached, "teamRosters") ||
    !Object.prototype.hasOwnProperty.call(cached.teamRosters, teamSlug)
  ) {
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

/** Owners holding a sidebar cache in this browser profile. */
export function listCachedSidebarOwners(): string[] {
  if (typeof window === "undefined") return [];
  const owners: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const storageKey = window.localStorage.key(index);
      if (!storageKey?.startsWith(`${PREFIX}:`)) continue;
      try {
        owners.push(decodeURIComponent(storageKey.slice(PREFIX.length + 1)));
      } catch {
        // A key we cannot decode is not one we wrote; leave it untouched.
      }
    }
  } catch {
    return [];
  }
  return owners;
}

export function clearCachedSidebar(ownerId: string | null | undefined): void {
  if (typeof window === "undefined" || !ownerId) return;
  try {
    window.localStorage.removeItem(key(ownerId));
  } catch {
    /* storage unavailable — nothing retained to clear */
  }
}

/** Retire every sidebar cache except the owner signing in. */
export function purgeForeignSidebarCaches(currentOwnerId: string): string[] {
  if (!currentOwnerId) return [];
  const foreign = listCachedSidebarOwners().filter((ownerId) => ownerId !== currentOwnerId);
  for (const ownerId of foreign) clearCachedSidebar(ownerId);
  return foreign;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // The room list, contacts, and rosters are replaceable Glass projections. An
  // authoritative end of session must not leave them readable on a shared
  // device; everything here is re-downloaded on the next sign-in.
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const ownerKey = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey;
    if (ownerKey?.startsWith("carbon:")) clearCachedSidebar(ownerKey.slice("carbon:".length));
  });
}
