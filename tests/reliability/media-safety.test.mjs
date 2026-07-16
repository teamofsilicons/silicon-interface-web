import test from "node:test";
import assert from "node:assert/strict";

import { mediaSafetyError, mediaSafetyState } from "../../src/lib/media-upload.ts";
import { classifySendFailure } from "../../src/lib/send-failure.ts";

test("media safety lifecycle fails closed", () => {
  assert.equal(mediaSafetyState("pending"), "scanning");
  assert.equal(mediaSafetyState("ready"), "ready");
  assert.equal(mediaSafetyState("infected"), "blocked");
  assert.equal(mediaSafetyState("failed"), "blocked");
  assert.equal(mediaSafetyState("future-server-state"), "blocked");
});

test("scan pending retries automatically while a blocked verdict requires replacement", () => {
  const pending = classifySendFailure(mediaSafetyError("scanning"), {
    attempt: 1,
    now: 10_000,
    jitter: 0,
  });
  assert.equal(pending.phase, "retry_wait");
  assert.equal(pending.failure.code, "media_not_ready");
  assert.equal(pending.failure.nextAttemptAt, 11_000);

  const blocked = classifySendFailure(mediaSafetyError("blocked"), {
    attempt: 1,
    now: 10_000,
    jitter: 0,
  });
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.failure.code, "media_missing");
  assert.deepEqual(blocked.failure.correctionActions, [
    "replace_attachment",
    "discard_local",
  ]);
});
