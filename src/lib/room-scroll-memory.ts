"use client";

import type { Event } from "./types";

export const ROOM_SCROLL_MEMORY_TTL_MS = 60 * 60 * 1000;

export interface RoomScrollMemory {
  savedAt: number;
  anchorEventId: string | null;
  anchorOffset: number;
  scrollTop: number;
  atBottom: boolean;
  events: Event[];
}

const memories = new Map<string, RoomScrollMemory>();

function removeExpired(now: number): void {
  for (const [roomId, memory] of memories) {
    if (now - memory.savedAt >= ROOM_SCROLL_MEMORY_TTL_MS) memories.delete(roomId);
  }
}

export function rememberRoomScroll(
  roomId: string,
  memory: Omit<RoomScrollMemory, "savedAt">,
  now = Date.now(),
): void {
  removeExpired(now);
  memories.set(roomId, {
    ...memory,
    savedAt: now,
    events: [...memory.events],
  });
}

/**
 * A chat switch is restored only during the next hour. Expired entries are
 * deliberately returned as absent so the normal room-open path owns a trip to
 * the newest message.
 */
export function readRoomScrollMemory(
  roomId: string,
  now = Date.now(),
): RoomScrollMemory | null {
  removeExpired(now);
  const memory = memories.get(roomId);
  return memory ? { ...memory, events: [...memory.events] } : null;
}

export function clearRoomScrollMemories(): void {
  memories.clear();
}
