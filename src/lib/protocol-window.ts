export type ProtocolCompatibility =
  | "compatible"
  | "client_upgrade_required"
  | "server_upgrade_required"
  | "invalid_window";

export function protocolCompatibility(
  clientVersion: number,
  serverMin: number,
  serverMax: number,
): ProtocolCompatibility {
  if (serverMin > serverMax) return "invalid_window";
  if (clientVersion < serverMin) return "client_upgrade_required";
  if (clientVersion > serverMax) return "server_upgrade_required";
  return "compatible";
}
