"use client";

export type StorageHealthIssue = {
  severity: "degraded" | "blocked";
  area: "outbox" | "timeline" | "media" | "drafts";
  message: string;
  at: number;
};

export const STORAGE_HEALTH_EVENT = "silicon:storage-health";
let current: StorageHealthIssue | null = null;

export function reportStorageIssue(
  issue: Omit<StorageHealthIssue, "at">,
): StorageHealthIssue {
  const next = { ...issue, at: Date.now() };
  if (current?.severity === "blocked" && next.severity === "degraded") return current;
  current = next;
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent(STORAGE_HEALTH_EVENT, { detail: next }));
  }
  return next;
}

export function currentStorageIssue(): StorageHealthIssue | null {
  return current;
}

export function clearStorageIssue(area: StorageHealthIssue["area"]): void {
  if (current?.area !== area) return;
  current = null;
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent(STORAGE_HEALTH_EVENT, { detail: null }));
  }
}

/** Support diagnostics deliberately exclude account/room IDs, filenames,
 * message content, browser profile paths, tokens, and keys. */
export async function storageSupportReport(
  issue: StorageHealthIssue,
): Promise<string> {
  let usage = 0;
  let quota = 0;
  try {
    const estimate = await navigator.storage?.estimate?.();
    usage = Math.max(0, Math.trunc(estimate?.usage ?? 0));
    quota = Math.max(0, Math.trunc(estimate?.quota ?? 0));
  } catch { /* unavailable evidence stays zero */ }
  return [
    "Silicon browser-storage recovery report v1",
    `severity=${issue.severity}`,
    `area=${issue.area}`,
    `storage_usage_bytes=${usage}`,
    `storage_quota_bytes=${quota}`,
    "content_included=false",
    "identifiers_included=false",
    "credentials_included=false",
  ].join("\n");
}
