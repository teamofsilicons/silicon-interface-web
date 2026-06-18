"use client";

import * as React from "react";

/**
 * The latest *outgoing* message for a room that hasn't yet landed in the
 * sidebar's `last_event` — i.e. a message that's waiting to send (the silicon
 * 5s hold), in flight, or failed. The room view writes it from its optimistic
 * callbacks; the sidebar reads it so a waiting message shows in the preview
 * with its status, instead of the row going blank until the server echoes.
 */
export interface PendingPreview {
  clientId: string;
  text: string;
  status: "waiting" | "failed";
}

const cache = new Map<string, PendingPreview | null>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setPendingPreview(roomId: string, entry: PendingPreview): void {
  const prev = cache.get(roomId) ?? null;
  if (
    prev &&
    prev.clientId === entry.clientId &&
    prev.text === entry.text &&
    prev.status === entry.status
  ) {
    return;
  }
  cache.set(roomId, entry);
  emit();
}

/** Clear the pending preview for a room, but only if it's still the message we
 *  set (matched by clientId) — so acking an older message doesn't wipe a newer
 *  one that's now waiting. */
export function clearPendingPreview(roomId: string, clientId: string): void {
  const prev = cache.get(roomId) ?? null;
  if (prev && prev.clientId === clientId) {
    cache.set(roomId, null);
    emit();
  }
}

/** Update the preview text for a still-pending message (e.g. held-queue merge),
 *  only if it's still the current one. */
export function updatePendingPreview(roomId: string, clientId: string, text: string): void {
  const prev = cache.get(roomId) ?? null;
  if (prev && prev.clientId === clientId && prev.text !== text) {
    cache.set(roomId, { ...prev, text });
    emit();
  }
}

/** Drop a room's pending preview regardless of which message set it — used when
 *  a real event lands for the room (the waiting message is now superseded). */
export function dropPendingPreview(roomId: string): void {
  if (cache.get(roomId)) {
    cache.set(roomId, null);
    emit();
  }
}

export function failPendingPreview(roomId: string, clientId: string): void {
  const prev = cache.get(roomId) ?? null;
  if (prev && prev.clientId === clientId && prev.status !== "failed") {
    cache.set(roomId, { ...prev, status: "failed" });
    emit();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function usePendingPreview(roomId: string): PendingPreview | null {
  return React.useSyncExternalStore(
    subscribe,
    () => cache.get(roomId) ?? null,
    () => null,
  );
}
