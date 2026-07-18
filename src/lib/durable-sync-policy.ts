export type DurableSyncSocketState =
  | "offline"
  | "captive"
  | "degraded"
  | "connecting"
  | "authenticating"
  | "syncing"
  | "online";

/**
 * WebSocket is the fastest paint path, but a heartbeat cannot prove that every
 * room fan-out reached this client. Keep one durable ordered sync request alive
 * after the socket barrier, and also while the socket is unavailable. During a
 * connect/barrier transition that barrier exclusively owns the same cursors.
 */
export function shouldRunDurableSync(input: {
  ownerId: string | null;
  socketState: DurableSyncSocketState;
  socketReady: boolean;
  networkAvailable: boolean;
}): boolean {
  if (!input.ownerId || !input.networkAvailable) return false;
  if (input.socketReady && input.socketState === "online") return true;
  return input.socketState === "offline" || input.socketState === "degraded";
}
