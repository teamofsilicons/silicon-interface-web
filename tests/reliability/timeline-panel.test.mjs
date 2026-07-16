import assert from "node:assert/strict";
import test from "node:test";

import {
  belongsToSameTimelinePanel,
  timelineSenderKey,
} from "../../src/lib/timeline-panel.ts";

const localIso = (day, hour, minute = 0) =>
  new Date(2026, 6, day, hour, minute, 0, 0).toISOString();

const row = (overrides = {}) => ({
  sender_kind: "carbon",
  sender_id: 1,
  sender_handle: "alice",
  sender_public_id: "carbon-alice",
  created_at: localIso(13, 10),
  ...overrides,
});

test("different Carbons never collapse into one virtual panel", () => {
  assert.equal(
    belongsToSameTimelinePanel(row(), row({
      sender_id: 2,
      sender_handle: "bob",
      sender_public_id: "carbon-bob",
    })),
    false,
  );
});

test("one sender stays grouped within a day but not across the local date boundary", () => {
  assert.equal(
    belongsToSameTimelinePanel(row(), row({ created_at: localIso(13, 23, 59) })),
    true,
  );
  assert.equal(
    belongsToSameTimelinePanel(row(), row({ created_at: localIso(14, 0, 1) })),
    false,
  );
});

test("sender identity has stable fallbacks for legacy events", () => {
  assert.equal(timelineSenderKey(row({ sender_public_id: null })), "carbon:alice");
  assert.equal(
    timelineSenderKey(row({ sender_public_id: null, sender_handle: null, sender_id: 7 })),
    "carbon:7",
  );
});
