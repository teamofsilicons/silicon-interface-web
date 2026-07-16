import assert from "node:assert/strict";
import test from "node:test";

import { relativeTimeAgo } from "../../src/lib/utils.ts";

test("compact last-seen durations include ago", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-16T03:00:00Z");
  try {
    assert.equal(relativeTimeAgo("2026-07-16T02:00:00Z"), "1h ago");
    assert.equal(relativeTimeAgo("2026-07-16T02:58:00Z"), "2m ago");
    assert.equal(relativeTimeAgo("2026-07-16T02:59:45Z"), "just now");
  } finally {
    Date.now = originalNow;
  }
});
