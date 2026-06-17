"use client";

import * as React from "react";

/**
 * Per-room composer drafts, persisted to localStorage and observable so the
 * sidebar can show a "draft: …" preview.
 *
 * Two layers:
 *   • live     — updated on every keystroke; persisted immediately so a reload
 *                or chat-switch restores exactly what was being typed.
 *   • published — what the sidebar shows. Debounced: it only catches up to live
 *                after the user pauses typing (PUBLISH_DELAY_MS) or when the
 *                draft is flushed (chat switch) / cleared (send). This keeps the
 *                sidebar from flickering on every keystroke.
 */
const PREFIX = "silicon-interface:draft:";
const PUBLISH_DELAY_MS = 2000;

function storageKey(roomId: string): string {
  return `${PREFIX}${roomId}`;
}

const liveCache = new Map<string, string>();
const publishedCache = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let storageBound = false;

function emit() {
  for (const fn of listeners) fn();
}

function readLS(roomId: string): string {
  try {
    return window.localStorage.getItem(storageKey(roomId)) ?? "";
  } catch {
    return "";
  }
}

function ensureStorageBound() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  // Cross-tab edits: drop both caches for the affected key and re-notify.
  window.addEventListener("storage", (e) => {
    if (e.key && !e.key.startsWith(PREFIX)) return;
    if (e.key) {
      const id = e.key.slice(PREFIX.length);
      liveCache.delete(id);
      publishedCache.delete(id);
    } else {
      liveCache.clear();
      publishedCache.clear();
    }
    emit();
  });
}

/** Live draft text (latest keystroke) — used to restore the composer. */
export function getDraft(roomId: string): string {
  if (typeof window === "undefined") return "";
  const cached = liveCache.get(roomId);
  if (cached !== undefined) return cached;
  const v = readLS(roomId);
  liveCache.set(roomId, v);
  if (!publishedCache.has(roomId)) publishedCache.set(roomId, v);
  return v;
}

function publishedDraft(roomId: string): string {
  if (typeof window === "undefined") return "";
  const cached = publishedCache.get(roomId);
  if (cached !== undefined) return cached;
  const v = readLS(roomId);
  publishedCache.set(roomId, v);
  return v;
}

function publish(roomId: string) {
  const v = liveCache.get(roomId) ?? "";
  if (publishedCache.get(roomId) === v) return;
  publishedCache.set(roomId, v);
  emit();
}

export function setDraft(roomId: string, text: string): void {
  if (typeof window === "undefined") return;
  const v = text.trim() ? text : "";
  // Live + persistence update immediately so a reload / restore is exact.
  if (liveCache.get(roomId) !== v) {
    liveCache.set(roomId, v);
    try {
      if (v) window.localStorage.setItem(storageKey(roomId), v);
      else window.localStorage.removeItem(storageKey(roomId));
    } catch {
      /* ignore quota / private-mode errors */
    }
  }
  const t = timers.get(roomId);
  if (t) {
    clearTimeout(t);
    timers.delete(roomId);
  }
  // Clearing (e.g. on send) publishes at once so the sidebar drops the draft
  // instantly; otherwise wait for a typing pause before the sidebar catches up.
  if (!v) {
    publish(roomId);
    return;
  }
  timers.set(
    roomId,
    setTimeout(() => {
      timers.delete(roomId);
      publish(roomId);
    }, PUBLISH_DELAY_MS),
  );
}

/** Publish the current live draft to the sidebar immediately — call on chat
 *  switch so the room you're leaving shows its draft without waiting. */
export function flushDraft(roomId: string): void {
  if (typeof window === "undefined") return;
  const t = timers.get(roomId);
  if (t) {
    clearTimeout(t);
    timers.delete(roomId);
  }
  publish(roomId);
}

function subscribe(cb: () => void): () => void {
  ensureStorageBound();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Live (debounced) draft text for one room's sidebar preview. */
export function useDraft(roomId: string): string {
  return React.useSyncExternalStore(
    subscribe,
    () => publishedDraft(roomId),
    () => "",
  );
}
