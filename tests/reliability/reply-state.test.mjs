import assert from "node:assert/strict";
import test from "node:test";

import { reconcileReplyTarget } from "../../src/lib/reply-state.ts";

test("an active reply follows authoritative edit and redaction state", () => {
  const active = { event_id: "target", redacted_at: null, content: { body: "old" } };
  const redacted = { event_id: "target", redacted_at: "2026-07-13T00:00:00Z", content: {} };
  assert.equal(reconcileReplyTarget(active, redacted), redacted);
});

test("a different event can never replace the active reply target", () => {
  const active = { event_id: "target" };
  assert.equal(reconcileReplyTarget(active, { event_id: "other" }), active);
  assert.equal(reconcileReplyTarget(active, undefined), active);
});
