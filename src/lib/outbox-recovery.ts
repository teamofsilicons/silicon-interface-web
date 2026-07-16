import { ApiError } from "./api";
import {
  challengeFromErrorBody,
  rememberAbuseChallenge,
} from "./abuse-challenge-store";
import {
  blockOutboxForChallenge,
  enqueueOutbox,
  listOutbox,
  type OutboxEntry,
  updateOutbox,
} from "./outbox";
import { decideClientRetry } from "./retry-policy";
import {
  classifySendFailure,
  sendFailureFromHeld,
  sendFailureMessage,
  stateAfterResolution,
  type SendFailureRecord,
} from "./send-failure";
import { isAmbiguousSendFailure } from "./operation-recovery";
import type { HeldSend } from "./types";

export type OutboxWakeSignal =
  | "mount"
  | "online"
  | "foreground"
  | "socket-ready"
  | "https-poll"
  | "deadline"
  | "challenge";

export const OUTBOX_RETRY_SCHEDULED_EVENT = "silicon:outbox-retry-scheduled";

export function wakeOutboxRecovery(ownerId: string, clientId: string): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(
    new CustomEvent(OUTBOX_RETRY_SCHEDULED_EVENT, {
      detail: { ownerId, clientId },
    }),
  );
}

export interface OutboxRuntimeState {
  ownerId: string | null;
  online: boolean;
  visible: boolean;
  socketReady: boolean;
}

/** Network recovery is transport-independent. A successful HTTPS poll is
 * itself proof that HTTP works and may wake the outbox even when WebSocket
 * upgrades never become ready. */
export function shouldFlushOutbox(
  signal: OutboxWakeSignal,
  state: OutboxRuntimeState,
): boolean {
  if (!state.ownerId) return false;
  if (signal === "https-poll") return true;
  if (!state.online) return false;
  if (signal === "foreground") return state.visible;
  if (signal === "socket-ready") return state.socketReady;
  return true;
}

export interface OutboxFailureInput {
  status: number;
  attempts: number;
  now: number;
  retryAfterMs?: number | null;
  message: string;
}

/** Shared first-failure and retry classification. Retry-After is persisted in
 * the same row as the immutable intent; terminal statuses never enter the
 * automatic loop. */
export function classifyOutboxFailure(input: OutboxFailureInput): Pick<
  OutboxEntry,
  "state" | "attempts" | "nextAttemptAt" | "lastError"
> {
  const decision = decideClientRetry(
    input.status,
    input.attempts,
    input.now,
    undefined,
    input.retryAfterMs ?? null,
  );
  return {
    state: decision.state,
    attempts: input.attempts,
    nextAttemptAt: decision.nextAttemptAt,
    lastError: input.message,
  };
}

export function manualOutboxRetryPatch(now: number): Pick<
  OutboxEntry,
  "state" | "nextAttemptAt" | "lastError" | "challenge" | "failure"
> {
  return {
    state: "queued",
    nextAttemptAt: now,
    lastError: undefined,
    challenge: undefined,
    failure: undefined,
  };
}

/** Earliest durable automatic wake. Due rows return `now`; blocked and
 * challenge rows have no automatic deadline. */
export function nextOutboxWakeAt(entries: OutboxEntry[], now: number): number | null {
  let earliest: number | null = null;
  for (const entry of entries) {
    if (entry.state === "blocked" || entry.state === "challenge") continue;
    if (entry.state === "resolving") {
      earliest = earliest == null ? now : Math.min(earliest, now);
      continue;
    }
    const due = entry.nextAttemptAt ?? now;
    earliest = earliest == null ? due : Math.min(earliest, due);
  }
  return earliest;
}

/** Persist the result of every outboxed direct POST, including the very first
 * failure. This is intentionally safe when the failure happened before an
 * outbox row existed: it simply returns false. */
export async function persistOutboxFailure(
  ownerId: string,
  clientId: string,
  error: unknown,
): Promise<boolean> {
  const row = (await listOutbox(ownerId)).find((entry) => entry.clientId === clientId);
  if (!row) return false;
  const attempts = (row.attempts ?? 0) + 1;
  const classified = classifySendFailure(error, {
    attempt: attempts,
    now: Date.now(),
  });
  const challenge = error instanceof ApiError ? challengeFromErrorBody(error.body) : null;
  if (challenge) {
    await blockOutboxForChallenge(ownerId, clientId, challenge, attempts);
    await updateOutbox(ownerId, clientId, {
      failure: classified.failure,
      lastError: sendFailureMessage(classified.failure),
    });
    wakeOutboxRecovery(ownerId, clientId);
    return true;
  }
  const persisted = await updateOutbox(
    ownerId,
    clientId,
    {
      state:
        isAmbiguousSendFailure(classified.failure.httpStatus)
          ? "resolving"
          : classified.phase,
      attempts,
      nextAttemptAt: classified.failure.nextAttemptAt ?? 0,
      lastError: sendFailureMessage(classified.failure),
      failure: classified.failure,
    },
  );
  // Wake even when persistence reported failure. The original due row is
  // still recoverable and the page arms a bounded fallback instead of silently
  // depending on a WebSocket flap or periodic polling.
  wakeOutboxRecovery(ownerId, clientId);
  return persisted;
}

