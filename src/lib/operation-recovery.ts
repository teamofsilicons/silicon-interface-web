import type { ClientOperationStatus, Event, HeldSend } from "./types";

export function isAmbiguousSendFailure(httpStatus: number): boolean {
  return (
    httpStatus === 0 ||
    httpStatus === 408 ||
    httpStatus === 425 ||
    httpStatus === 429 ||
    httpStatus >= 500
  );
}

/** Only a fully bound authoritative response may delete an event outbox row. */
export function acceptedEvent(
  status: ClientOperationStatus,
  expectedRoomId: string,
  expectedClientId: string,
  expectedDeviceId?: string | null,
): Event | null {
  if (
    status.kind !== "event_send" ||
    status.state !== "succeeded" ||
    status.room_id !== expectedRoomId ||
    status.client_id !== expectedClientId ||
    (expectedDeviceId !== undefined &&
      (!expectedDeviceId || status.device_id !== expectedDeviceId)) ||
    status.result?.kind !== "event"
  ) {
    return null;
  }
  const event = status.result.event;
  return status.resource_id === event.event_id &&
    status.result_event_id === event.event_id &&
    event.content?.client_id === expectedClientId
    ? event
    : null;
}

/** Active/successful held operations may transfer recovery ownership to Glass
 * once fully bound. Blocked/challenge/failed rows remain explicit attention
 * states and are never returned as accepted. */
export function acceptedHeldSend(
  status: ClientOperationStatus,
  expectedRoomId: string,
  expectedClientId: string,
  expectedDeviceId?: string | null,
): HeldSend | null {
  if (
    status.kind !== "held_send" ||
    status.room_id !== expectedRoomId ||
    status.client_id !== expectedClientId ||
    (expectedDeviceId !== undefined &&
      (!expectedDeviceId || status.device_id !== expectedDeviceId)) ||
    status.result?.kind !== "held_send"
  ) {
    return null;
  }
  const held = status.result.held_send;
  if (!held.device_id || held.device_id !== status.device_id) return null;
  if (
    held.state === "blocked" ||
    held.state === "challenge" ||
    held.state === "failed"
  ) {
    return null;
  }
  const expectedState =
    held.state === "sent"
      ? "succeeded"
      : held.state === "cancelled"
        ? "cancelled"
        : "pending";
  return status.resource_id === held.held_send_id &&
    held.room_id === expectedRoomId &&
    held.client_id === expectedClientId &&
    status.state === expectedState &&
    status.result_event_id === held.sent_event_id
    ? held
    : null;
}

export function heldSendRequiringAttention(
  status: ClientOperationStatus,
  expectedRoomId: string,
  expectedClientId: string,
  expectedDeviceId?: string | null,
): HeldSend | null {
  if (
    status.kind !== "held_send" ||
    status.room_id !== expectedRoomId ||
    status.client_id !== expectedClientId ||
    (expectedDeviceId !== undefined &&
      (!expectedDeviceId || status.device_id !== expectedDeviceId)) ||
    status.result?.kind !== "held_send"
  ) {
    return null;
  }
  const held = status.result.held_send;
  if (!held.device_id || held.device_id !== status.device_id) return null;
  const attention =
    held.state === "blocked" || held.state === "challenge" || held.state === "failed";
  const expectedOperationState = held.state === "failed" ? "failed" : "pending";
  return attention &&
    held.room_id === expectedRoomId &&
    held.client_id === expectedClientId &&
    status.resource_id === held.held_send_id &&
    status.state === expectedOperationState &&
    status.result_event_id === held.sent_event_id
    ? held
    : null;
}

/** A held-send result and an immediate event-send use different idempotency
 * namespaces. Recovery may project only the exact Event Glass attached to the
 * held row; content.client_id is device-scoped and cannot identify it. */
export function eventForSentHeld(held: HeldSend, events: Event[]): Event | null {
  if (held.state !== "sent" || !held.sent_event_id) return null;
  return events.find((event) => event.event_id === held.sent_event_id) ?? null;
}
