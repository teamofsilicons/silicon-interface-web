import type { Event } from "./types.ts";

export type DeliverySummary = NonNullable<Event["delivery"]>;

/** Normalize receipt counts at every network/cache boundary. Read implies delivery. */
export function normalizeDeliverySummary(
  recipientCount: number,
  deliveredCount: number,
  readCount: number,
): DeliverySummary {
  const recipients = Math.max(0, Math.trunc(recipientCount));
  const reads = Math.min(recipients, Math.max(0, Math.trunc(readCount)));
  const deliveries = Math.min(
    recipients,
    Math.max(reads, Math.max(0, Math.trunc(deliveredCount))),
  );
  const state =
    recipients > 0 && reads === recipients
      ? "read"
      : reads > 0
        ? "partially_read"
        : recipients > 0 && deliveries === recipients
          ? "delivered"
          : deliveries > 0
            ? "partially_delivered"
            : "sent";
  return {
    state,
    recipient_count: recipients,
    delivered_count: deliveries,
    read_count: reads,
  };
}

export function normalizeDeliveryObject(summary: DeliverySummary): DeliverySummary {
  return normalizeDeliverySummary(
    summary.recipient_count,
    summary.delivered_count,
    summary.read_count,
  );
}

/**
 * Delivery and read receipts are monotonic facts for one immutable event.
 * Network snapshots can arrive out of order, so an older `sent` projection
 * must never overwrite a delivery/read receipt already seen by this client.
 */
export function mergeDeliverySummaries(
  current: DeliverySummary | null | undefined,
  incoming: DeliverySummary | null | undefined,
): DeliverySummary | undefined {
  if (!current && !incoming) return undefined;
  if (!current) return normalizeDeliveryObject(incoming!);
  if (!incoming) return normalizeDeliveryObject(current);
  return normalizeDeliverySummary(
    Math.max(current.recipient_count, incoming.recipient_count),
    Math.max(current.delivered_count, incoming.delivered_count),
    Math.max(current.read_count, incoming.read_count),
  );
}

export function canSendPlaintextToRoom(mode: string): boolean {
  return mode === "server_managed";
}

export function canAddSiliconToRoom(mode: string): boolean {
  return mode === "server_managed";
}
