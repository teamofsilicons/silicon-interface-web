import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedPendingPreviewCovered,
  failedPendingPreviewSuperseded,
  pendingPreviewCandidateWins,
} from "../../src/lib/pending-preview.ts";

const accepted = {
  clientId: "client-latest",
  text: "😅",
  status: "accepted",
  at: Date.parse("2026-07-18T17:45:00.000Z"),
  acceptedEventId: "event-latest",
  acceptedAt: "2026-07-18T17:45:00.000Z",
};

test("an accepted outgoing preview stays visible over a stale sidebar tail", () => {
  assert.equal(acceptedPendingPreviewCovered(accepted, {
    event_id: "event-previous",
    at: "2026-07-18T17:44:59.000Z",
  }), false);
});

test("a failed preview is hidden once a newer committed message exists", () => {
  const failed = {
    clientId: "client-failed",
    text: "old failed message",
    status: "failed",
    at: Date.parse("2026-07-18T17:44:00.000Z"),
  };
  assert.equal(failedPendingPreviewSuperseded(failed, {
    at: "2026-07-18T17:45:00.000Z",
  }), true);
  assert.equal(failedPendingPreviewSuperseded(failed, {
    at: "2026-07-18T17:43:59.000Z",
  }), false);
});

test("a waiting or accepted preview is not hidden by unrelated room activity", () => {
  const lastEvent = { at: "2026-07-18T17:45:00.000Z" };
  assert.equal(failedPendingPreviewSuperseded({
    clientId: "client-waiting",
    text: "new message",
    status: "waiting",
    at: Date.parse("2026-07-18T17:44:00.000Z"),
  }, lastEvent), false);
  assert.equal(failedPendingPreviewSuperseded(accepted, lastEvent), false);
});

test("a late durable restore cannot replace a newer sidebar intent", () => {
  const current = {
    clientId: "client-new",
    text: "new message",
    status: "waiting",
    at: 200,
  };
  assert.equal(pendingPreviewCandidateWins(current, {
    clientId: "client-old",
    text: "old failed message",
    status: "failed",
    at: 100,
  }), false);
  assert.equal(pendingPreviewCandidateWins(current, {
    clientId: "client-newest",
    text: "newest message",
    status: "waiting",
    at: 300,
  }), true);
});

test("an authoritative activity watermark blocks an old failed replay", () => {
  assert.equal(pendingPreviewCandidateWins(null, {
    clientId: "client-old",
    text: "old failed message",
    status: "failed",
    at: 100,
  }, 200), false);
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
