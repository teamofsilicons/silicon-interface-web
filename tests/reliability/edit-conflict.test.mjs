import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/lib/api.ts";
import { authoritativeEditConflict } from "../../src/lib/edit-conflict.ts";

const current = {
  event_id: "event-target",
  edit_version: 3,
  content: { body: "authoritative text" },
};

test("stale edit rebases only to the exact authoritative target", () => {
  const error = new ApiError(409, { code: "state_conflict", current }, "stale");
  assert.equal(authoritativeEditConflict(error, "event-target"), current);
  assert.equal(authoritativeEditConflict(error, "different-event"), null);
});

test("malformed or non-conflict edit responses cannot replace the edit base", () => {
  for (const [status, value] of [
    [409, { ...current, edit_version: 1.5 }],
    [409, { ...current, edit_version: -1 }],
    [409, { ...current, content: null }],
    [409, { edit_version: 2, content: {} }],
    [500, current],
  ]) {
    const error = new ApiError(status, { current: value }, "unsafe");
    assert.equal(authoritativeEditConflict(error, "event-target"), null);
  }
});
