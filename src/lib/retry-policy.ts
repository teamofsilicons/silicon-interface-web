export interface ClientRetryDecision {
  state: "queued" | "blocked";
  nextAttemptAt: number;
}

/** Shared client contract. `attempts` is the post-failure attempt count and all
 * timestamps are epoch milliseconds. Jitter is injectable for conformance tests. */
export function decideClientRetry(
  httpStatus: number,
  attempts: number,
  now: number,
  jitter = 0.5 + Math.random(),
  retryAfterMs: number | null = null,
): ClientRetryDecision {
  const terminal =
    httpStatus >= 400 &&
    httpStatus < 500 &&
    ![408, 425, 429].includes(httpStatus);
  if (terminal) return { state: "blocked", nextAttemptAt: 0 };
  const ceiling = Math.min(1_000 * 2 ** Math.min(attempts, 6), 60_000);
  const exponential = now + Math.floor(ceiling * jitter);
  const providerFloor = now + Math.max(0, retryAfterMs ?? 0);
  return { state: "queued", nextAttemptAt: Math.max(exponential, providerFloor) };
}
