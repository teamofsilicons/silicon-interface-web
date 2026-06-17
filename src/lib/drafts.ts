"use client";

import * as React from "react";

/**
 * Per-room composer drafts, persisted to localStorage and observable so the
 * sidebar can show a "draft: …" preview that updates live as you type. The
 * storage key matches the composer's original scheme, so existing drafts carry
 * over. An in-memory cache keeps reads O(1) (the sidebar reads one per room on
 * every keystroke) and lets us notify subscribers within the same tab.
 */
const PREFIX = "silicon-interface:draft:";

function storageKey(roomId: string): string {
  return `${PREFIX}${roomId}`;
}

const cache = new Map<string, string>();
const listeners = new Set<() => void>();
let storageBound = false;

function emit() {
  for (const fn of listeners) fn();
}

function ensureStorageBound() {
  if (storageBound || typeof window === "undefined") return;
  storageBound = true;
  // Cross-tab edits: drop the affected cache entry and re-notify.
  window.addEventListener("storage", (e) => {
    if (e.key && !e.key.startsWith(PREFIX)) return;
    if (e.key) cache.delete(e.key.slice(PREFIX.length));
    else cache.clear();
    emit();
  });
}

export function getDraft(roomId: string): string {
  if (typeof window === "undefined") return "";
  const cached = cache.get(roomId);
  if (cached !== undefined) return cached;
  let v = "";
  try {
    v = window.localStorage.getItem(storageKey(roomId)) ?? "";
  } catch {
    /* storage unavailable — treat as no draft */
  }
  cache.set(roomId, v);
  return v;
}

export function setDraft(roomId: string, text: string): void {
  if (typeof window === "undefined") return;
  const v = text.trim() ? text : "";
  if (cache.get(roomId) === v) return; // no-op — don't churn listeners
  cache.set(roomId, v);
  try {
    if (v) window.localStorage.setItem(storageKey(roomId), v);
    else window.localStorage.removeItem(storageKey(roomId));
  } catch {
    /* ignore quota / private-mode errors */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  ensureStorageBound();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Live draft text for one room (empty string when none). Re-renders on change. */
export function useDraft(roomId: string): string {
  return React.useSyncExternalStore(
    subscribe,
    () => getDraft(roomId),
    () => "",
  );
}
