"use client";

/**
 * Body/identifier-free operational telemetry for local durability boundaries.
 *
 * The queue stores and submits only six counters. It contains no account,
 * device, room, event, operation, draft, filename, content, token, or URL.
 * Telemetry failure is always best effort and can never change a draft/send
 * result.
 */

export type ClientCommitKind = "draft" | "send";
export type ClientCommitOutcome = "attempted" | "succeeded" | "failed";

type OutcomeCounters = Record<ClientCommitOutcome, number>;
export type ClientCommitCounters = Record<ClientCommitKind, OutcomeCounters>;

const STORAGE_KEY = "silicon-interface:reliability-telemetry:v1";
const FLUSH_DELAY_MS = 5_000;
const FAILURE_FLUSH_DELAY_MS = 100;
const RETRY_DELAY_MS = 60_000;
const MAX_BATCH_ATTEMPTS = 128;

let pending: ClientCommitCounters | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let started = false;

function zeroCounters(): ClientCommitCounters {
  return {
    draft: { attempted: 0, succeeded: 0, failed: 0 },
    send: { attempted: 0, succeeded: 0, failed: 0 },
  };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : 0;
}

function normalizeCounters(value: unknown): ClientCommitCounters {
  const raw = value && typeof value === "object"
    ? value as Partial<Record<ClientCommitKind, Partial<OutcomeCounters>>>
    : {};
  const normalized = zeroCounters();
  for (const kind of ["draft", "send"] as const) {
    for (const outcome of ["attempted", "succeeded", "failed"] as const) {
      normalized[kind][outcome] = safeCount(raw[kind]?.[outcome]);
    }
    const terminal = normalized[kind].succeeded + normalized[kind].failed;
    normalized[kind].attempted = Math.max(normalized[kind].attempted, terminal);
  }
  return normalized;
}

function loadPending(): ClientCommitCounters {
  if (pending) return pending;
  let value: unknown = null;
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      value = raw ? JSON.parse(raw) : null;
    } catch {
      value = null;
    }
  }
  pending = normalizeCounters(value);
  return pending;
}

function persistPending(): void {
  if (typeof window === "undefined" || !pending) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // The in-memory copy can still report a storage failure while this page lives.
  }
}

function totalAttempts(counters: ClientCommitCounters): number {
  return counters.draft.attempted + counters.send.attempted;
}

function boundedSnapshot(source: ClientCommitCounters): ClientCommitCounters {
  const snapshot = zeroCounters();
  let remaining = MAX_BATCH_ATTEMPTS;
  for (const kind of ["draft", "send"] as const) {
    const attempted = Math.min(source[kind].attempted, remaining);
    const succeeded = Math.min(source[kind].succeeded, attempted);
    const failed = Math.min(source[kind].failed, attempted - succeeded);
    snapshot[kind] = { attempted, succeeded, failed };
    remaining -= attempted;
  }
  return snapshot;
}

function subtractSnapshot(snapshot: ClientCommitCounters): void {
  const current = loadPending();
  for (const kind of ["draft", "send"] as const) {
    for (const outcome of ["attempted", "succeeded", "failed"] as const) {
      current[kind][outcome] = Math.max(0, current[kind][outcome] - snapshot[kind][outcome]);
    }
  }
  persistPending();
}

function scheduleFlush(delay: number): void {
  if (!started || typeof window === "undefined") return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushClientCommitTelemetry();
  }, delay);
  (flushTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

function increment(
  kind: ClientCommitKind,
  outcome: ClientCommitOutcome,
  persist = true,
): void {
  if (typeof window === "undefined") return;
  const counters = loadPending();
  counters[kind][outcome] = Math.min(
    Number.MAX_SAFE_INTEGER,
    counters[kind][outcome] + 1,
  );
  // The attempt is first kept in memory so observability can never consume the
  // last writable bytes before the user's actual commit. Its terminal outcome
  // persists the pair only after that primary operation has completed.
  if (persist) {
    persistPending();
    scheduleFlush(outcome === "failed" ? FAILURE_FLUSH_DELAY_MS : FLUSH_DELAY_MS);
  }
}

/** Begin one real local durability attempt and return its idempotent finisher. */
export function beginClientDurableCommit(
  kind: ClientCommitKind,
): (succeeded: boolean) => void {
  increment(kind, "attempted", false);
  let finished = false;
  return (succeeded: boolean) => {
    if (finished) return;
    finished = true;
    increment(kind, succeeded ? "succeeded" : "failed");
  };
}

export async function flushClientCommitTelemetry(): Promise<void> {
  if (flushing) return flushing;
  const snapshot = boundedSnapshot(loadPending());
  if (!totalAttempts(snapshot)) return;
  flushing = (async () => {
    try {
      const { api } = await import("./api");
      await api.recordClientDurableCommits({
        schema: 1,
        platform: "web",
        counters: snapshot,
      });
      subtractSnapshot(snapshot);
      if (totalAttempts(loadPending())) scheduleFlush(FLUSH_DELAY_MS);
    } catch {
      scheduleFlush(RETRY_DELAY_MS);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Install one page-lifetime flusher. Recording works before startup as well. */
export function startClientReliabilityTelemetry(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const flush = () => void flushClientCommitTelemetry();
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  scheduleFlush(FLUSH_DELAY_MS);
}

/** Test/support readback is aggregate-only by construction. */
export function pendingClientCommitTelemetry(): ClientCommitCounters {
  return normalizeCounters(loadPending());
}
