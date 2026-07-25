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
  status: "waiting" | "failed" | "accepted";
  /** The accepted preview stays authoritative until the room list projects
   * this exact event (or a genuinely newer event) into `last_event`. */
  acceptedEventId?: string;
  acceptedAt?: string;
}

const cache = new Map<string, PendingPreview | null>();
const acceptedClients = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setPendingPreview(roomId: string, entry: PendingPreview): void {
  // Network completion and durable-outbox restoration can race at startup.
  // Once Glass has accepted this exact client id, a stale outbox row must not
  // resurrect it as waiting/failed in the sidebar.
  if (acceptedClients.get(roomId)?.has(entry.clientId)) return;
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

/** Record authoritative acceptance before clearing the optimistic preview.
 * Unlike a plain clear, this is monotonic for the lifetime of the page and
 * therefore also blocks a slower IndexedDB/outbox read from reintroducing it. */
export function markPendingPreviewAccepted(
  roomId: string,
  clientId: string,
  acceptedEvent?: { eventId: string; at: string },
): void {
  let accepted = acceptedClients.get(roomId);
  if (!accepted) {
    accepted = new Set<string>();
    acceptedClients.set(roomId, accepted);
  }
  accepted.add(clientId);
  const pending = cache.get(roomId) ?? null;
  if (acceptedEvent && pending?.clientId === clientId) {
    cache.set(roomId, {
      ...pending,
      status: "accepted",
      acceptedEventId: acceptedEvent.eventId,
      acceptedAt: acceptedEvent.at,
    });
    emit();
    return;
  }
  clearPendingPreview(roomId, clientId);
}

/** An accepted local preview closes only when the sidebar catches that exact
 * event or has already advanced to a later authoritative event. This prevents
 * the acknowledgement render from briefly revealing the previous message. */
export function acceptedPendingPreviewCovered(
  pending: PendingPreview | null,
  lastEvent: { event_id?: string | null; at?: string | null } | null | undefined,
): boolean {
  if (pending?.status !== "accepted" || !lastEvent) return false;
  if (pending.acceptedEventId && lastEvent.event_id === pending.acceptedEventId) return true;
  if (!pending.acceptedAt || !lastEvent.at) return false;
  const acceptedAt = Date.parse(pending.acceptedAt);
  const lastAt = Date.parse(lastEvent.at);
  return Number.isFinite(acceptedAt) && Number.isFinite(lastAt) && lastAt >= acceptedAt;
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
  if (acceptedClients.get(roomId)?.has(clientId)) return;
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
