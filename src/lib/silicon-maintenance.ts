import type { Event, RoomPeer, SiliconMaintenanceProjection } from "./types";

const QUEUED_COPY =
  "Messages sent now are safely stored and delivered automatically. You do not need to resend them.";

const PHASE_LABELS: Record<string, string> = {
  preparing: "preparing the update",
  draining: "finishing current work",
  checkpointing: "checkpointing its state",
  updating: "installing the update",
  validating: "validating the new version",
  resuming: "resuming queued work",
  status_unknown: "reconnecting its update status",
};

export function maintenanceDefersDelivery(
  projection: SiliconMaintenanceProjection | null | undefined,
): boolean {
  return Boolean(projection?.active || projection?.delivery_deferred);
}

export function siliconMaintenancePeers(peers: RoomPeer[]): RoomPeer[] {
  return peers.filter(
    (peer) =>
      peer.kind === "silicon" &&
      maintenanceDefersDelivery(peer.maintenance),
  );
}

function phaseLabel(projection: SiliconMaintenanceProjection): string {
  return PHASE_LABELS[projection.phase] ?? projection.phase.replaceAll("_", " ");
}

/** Carbon-facing copy that names every affected Silicon and its current phase. */
export function siliconMaintenanceRoomMessage(peers: RoomPeer[]): string {
  const affected = siliconMaintenancePeers(peers);
  if (affected.length === 0) return "";
  if (affected.length === 1) {
    const peer = affected[0];
    const projection = peer.maintenance!;
    const name = peer.name || peer.handle || "Silicon";
    const detail = projection.message?.trim();
    return `${name} is ${phaseLabel(projection)}. ${detail || QUEUED_COPY}`;
  }
  const phases = affected.map((peer) => {
    const name = peer.name || peer.handle || "Silicon";
    return `${name}: ${phaseLabel(peer.maintenance!)}`;
  });
  return `${phases.join("; ")}. ${QUEUED_COPY}`;
}

/** Identifies the exact server projection a room-detail poll was based on.
 *
 * If a websocket refresh changes any phase/revision while the poll is in
 * flight, its older response no longer applies and cannot mask the live frame.
 */
export function siliconPeerProjectionSignature(peers: RoomPeer[]): string {
  return JSON.stringify(
    peers
      .filter((peer) => peer.kind === "silicon")
      .map((peer) => [
        peer.id,
        peer.connection_state ?? "",
        peer.maintenance?.update_id ?? "",
        peer.maintenance?.revision ?? -1,
        peer.maintenance?.phase ?? "",
        Boolean(peer.maintenance?.active),
        Boolean(peer.maintenance?.delivery_deferred),
        peer.maintenance?.queued_count ?? -1,
      ])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

export function maintenanceQueueAcknowledgement(events: Event[]): {
  message: string;
  recipientNames: string[];
} | null {
  const queued = events.filter(
    (event) => event.delivery_state === "queued_for_maintenance",
  );
  if (queued.length === 0) return null;
  const recipientNames = Array.from(
    new Set(
      queued.flatMap((event) => {
        const recipients = event.maintenance_recipients?.length
          ? event.maintenance_recipients
          : event.maintenance
            ? [event.maintenance]
            : [];
        return recipients
          .map((recipient) => recipient.name)
          .filter((name): name is string => Boolean(name));
      }),
    ),
  );
  return {
    message:
      queued.find((event) => event.delivery_acknowledgement)
        ?.delivery_acknowledgement ??
      "Your forwarded message is safely stored. You do not need to resend it.",
    recipientNames,
  };
}
