import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorPixelCorrection,
  findVirtualAnchorIndex,
} from "../../src/lib/virtualization-anchor.ts";

test("prepend anchoring follows a stable event when sender groups merge", () => {
  const before = [
    { key: "event-3", eventIds: ["event-3", "event-4"] },
    { key: "event-5", eventIds: ["event-5"] },
  ];
  const after = [
    { key: "event-1", eventIds: ["event-1"] },
    { key: "event-2", eventIds: ["event-2", "event-3", "event-4"] },
    { key: "event-5", eventIds: ["event-5"] },
  ];
  assert.equal(findVirtualAnchorIndex(before, "event-3", (item) => item.eventIds), 0);
  assert.equal(findVirtualAnchorIndex(after, "event-3", (item) => item.eventIds), 1);
});

test("pixel correction preserves an anchor above, within, or below the viewport", () => {
  assert.equal(anchorPixelCorrection(0, 37), -37);
  assert.equal(anchorPixelCorrection(82, 37), 45);
  assert.equal(anchorPixelCorrection(Number.NaN, 37), 0);
});
