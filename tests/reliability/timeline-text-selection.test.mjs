import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldLoadOlderDuringRangeChange,
  timelineViewportPadding,
} from "../../src/lib/timeline-text-selection.ts";

test("native text selection retains the complete loaded virtual window", () => {
  assert.deepEqual(timelineViewportPadding(false), { top: 900, bottom: 700 });
  assert.deepEqual(timelineViewportPadding(true), { top: 1_000_000, bottom: 1_000_000 });
});

test("selection never triggers a history prepend that can detach its live Range", () => {
  assert.equal(shouldLoadOlderDuringRangeChange({
    selectionActive: true,
    startIndex: 0,
    hasMore: true,
    loadingOlder: false,
  }), false);
  assert.equal(shouldLoadOlderDuringRangeChange({
    selectionActive: false,
    startIndex: 0,
    hasMore: true,
    loadingOlder: false,
  }), true);
  assert.equal(shouldLoadOlderDuringRangeChange({
    selectionActive: false,
    startIndex: 5,
    hasMore: true,
    loadingOlder: false,
  }), false);
});
