export type HeartbeatPolicy = { intervalMs: number; timeoutMs: number };
export type HeartbeatAction = "wait" | "ping" | "reconnect";
export type SocketCloseAction = "stop" | "wait_for_network" | "reconnect_and_sync";

export const DEFAULT_HEARTBEAT_POLICY: HeartbeatPolicy = {
  intervalMs: 25_000,
  timeoutMs: 62_500,
};

// Browsers may receive IANA close codes such as 1013 from a server, but the
// WebSocket API only permits clients to send 1000 or an application code in
// 3000..4999. Use one stable application code whenever the client tears down
// a socket to force an authoritative sync repair.
export const CLIENT_SYNC_REPAIR_CLOSE_CODE = 4101;

const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

export function normalizeHeartbeatPolicy(
  intervalMs: number,
  timeoutMs: number,
): HeartbeatPolicy {
  let interval = Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.trunc(intervalMs)
    : DEFAULT_HEARTBEAT_POLICY.intervalMs;
  let timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.trunc(timeoutMs)
    : DEFAULT_HEARTBEAT_POLICY.timeoutMs;
  interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, interval));
  timeout = Math.min(MAX_TIMEOUT_MS, Math.max(interval * 2, timeout));
  return { intervalMs: interval, timeoutMs: timeout };
}

export function heartbeatAction(options: {
  networkAvailable: boolean;
  socketOpen: boolean;
  waking: boolean;
  elapsedMs: number;
  policy: HeartbeatPolicy;
}): HeartbeatAction {
  if (!options.networkAvailable) return "wait";
  if (!options.socketOpen) return "reconnect";
  if (
    options.elapsedMs >= options.policy.timeoutMs ||
    (options.waking && options.elapsedMs >= options.policy.intervalMs)
  ) {
    return "reconnect";
  }
  return "ping";
}

export function socketCloseAction(options: {
  code: number;
  networkAvailable: boolean;
  wanted: boolean;
}): SocketCloseAction {
  void options.code;
  if (!options.wanted) return "stop";
  if (!options.networkAvailable) return "wait_for_network";
  return "reconnect_and_sync";
}
