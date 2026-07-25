import type { AuthChange } from "./auth";

export type SocketAuthAction = "ignore" | "connect" | "restart" | "close";

/**
 * A WebSocket is authenticated at handshake time. Refreshing the HTTP access
 * token or editing the profile does not change that established principal and
 * must not churn the live connection.
 */
export function socketActionForAuthChange({
  change,
  socketPresent,
  hasAuthority,
}: {
  change: AuthChange;
  socketPresent: boolean;
  hasAuthority: boolean;
}): SocketAuthAction {
  if (change === "cleared") return "close";
  if (change === "silicon-key" || change === "session") {
    return hasAuthority ? "restart" : "close";
  }
  if (!socketPresent && hasAuthority && change === "tokens") return "connect";
  return "ignore";
}
