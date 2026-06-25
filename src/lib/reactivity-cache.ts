"use client";

/**
 * Remembers the last reactivity number we showed per team, so on the next open
 * the KPI can paint that value immediately and then ease *up* to the fresh
 * count — reactivity reads as continuing from where it left off rather than
 * counting up from zero every visit.
 */

const PREFIX = "silicon-interface:reactivity";

function key(slug: string): string {
  return `${PREFIX}:${encodeURIComponent(slug)}`;
}

export function loadLastReactivity(slug: string): number | null {
  if (typeof window === "undefined" || !slug) return null;
  try {
    const raw = window.localStorage.getItem(key(slug));
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveLastReactivity(slug: string, value: number): void {
  if (typeof window === "undefined" || !slug) return;
  if (!Number.isFinite(value) || value < 0) return;
  try {
    window.localStorage.setItem(key(slug), String(Math.round(value)));
  } catch {
    /* storage unavailable (private mode / quota) — non-critical */
  }
}