/** Finish an ambiguous operation lookup without losing the original structured
 * failure. Both conclusive absence and an inconclusive lookup move to the same
 * persisted retry/action state; neither blindly POSTs in the lookup turn. */
export async function settleResolvingOutboxFailure(
  ownerId: string,
  clientId: string,
): Promise<boolean> {
  const row = (await listOutbox(ownerId)).find((entry) => entry.clientId === clientId);
  if (!row || row.state !== "resolving" || !row.failure) return false;
  const failure = row.failure as SendFailureRecord;
  const nextState = stateAfterResolution(failure);
  const updated = await updateOutbox(ownerId, clientId, {
    state: nextState,
    nextAttemptAt: failure.nextAttemptAt ?? 0,
    failure,
    lastError: sendFailureMessage(failure),
  });
  wakeOutboxRecovery(ownerId, clientId);
  return updated;
}

/** Mirror a server-owned held attention state into a still-present local
 * outbox without acknowledging or making it generically due. */
export async function persistHeldOutboxState(
  ownerId: string,
  clientId: string,
  held: HeldSend,
): Promise<boolean> {
  const row = (await listOutbox(ownerId)).find((entry) => entry.clientId === clientId);
  if (!row || held.client_id !== clientId || held.room_id !== row.roomId) return false;
  const failure = sendFailureFromHeld(held);
  if (!failure) return false;
  const challenge = held.state === "challenge"
    ? challengeFromErrorBody({
        code: "challenge_required",
        challenge: held.challenge,
      })
    : null;
  const state = held.state === "challenge"
    ? "challenge"
    : held.state === "blocked" || held.state === "failed"
      ? "blocked"
      : held.phase === "retry_wait"
        ? "retry_wait"
        : "queued";
  const updated = await updateOutbox(ownerId, clientId, {
    state,
    attempts: Math.max(row.attempts ?? 0, held.release_attempts ?? 0),
    nextAttemptAt: failure.nextAttemptAt ?? 0,
    lastError: sendFailureMessage(failure),
    failure,
    challenge: challenge ?? undefined,
  });
  if (updated && challenge) await rememberAbuseChallenge(ownerId, challenge);
  wakeOutboxRecovery(ownerId, clientId);
  return updated;
}

/** A manual retry may POST only after its blocked row has been durably
 * released. If an old UI row outlived local queue state, rebuild the exact
 * immutable intent first. */
export async function prepareManualOutboxRetry(
  ownerId: string,
  fallback: OutboxEntry,
  now = Date.now(),
): Promise<OutboxEntry> {
  const existing = (await listOutbox(ownerId)).find(
    (entry) => entry.clientId === fallback.clientId,
  );
  if (existing) {
    if (existing.state === "resolving") {
      throw new Error("Glass is still checking whether this message was accepted");
    }
    if (existing.state === "challenge") {
      throw new Error("Complete verification before retrying this message");
    }
    if (
      existing.failure?.automatic &&
      (existing.nextAttemptAt ?? existing.failure.nextAttemptAt ?? 0) > now
    ) {
      throw new Error("This message is not eligible for retry yet");
    }
    const updated = await updateOutbox(
      ownerId,
      fallback.clientId,
      manualOutboxRetryPatch(now),
    );
    if (!updated) {
      // An acknowledgement racing the tap is already a durable terminal
      // result. Re-POSTing the same client ID remains idempotent.
      const stillPending = (await listOutbox(ownerId)).some(
        (entry) => entry.clientId === fallback.clientId,
      );
      if (stillPending) throw new Error("Unable to release the saved message for retry");
    }
    const released = { ...existing, ...manualOutboxRetryPatch(now) };
    // Held operations must be recovered by the central flusher, which knows to
    // call createHeldSend/sendHeldNow. A bubble retry must never reinterpret an
    // ambiguous held intent as an immediate event send.
    if (released.operation === "held" || released.operation === "media") {
      wakeOutboxRecovery(ownerId, fallback.clientId);
    }
    return released;
  }
  const rebuilt = {
    ...fallback,
    ...manualOutboxRetryPatch(now),
    at: fallback.at || now,
  };
  await enqueueOutbox(ownerId, rebuilt);
  if (rebuilt.operation === "held" || rebuilt.operation === "media") {
    wakeOutboxRecovery(ownerId, fallback.clientId);
  }
  return rebuilt;
}
