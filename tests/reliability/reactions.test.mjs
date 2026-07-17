import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateReactions,
  applyOwnReactionOverride,
  nextOwnReactionIntent,
  ownReactionIsActive,
  reactionIntentKey,
  reconcileReactionResult,
  retryReactionMutation,
} from "../../src/lib/reaction-state.ts";

function reaction(overrides = {}) {
  return {
    event_id: "reaction-1",
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "alice",
    type: "m.reaction",
    content: { emoji: "é" },
    reply_to_event_id: "message-1",
    is_final: true,
    created_at: "2026-01-01T00:00:00Z",
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
    ...overrides,
  };
}

test("reaction identity normalizes canonically equivalent emoji strings", () => {
  assert.equal(reactionIntentKey("message-1", "e\u0301"), reactionIntentKey("message-1", "é"));
  assert.equal(ownReactionIsActive([reaction()], "message-1", "e\u0301", "alice"), true);
});

test("aggregation bundles reactions across pages, canonicalizes emoji, and deduplicates sender echoes", () => {
  const acrossOlderPage = reaction({ event_id: "older-page", content: { emoji: "e\u0301" } });
  const duplicateEcho = reaction({ event_id: "newer-page", content: { emoji: "é" } });
  const bob = reaction({ event_id: "bob-page", sender_handle: "bob", content: { emoji: "é" } });
  const projected = aggregateReactions([acrossOlderPage, duplicateEcho, bob]);
  assert.deepEqual(projected.get("message-1"), { "é": ["alice", "bob"] });
});

test("optimistic desired state overrides stale websocket projections", () => {
  const events = [reaction()];
  assert.equal(ownReactionIsActive(events, "message-1", "é", "alice", false), false);
  assert.deepEqual(applyOwnReactionOverride(["alice", "bob"], "alice", false), ["bob"]);
  assert.deepEqual(applyOwnReactionOverride(["bob"], "alice", true), ["bob", "alice"]);
});

test("rapid clicks alternate from synchronous intent before React rerenders", () => {
  const first = nextOwnReactionIntent([], "message-1", "é", "alice");
  const second = nextOwnReactionIntent([], "message-1", "é", "alice", first);
  const third = nextOwnReactionIntent([], "message-1", "é", "alice", second);
  assert.deepEqual([first, second, third], [true, false, true]);
});

test("authoritative desired-state results replace duplicates and preserve tombstones", () => {
  const duplicate = reaction({ event_id: "reaction-stale" });
  const authoritative = reaction({ event_id: "reaction-authoritative" });
  const active = reconcileReactionResult(
    [duplicate],
    "message-1",
    "é",
    "alice",
    true,
    { active: true, event: authoritative },
    "2026-01-02T00:00:00Z",
  );
  assert.equal(active.length, 2);
  assert.equal(active.find((event) => event.event_id === "reaction-stale").redaction_reason, "duplicate_reaction");
  assert.equal(active.find((event) => event.event_id === "reaction-authoritative").redacted_at, null);

  const removed = reconcileReactionResult(
    active,
    "message-1",
    "é",
    "alice",
    false,
    { active: false, event: null },
    "2026-01-03T00:00:00Z",
  );
  assert.equal(removed.filter((event) => !event.redacted_at).length, 0);
});

test("malformed desired-state responses fail closed", () => {
  assert.throws(
    () => reconcileReactionResult(
      [], "message-1", "é", "alice", true,
      { active: false, event: null },
    ),
    /did not match desired state/,
  );
  assert.throws(
    () => reconcileReactionResult(
      [], "message-1", "é", "alice", true,
      { active: true, event: null },
    ),
    /invalid authoritative reaction response/,
  );
  assert.throws(
    () => reconcileReactionResult(
      [], "message-1", "é", "alice", false,
      { active: false, event: reaction() },
    ),
    /inactive reaction response included an event/,
  );
});

test("desired-state mutations retry safely without changing the captured intent", async () => {
  let calls = 0;
  const result = await retryReactionMutation(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary");
      return { active: true };
    },
    { wait: async () => undefined },
  );
  assert.deepEqual(result, { active: true });
  assert.equal(calls, 3);
});
