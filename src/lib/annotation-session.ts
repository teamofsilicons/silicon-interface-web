"use client";

import type { Annotation } from "./annotation-types";

/** Position 0…25 is a…z. Further blocks append 1, 2, etc. */
export function annotationLabel(index: number): string {
  const safe = Math.max(0, Math.floor(index));
  const letter = String.fromCharCode(97 + (safe % 26));
  const cycle = Math.floor(safe / 26);
  return cycle === 0 ? letter : `${letter}${cycle}`;
}

/** Labels deliberately track list order, so deletes and legacy restores stay
 * deterministic. Legacy AI/A1 fields are omitted from the normalized object. */
export function reindexAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.map((annotation, index) => {
    const rest = { ...annotation } as Annotation & {
      fallbackCode?: string;
      refStatus?: string;
    };
    delete rest.fallbackCode;
    delete rest.refStatus;
    return { ...rest, refCode: annotationLabel(index) };
  });
}

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
    return Array.isArray(parsed?.annotations) ? reindexAnnotations(parsed.annotations) : [];
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
