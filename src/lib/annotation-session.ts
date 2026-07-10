"use client";

import type { Annotation } from "./annotation-types";

/**
 * Autosave for an in-progress annotation session, so work is never lost across a
 * refresh, tab close, or crash. Scoped per (room, source media) — the same
 * attachment always restores its own draft. Follows the `drafts.ts` conventions:
 * `silicon-interface:…` key prefix and try/catch that swallows quota / private-
 * mode errors (autosave is best-effort, never fatal).
 *
 * Only the normalized markup + comments are stored (a few KB), so a restore is
 * exact regardless of the window size it was drawn at. The posted chat message
 * (Milestone 5) is the durable record; this is the working draft behind it.
 */
const PREFIX = "silicon-interface:annotations:";

function storageKey(roomId: string, mediaId: string): string {
  return `${PREFIX}${roomId}:${mediaId}`;
}

interface StoredSession {
  annotations: Annotation[];
  updatedAt: number;
}

/** Restore a saved session's annotations, or [] if none / unreadable. */
export function loadAnnotationSession(roomId: string, mediaId: string): Annotation[] {
  if (typeof window === "undefined" || !roomId || !mediaId) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(roomId, mediaId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredSession;
    return Array.isArray(parsed?.annotations) ? parsed.annotations : [];
  } catch {
    return [];
  }
}

/** Persist the current annotations. An empty set clears the key. */
export function saveAnnotationSession(roomId: string, mediaId: string, annotations: Annotation[]): void {
  if (typeof window === "undefined" || !roomId || !mediaId) return;
  try {
    if (annotations.length === 0) {
      window.localStorage.removeItem(storageKey(roomId, mediaId));
      return;
    }
    const payload: StoredSession = { annotations, updatedAt: Date.now() };
    window.localStorage.setItem(storageKey(roomId, mediaId), JSON.stringify(payload));
  } catch {
    /* quota / private-mode — best-effort, never fatal */
  }
}

/** Drop the saved session (after a successful attach). */
export function clearAnnotationSession(roomId: string, mediaId: string): void {
  if (typeof window === "undefined" || !roomId || !mediaId) return;
  try {
    window.localStorage.removeItem(storageKey(roomId, mediaId));
  } catch {
    /* ignore */
  }
}

/** Highest reference-code number among annotations (0 if none) — seeds the
 *  monotonic code counter after a restore so codes never collide. */
export function maxRefCodeNumber(annotations: Annotation[]): number {
  let max = 0;
  for (const a of annotations) {
    const code = a.fallbackCode || a.refCode;
    const n = parseInt(code.replace(/^A/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
