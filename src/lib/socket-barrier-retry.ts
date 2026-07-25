import type { ChatConnectionState } from "./connection-status";
import type { ConnectivityClass } from "./connectivity-classifier";

export const MAX_SOCKET_BARRIER_RETRY_MS = 15_000;

export function socketBarrierRetryDelayMs(
  attempt: number,
  random = Math.random(),
): number {
  const exponent = Math.max(0, Math.min(30, Math.trunc(attempt)));
  const base = Math.min(1_000 * 2 ** exponent, MAX_SOCKET_BARRIER_RETRY_MS);
  const boundedRandom = Number.isFinite(random)
    ? Math.min(1, Math.max(0, random))
    : 0.5;
  return Math.round(base * (0.5 + boundedRandom));
}

export function applicationStateForConnectivity(
  connectivity: ConnectivityClass,
): ChatConnectionState {
  return connectivity === "reachable" ? "online" : connectivity;
}

export function waitForSocketBarrierRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Sync generation was superseded", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, Math.max(0, delayMs));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Sync generation was superseded", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
