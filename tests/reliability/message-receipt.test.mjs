import assert from "node:assert/strict";
import test from "node:test";

import {
  messageReceiptPresentation,
  readReceiptCoversEvent,
} from "../../src/lib/message-receipt.ts";

test("receipts distinguish local waiting from server acceptance", () => {
  for (const status of ["pending", "resolving", "retry_wait", "retrying"]) {
    assert.deepEqual(messageReceiptPresentation(status), {
      visual: "waiting",
      label: "waiting",
    });
  }
  assert.deepEqual(messageReceiptPresentation("sent"), {
    visual: "sent",
    label: "sent",
  });
  assert.deepEqual(messageReceiptPresentation("delivered"), {
    visual: "delivered",
    label: "delivered",
  });
  assert.deepEqual(messageReceiptPresentation("read"), {
    visual: "read",
    label: "read",
  });
});

test("group receipts never overclaim partial delivery or partial read", () => {
  assert.deepEqual(messageReceiptPresentation("partially_delivered"), {
    visual: "waiting",
    label: "waiting · delivered to some",
  });
  assert.deepEqual(messageReceiptPresentation("partially_read"), {
    visual: "delivered",
    label: "delivered · read by some",
  });
});

test("failures and verification needs stay visibly actionable", () => {
  assert.equal(messageReceiptPresentation("failed").visual, "attention");
  assert.equal(messageReceiptPresentation("challenge").visual, "attention");
});

test("sidebar read ticks accept receipts that cover a newer checkpoint", () => {
  const event = {
    event_id: "01J00000000000000000000001",
    stream_position: 7,
    stream_writer: "writer-a",
  };
  assert.equal(readReceiptCoversEvent({
    event_id: "01J00000000000000000000002",
    read_stream_position: 9,
  }, event), true);
  assert.equal(readReceiptCoversEvent({
    event_id: "other",
    read_stream_position: 12,
    read_stream_vector: { floor: 2, writers: { "writer-a": 7, "writer-b": 12 } },
  }, event), true);
  assert.equal(readReceiptCoversEvent({
    event_id: "other",
    read_stream_position: 12,
    read_stream_vector: { floor: 2, writers: { "writer-a": 6, "writer-b": 12 } },
  }, event), false);
});
