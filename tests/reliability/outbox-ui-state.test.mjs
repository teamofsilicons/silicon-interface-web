import assert from "node:assert/strict";
import test from "node:test";

import {
  restoredOutboxStatus,
  statusAfterSendFailure,
  statusAfterSendTimeout,
} from "../../src/lib/outbox-ui-state.ts";

test("late request failures never downgrade an authoritative sent event", () => {
  assert.equal(statusAfterSendFailure("sent", "failed", "event-1"), "sent");
  assert.equal(statusAfterSendFailure("delivered", "retrying", "event-1"), "delivered");
  assert.equal(statusAfterSendFailure("read", "failed", "event-1"), "read");
  assert.equal(statusAfterSendFailure(undefined, "failed", "event-1"), undefined);
  assert.equal(statusAfterSendFailure("pending", "failed", "temp-client-1"), "failed");
});

test("an optimistic timeout enters non-terminal resolution state", () => {
  assert.equal(statusAfterSendTimeout("pending"), "resolving");
  assert.equal(statusAfterSendTimeout("sent"), "sent");
  assert.equal(statusAfterSendTimeout("delivered"), "delivered");
});

test("restored verification challenges are never presented as automatic retry", () => {
  assert.equal(restoredOutboxStatus("challenge", 1), "challenge");
  assert.equal(restoredOutboxStatus("blocked", 1), "failed");
  assert.equal(restoredOutboxStatus("queued", 1), "retrying");
});
