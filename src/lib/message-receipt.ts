export type MessageReceiptStatus =
  | "pending"
  | "resolving"
  | "retry_wait"
  | "retrying"
  | "challenge"
  | "sent"
  | "partially_delivered"
  | "delivered"
  | "partially_read"
  | "read"
  | "failed";

export type MessageReceiptPresentation = {
  visual: "waiting" | "sent" | "delivered" | "read" | "attention";
  label: string;
};

export type ReadReceiptCoverage = {
  event_id: string;
  read_stream_position: number;
  read_stream_vector?: { floor: number; writers: Record<string, number> };
  deliveries?: Record<string, { state?: string }>;
};

export type ReceiptEventProjection = {
  event_id?: string;
  stream_position?: number;
  stream_writer?: string;
};

/** Whether a peer receipt covers the room-list's latest outgoing event. The
 * event-level delivery projection wins; vector/scalar checkpoints cover cases
 * where the receipt's own event is newer than the sidebar event. */
export function readReceiptCoversEvent(
  receipt: ReadReceiptCoverage,
  event: ReceiptEventProjection,
): boolean {
  const eventId = event.event_id;
  if (!eventId) return false;
  if (receipt.deliveries?.[eventId]?.state === "read" || receipt.event_id === eventId) return true;
  const position = event.stream_position;
  if (!Number.isSafeInteger(position)) return false;
  if (receipt.read_stream_vector) {
    const writer = event.stream_writer;
    if (!writer) return false;
    const projected = receipt.read_stream_vector.writers[writer] ?? receipt.read_stream_vector.floor;
    return Number.isSafeInteger(projected) && projected >= Number(position);
  }
  return Number.isSafeInteger(receipt.read_stream_position) &&
    receipt.read_stream_position >= Number(position);
}

/** Never overclaim recipient activity: server acceptance gets one neutral tick,
 * delivery remains distinct, and two ticks mean fully read. */
export function messageReceiptPresentation(
  status: MessageReceiptStatus,
): MessageReceiptPresentation {
  if (status === "failed") return { visual: "attention", label: "failed" };
  if (status === "challenge") {
    return { visual: "attention", label: "waiting for verification" };
  }
  if (status === "read") return { visual: "read", label: "read" };
  if (status === "sent") return { visual: "sent", label: "sent" };
  if (status === "delivered") {
    return { visual: "delivered", label: "delivered" };
  }
  if (status === "partially_read") {
    return { visual: "delivered", label: "delivered · read by some" };
  }
  if (status === "partially_delivered") {
    return { visual: "waiting", label: "waiting · delivered to some" };
  }
  return { visual: "waiting", label: "waiting" };
}
