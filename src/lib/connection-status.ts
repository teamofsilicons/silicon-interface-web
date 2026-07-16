export type ChatConnectionState =
  | "offline"
  | "captive"
  | "degraded"
  | "connecting"
  | "authenticating"
  | "syncing"
  | "online";

const STATUS_COPY: Record<Exclude<ChatConnectionState, "online">, string> = {
  offline: "You’re offline",
  captive: "Check your connection",
  degraded: "Connection is unstable",
  connecting: "Connecting…",
  authenticating: "Connecting…",
  syncing: "Connecting…",
};

export function connectionStatusCopy(
  state: ChatConnectionState | undefined,
): string | null {
  if (!state || state === "online") return null;
  return STATUS_COPY[state];
}

/** Application-wide connectivity belongs in the top banner. Handshake and
 * room-fetch phases stay local to the chat that is loading. */
export function applicationConnectionStatusCopy(
  state: ChatConnectionState | undefined,
): string | null {
  if (state !== "offline" && state !== "captive" && state !== "degraded") {
    return null;
  }
  return STATUS_COPY[state];
}

export function chatConnectingCopy(
  state: ChatConnectionState | undefined,
  roomPending = false,
): string | null {
  // A socket routinely crosses the handshake states during a healthy
  // reconnect. Keep that transport detail out of an already-usable room; the
  // local copy is only useful while the room has no timeline to show yet.
  if (!roomPending || !state) return null;
  if (state === "offline" || state === "captive" || state === "degraded") {
    return null;
  }
  return "Connecting…";
}

export function connectionStatusCanRetry(
  state: ChatConnectionState | undefined,
): boolean {
  return state === "offline" || state === "captive" || state === "degraded";
}
