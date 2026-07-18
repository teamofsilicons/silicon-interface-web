import assert from "node:assert/strict";
import test from "node:test";

import {
  belongsToSameTimelinePanel,
  timelineSenderKey,
} from "../../src/lib/timeline-panel.ts";

const localIso = (day, hour, minute = 0, second = 0) =>
  new Date(2026, 6, day, hour, minute, second, 0).toISOString();

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

test("one sender groups only while adjacent messages stay within one minute", () => {
  assert.equal(
    belongsToSameTimelinePanel(
      row({ created_at: localIso(13, 10, 0) }),
      row({ created_at: localIso(13, 10, 1) }),
    ),
    true,
  );
  assert.equal(
    belongsToSameTimelinePanel(
      row({ created_at: localIso(13, 10, 0, 0) }),
      row({ created_at: localIso(13, 10, 1, 1) }),
    ),
    false,
  );
});

test("a continuous one-minute chain gets a fixed break at ten minutes", () => {
  const start = row({ created_at: localIso(13, 10, 0) });
  assert.equal(
    belongsToSameTimelinePanel(
      row({ created_at: localIso(13, 10, 9) }),
      row({ created_at: localIso(13, 10, 9) }),
      start,
    ),
    true,
  );
  assert.equal(
    belongsToSameTimelinePanel(
      row({ created_at: localIso(13, 10, 9) }),
      row({ created_at: localIso(13, 10, 10) }),
      start,
    ),
    false,
  );
});

test("same-sender grouping never crosses the local date boundary", () => {
  assert.equal(
    belongsToSameTimelinePanel(
      row({ created_at: localIso(13, 23, 59) }),
      row({ created_at: localIso(14, 0, 0) }),
    ),
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
