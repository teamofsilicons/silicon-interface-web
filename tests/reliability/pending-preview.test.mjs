import assert from "node:assert/strict";
import test from "node:test";

import { acceptedPendingPreviewCovered } from "../../src/lib/pending-preview.ts";

const accepted = {
  clientId: "client-latest",
  text: "😅",
  status: "accepted",
  acceptedEventId: "event-latest",
  acceptedAt: "2026-07-18T17:45:00.000Z",
};

test("an accepted outgoing preview stays visible over a stale sidebar tail", () => {
  assert.equal(acceptedPendingPreviewCovered(accepted, {
    event_id: "event-previous",
    at: "2026-07-18T17:44:59.000Z",
  }), false);
});

test("an accepted outgoing preview closes at the exact or a newer sidebar tail", () => {
  assert.equal(acceptedPendingPreviewCovered(accepted, {
    event_id: "event-latest",
    at: "2026-07-18T17:44:00.000Z",
  }), true);
  assert.equal(acceptedPendingPreviewCovered(accepted, {
    event_id: "event-after",
    at: "2026-07-18T17:45:01.000Z",
  }), true);
});
