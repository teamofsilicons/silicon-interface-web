import type { HeldSend } from "./types";
import { sendFailureFromHeld } from "./send-failure";

const MAX_HELD_RETRY_MS = 86_400_000;
const MAX_HELD_USER_DELAY_MS = 300_000;
const HELD_SCHEDULE_GRACE_MS = 100;
const HELD_RELEASING_RECOVERY_MS = 5_100;
const HELD_SCHEDULE_FALLBACK_MS = 2_000;

export type HeldSendUiState =
  | "pending"
  | "retrying"
  | "retry_wait"
  | "failed"
  | "challenge"
  | "sent"
  | "cancelled";

export function heldSendUiState(held: HeldSend): HeldSendUiState {
  if (held.state === "sent") return "sent";
  if (held.state === "cancelled") return "cancelled";
  if (held.state === "challenge" || held.phase === "challenge") return "challenge";
  if (
    held.state === "blocked" ||
    held.state === "failed" ||
    held.phase === "blocked"
  ) {
    return "failed";
  }
  if (held.state === "pending" && held.phase === "retry_wait") {
    return heldSendMaySchedule(held) ? "retry_wait" : "failed";
  }
  if (
    held.state === "pending" &&
    (held.failure != null || Boolean(held.failure_code) || Boolean(held.failure_at))
  ) {
    return "failed";
  }
  if (held.state === "releasing" || held.phase === "sending") return "retrying";
  return "pending";
}

/** Only server-active pending/releasing rows may be considered by a client
 * timer. Attention states require an explicit correction and must never enter
 * generic due processing. */
export function heldSendMaySchedule(held: HeldSend): boolean {
  if (held.state === "releasing") return true;
  if (held.state !== "pending") return false;
  const hasFailureMetadata = Boolean(held.failure || held.failure_code || held.failure_at);
  if (held.phase == null || held.phase === "held") return !hasFailureMetadata;
  if (held.phase !== "retry_wait") return false;
  const failure = sendFailureFromHeld(held);
  const failedAt = held.failure_at ? Date.parse(held.failure_at) : Number.NaN;
  const deadline = held.next_attempt_at ? Date.parse(held.next_attempt_at) : Number.NaN;
  return Boolean(
    failure?.retryable &&
      failure.automatic &&
      Number.isFinite(failedAt) &&
      Number.isFinite(deadline) &&
      deadline >= failedAt &&
      deadline - failedAt <= MAX_HELD_RETRY_MS,
  );
}

export function heldSendDeadline(held: HeldSend): string {
  return held.phase === "retry_wait" && held.next_attempt_at
    ? held.next_attempt_at
    : held.release_at;
}

/**
 * A clock-skew-safe local fallback delay. It derives a duration from the two
 * server timestamps instead of comparing the server deadline with the local
 * wall clock. The caller must not restart an unchanged timer on every poll.
 */
export function heldSendScheduleDelayMs(held: HeldSend): number {
  if (held.state === "releasing") return HELD_RELEASING_RECOVERY_MS;
  const serverDuration =
    Date.parse(heldSendDeadline(held)) -
    Date.parse(held.updated_at || held.created_at);
  return Number.isFinite(serverDuration)
    ? Math.min(
        MAX_HELD_USER_DELAY_MS + HELD_SCHEDULE_GRACE_MS,
        Math.max(0, serverDuration + HELD_SCHEDULE_GRACE_MS),
      )
    : HELD_SCHEDULE_FALLBACK_MS;
}

/** A changed version/deadline/state is the only reason to reset a local timer. */
export function heldSendScheduleSignature(held: HeldSend): string {
  return [
    held.state,
    held.phase ?? "",
    String(held.version),
    heldSendDeadline(held),
    held.updated_at || held.created_at,
  ].join(":");
}

export function heldSendBelongsToDevice(held: HeldSend, deviceId: string): boolean {
  return Boolean(deviceId && held.device_id && held.device_id === deviceId);
}

export function heldChallengeUsableOnDevice(held: HeldSend, deviceId: string): boolean {
  return heldSendUiState(held) === "challenge" && heldSendBelongsToDevice(held, deviceId);
}

/** Other installations may reuse a client ID. Their account-visible held row
 * gets a held/device-scoped projection key and can never claim this device's
 * optimistic outbox identity. */
export function heldSendProjectionKey(held: HeldSend, deviceId: string): string {
  return heldSendBelongsToDevice(held, deviceId)
    ? held.client_id
    : `held:${held.device_id || "unknown"}:${held.held_send_id}`;
}
