export type OutboxUiStatus =
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

const AUTHORITATIVE_STATUSES = new Set<OutboxUiStatus>([
  "sent",
  "partially_delivered",
  "delivered",
  "partially_read",
  "read",
]);

/** A late failure belongs to a request attempt, not necessarily to the event.
 * Once an authoritative event ID/status exists, that failure cannot move the
 * rendered message backward. */
export function statusAfterSendFailure(
  current: OutboxUiStatus | undefined,
  proposed: "resolving" | "retry_wait" | "retrying" | "failed" | "challenge",
  eventId: string,
): OutboxUiStatus | undefined {
  if (!eventId.startsWith("temp-") || (current && AUTHORITATIVE_STATUSES.has(current))) {
    return current;
  }
  return proposed;
}

/** Silence at the optimistic deadline is ambiguous. The immutable outbox row
 * still owns automatic recovery, so timeout must not expose a terminal manual
 * retry state. */
export function statusAfterSendTimeout(
  current: OutboxUiStatus | undefined,
): OutboxUiStatus | undefined {
  if (current && AUTHORITATIVE_STATUSES.has(current)) return current;
  return current === "pending" ? "resolving" : current;
}

export function restoredOutboxStatus(
  state:
    | "queued"
    | "resolving"
    | "retry_wait"
    | "blocked"
    | "challenge"
    | undefined,
  attempts: number,
): "pending" | "resolving" | "retry_wait" | "retrying" | "failed" | "challenge" {
  if (state === "challenge") return "challenge";
  if (state === "blocked") return "failed";
  if (state === "resolving") return "resolving";
  if (state === "retry_wait") return "retry_wait";
  return attempts > 0 ? "retrying" : "pending";
}
