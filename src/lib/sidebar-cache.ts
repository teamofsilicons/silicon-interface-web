"use client";

import type { Contact, Room } from "./types";

const VERSION = 1;
const PREFIX = "silicon-interface:sidebar-cache";

interface SidebarCache {
  version: typeof VERSION;
  ownerId: string;
  rooms: Room[];
  contacts: Contact[];
  savedAt: number;
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function empty(ownerId: string): SidebarCache {
  return { version: VERSION, ownerId, rooms: [], contacts: [], savedAt: Date.now() };
}

function read(ownerId: string): SidebarCache | null {
  if (typeof window === "undefined" || !ownerId) return null;
  const raw = window.localStorage.getItem(key(ownerId));
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
    return parsed as SidebarCache;
  } catch {
    return null;
  }
}

function write(ownerId: string, patch: Partial<Pick<SidebarCache, "rooms" | "contacts">>) {
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
      window.localStorage.removeItem(key(ownerId));
    }
  }
}

export function loadCachedRooms(ownerId: string): Room[] | null {
  const cached = read(ownerId);
  return cached ? cached.rooms : null;
}

export function saveCachedRooms(ownerId: string, rooms: Room[]) {
  write(ownerId, { rooms });
}

export function loadCachedContacts(ownerId: string): Contact[] | null {
  const cached = read(ownerId);
  return cached ? cached.contacts : null;
}

export function saveCachedContacts(ownerId: string, contacts: Contact[]) {
  write(ownerId, { contacts });
}
