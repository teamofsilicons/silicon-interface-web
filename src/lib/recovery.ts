"use client";

const PREFIX = "silicon-interface:recovery";

function recoveryKey(name: string): string {
  return `${PREFIX}:${name}`;
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return `${reason.name} ${reason.message}`;
  if (reason && typeof reason === "object") {
    const fields = reason as { name?: unknown; message?: unknown; reason?: unknown };
    return [fields.name, fields.message, fields.reason].filter(Boolean).join(" ");
  }
  return "";
}

export function markRecoveryAttempt(name: string, cooldownMs = 10_000): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = recoveryKey(name);
    const now = Date.now();
    const last = Number(window.sessionStorage.getItem(key) ?? 0);
    if (Number.isFinite(last) && now - last < cooldownMs) return false;
    window.sessionStorage.setItem(key, String(now));
    return true;
  } catch {
    return false;
  }
}

export function isLikelyStaleNextRouteError(reason: unknown): boolean {
  const text = reasonText(reason);
  if (!text) return false;
  return /ChunkLoadError|Loading chunk|CSS_CHUNK_LOAD_FAILED|failed to fetch dynamically imported module|importing a module script failed|module script load/i.test(
    text,
  );
}

export function reloadOnce(name: string, cooldownMs = 10_000): boolean {
  if (!markRecoveryAttempt(name, cooldownMs)) return false;
  window.location.reload();
  return true;
}
