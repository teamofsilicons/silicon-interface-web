import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/lib/api.ts";
import {
  verificationDeliveryFailure,
  verificationDeliveryMessage,
} from "../../src/lib/verification-delivery.ts";

function providerError(overrides = {}, retryAfterMs = null) {
  return new ApiError(
    503,
    {
      code: "verification_delivery_failed",
      intent_id: "challenge-1",
      channel: "email",
      failure: {
        domain: "auth.verification_delivery",
        code: "provider_unavailable",
        retryable: true,
        automatic: false,
        retry_after_seconds: 5,
        ...overrides,
      },
    },
    "display-only detail",
    retryAfterMs,
  );
}

test("verification delivery parser retains only the finite recovery contract", () => {
  assert.deepEqual(verificationDeliveryFailure(providerError()), {
    intentId: "challenge-1",
    channel: "email",
    reason: "provider_unavailable",
    retryable: true,
    retryAfterMs: 5_000,
  });
});

test("nested server deadline wins and is capped", () => {
  assert.equal(
    verificationDeliveryFailure(
      providerError({ retry_after_seconds: 999_999 }, 1),
    ).retryAfterMs,
    86_400_000,
  );
});

test("malformed, unknown, and stringly typed contracts fail closed", () => {
  assert.equal(
    verificationDeliveryFailure(providerError({ retryable: "true" })),
    null,
  );
  assert.equal(
    verificationDeliveryFailure(providerError({ code: "provider_secret_error" })),
    null,
  );
  assert.equal(
    verificationDeliveryFailure(providerError({ automatic: true })),
    null,
  );
  assert.equal(verificationDeliveryFailure(new Error("offline")), null);
});

test("copy distinguishes ambiguous delivery from terminal rejection", () => {
  assert.match(
    verificationDeliveryMessage(verificationDeliveryFailure(providerError())),
    /if a code arrived/,
  );
  const terminal = verificationDeliveryFailure(
    providerError({ code: "provider_rejected", retryable: false }),
  );
  assert.match(verificationDeliveryMessage(terminal), /progress is safe/);
});
