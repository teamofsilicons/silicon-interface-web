import assert from "node:assert/strict";
import test from "node:test";

import { preserveCanonicalTimelineOrder } from "../../src/lib/run-anchored-timeline.ts";

function event(event_id, sender_kind, run_anchor_event_id = undefined) {
  return { event_id, sender_kind, run_anchor_event_id };
}

test("server run anchors never move a Silicon reply ahead of a newer Carbon message", () => {
  const first = event("carbon-first", "carbon");
  const newer = event("carbon-newer", "carbon");
  const reply = event("silicon-reply", "silicon", first.event_id);

  assert.deepEqual(
    preserveCanonicalTimelineOrder([first, newer, reply]).map((item) => item.event_id),
    ["carbon-first", "carbon-newer", "silicon-reply"],
  );
});

test("all replies for one run keep their canonical stream positions", () => {
  const first = event("carbon-first", "carbon");
  const newer = event("carbon-newer", "carbon");
  const update = event("silicon-update", "silicon", first.event_id);
  const final = event("silicon-final", "silicon", first.event_id);

  assert.deepEqual(
    preserveCanonicalTimelineOrder([first, newer, update, final]).map(
      (item) => item.event_id,
    ),
    ["carbon-first", "carbon-newer", "silicon-update", "silicon-final"],
  );
});

test("missing, invalid, and forward anchors also preserve canonical stream order", () => {
  const silicon = event("silicon-first", "silicon");
  const missing = event("missing-anchor", "silicon", "not-loaded");
  const forward = event("forward-anchor", "silicon", "carbon-later");
  const wrongParty = event("wrong-party", "silicon", silicon.event_id);
  const later = event("carbon-later", "carbon");
  const canonical = [silicon, missing, forward, wrongParty, later];

  assert.deepEqual(preserveCanonicalTimelineOrder(canonical), canonical);
});
