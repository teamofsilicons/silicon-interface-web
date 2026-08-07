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
  /** Local creation/retry time used to keep an older durable outbox replay
   * from replacing a newer sidebar state. */
  at: number;
  /** The accepted preview stays authoritative until the room list projects
   * this exact event (or a genuinely newer event) into `last_event`. */
  acceptedEventId?: string;
  acceptedAt?: string;
}

const cache = new Map<string, PendingPreview | null>();
const acceptedClients = new Map<string, Set<string>>();
const failedSupersededThrough = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function pendingPreviewCandidateWins(
  current: PendingPreview | null,
  candidate: PendingPreview,
  failedThrough = Number.NEGATIVE_INFINITY,
): boolean {
  if (candidate.status === "failed" && candidate.at <= failedThrough) return false;
  return !current || current.clientId === candidate.clientId || candidate.at >= current.at;
}

export function setPendingPreview(roomId: string, entry: PendingPreview): void {
  // Network completion and durable-outbox restoration can race at startup.
  // Once Glass has accepted this exact client id, a stale outbox row must not
  // resurrect it as waiting/failed in the sidebar.
  if (acceptedClients.get(roomId)?.has(entry.clientId)) return;
  const prev = cache.get(roomId) ?? null;
  // A slower IndexedDB restore may finish after the room list/timeline has
  // already observed later authoritative activity. Keep the failed bubble in
  // the timeline for recovery, but never resurrect it as the room's latest
  // sidebar state.
  const failedThrough = failedSupersededThrough.get(roomId) ?? Number.NEGATIVE_INFINITY;
  // Outbox restoration is oldest-first, but it races live sends and held-send
  // frames. The latest intent owns the one sidebar slot regardless of which
  // asynchronous read finishes last.
  if (!pendingPreviewCandidateWins(prev, entry, failedThrough)) return;
  if (
    prev &&
    prev.clientId === entry.clientId &&
    prev.text === entry.text &&
    prev.status === entry.status &&
    prev.at === entry.at
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

/** Whether a failed local intent has already been overtaken by a committed
 * room event. Failed rows remain actionable in the open timeline, but they are
 * no longer the conversation's latest state and must not own its sidebar row. */
export function failedPendingPreviewSuperseded(
  pending: PendingPreview | null,
  lastEvent: { at?: string | null } | null | undefined,
): boolean {
  if (pending?.status !== "failed" || !lastEvent?.at) return false;
  const lastAt = Date.parse(lastEvent.at);
  return Number.isFinite(lastAt) && lastAt >= pending.at;
}

/** Record a committed room tail so late durable restores cannot bring an old
 * failure back. This is monotonic for the lifetime of the client session. */
export function supersedeFailedPendingPreview(roomId: string, at: string): void {
  const observedAt = Date.parse(at);
  if (!Number.isFinite(observedAt)) return;
  failedSupersededThrough.set(
    roomId,
    Math.max(failedSupersededThrough.get(roomId) ?? Number.NEGATIVE_INFINITY, observedAt),
  );
  const pending = cache.get(roomId) ?? null;
  if (pending?.status === "failed" && pending.at <= observedAt) {
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
