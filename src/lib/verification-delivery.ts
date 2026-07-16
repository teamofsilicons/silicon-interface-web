import { ApiError } from "./api";

export type VerificationDeliveryReason =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_rejected"
  | "provider_configuration";

export interface VerificationDeliveryFailure {
  intentId: string;
  channel: "email" | "sms";
  reason: VerificationDeliveryReason;
  retryable: boolean;
  retryAfterMs: number | null;
}

const reasons = new Set<VerificationDeliveryReason>([
  "provider_unavailable",
  "provider_rate_limited",
  "provider_rejected",
  "provider_configuration",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedRetryMs(value: unknown): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, 86_400_000);
}

/** Strictly parse only Glass's finite, body-free verification failure contract. */
export function verificationDeliveryFailure(
  error: unknown,
): VerificationDeliveryFailure | null {
  if (!(error instanceof ApiError)) return null;
  const body = record(error.body);
  const failure = record(body?.failure);
  if (
    body?.code !== "verification_delivery_failed" ||
    failure?.domain !== "auth.verification_delivery" ||
    typeof failure.code !== "string" ||
    !reasons.has(failure.code as VerificationDeliveryReason) ||
    typeof failure.retryable !== "boolean" ||
    failure.automatic !== false ||
    typeof body.intent_id !== "string" ||
    body.intent_id.length === 0 ||
    (body.channel !== "email" && body.channel !== "sms")
  ) {
    return null;
  }
  const nestedRetry = boundedRetryMs(failure.retry_after_seconds);
  const retryAfter = nestedRetry ?? error.retryAfterMs;
  return {
    intentId: body.intent_id,
    channel: body.channel,
    reason: failure.code as VerificationDeliveryReason,
    retryable: failure.retryable,
    retryAfterMs:
      retryAfter == null ? null : Math.max(0, Math.min(retryAfter, 86_400_000)),
  };
}

export function verificationDeliveryMessage(
  failure: VerificationDeliveryFailure,
): string {
  if (failure.reason === "provider_rate_limited") {
    return "code delivery is temporarily limited. your verification is safe.";
  }
  if (failure.retryable) {
    return "delivery confirmation was interrupted. if a code arrived, you can still use it.";
  }
  return "the verification service could not send this code. your progress is safe; try another method or try again later.";
}
