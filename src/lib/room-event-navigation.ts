"use client";

const PENDING_JUMP_TTL_MS = 5 * 60 * 1000;
const pending = new Map<string, { eventId: string; queuedAt: number }>();

export function queueRoomEventJump(roomId: string, eventId: string): void {
  pending.set(roomId, { eventId, queuedAt: Date.now() });
}

export function takeRoomEventJump(roomId: string, now = Date.now()): string | null {
  const jump = pending.get(roomId);
  pending.delete(roomId);
  if (!jump || now - jump.queuedAt >= PENDING_JUMP_TTL_MS) return null;
  return jump.eventId;
}
