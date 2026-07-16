import assert from "node:assert/strict";
import test from "node:test";

import { mergeOlderThreadPage, projectLiveThreadEvents, seedLocalThreadPage } from "../../src/lib/thread-state.ts";

function event(event_id, overrides = {}) {
  return {
    event_id,
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "alice",
    type: "m.text",
    content: { body: event_id },
    reply_to_event_id: "",
    thread_root_event_id: "",
    is_final: true,
    created_at: "2026-01-01T00:00:00Z",
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
    ...overrides,
  };
}

function page(events, overrides = {}) {
  return {
    root: event("root", { redacted_at: "2026-01-02T00:00:00Z", content: { redacted: true } }),
    events,
    cursor: "cursor",
    has_more: true,
    through_event_id: "reply-3",
    reply_count: 3,
    unread_count: 2,
    ...overrides,
  };
}

test("thread prepend preserves deleted root, fixed boundary, order, and identity", () => {
  const current = page([event("reply-3", { thread_root_event_id: "root" })]);
  const older = page(
    [
      event("reply-1", { thread_root_event_id: "root" }),
      event("reply-2", { thread_root_event_id: "root" }),
    ],
    { cursor: null, has_more: false },
  );
  const merged = mergeOlderThreadPage(current, older);
  assert.deepEqual(merged.events.map((item) => item.event_id), ["reply-1", "reply-2", "reply-3"]);
  assert.equal(merged.root.redacted_at, "2026-01-02T00:00:00Z");
  assert.equal(merged.has_more, false);
});

test("thread pages fail closed if a cursor response changes root or high-water", () => {
  const current = page([]);
  assert.throws(
    () => mergeOlderThreadPage(current, page([], { through_event_id: "other" })),
    /fixed history boundary/,
  );
  assert.throws(
    () => mergeOlderThreadPage(current, page([], { root: event("other-root") })),
    /fixed history boundary/,
  );
});

test("live projection updates tombstones and adds only canonical thread replies", () => {
  const current = page([event("reply-1", { thread_root_event_id: "root" })]);
  const projected = projectLiveThreadEvents(current, [
    event("root", { redacted_at: "2026-01-04T00:00:00Z", content: { redacted: true } }),
    event("reply-2", { thread_root_event_id: "root" }),
    event("reaction", { type: "m.reaction", thread_root_event_id: "root" }),
    event("other", { thread_root_event_id: "another-root" }),
  ]);
  assert.deepEqual(projected.events.map((item) => item.event_id), ["reply-1", "reply-2"]);
  assert.equal(projected.root.redacted_at, "2026-01-04T00:00:00Z");
});

test("offline seed exposes only locally cached canonical replies", () => {
  const seeded = seedLocalThreadPage([
    event("root"),
    event("reply", { thread_root_event_id: "root" }),
    event("reaction", { type: "m.reaction", thread_root_event_id: "root" }),
    event("other", { thread_root_event_id: "another" }),
  ], "reply");
  assert.equal(seeded?.root.event_id, "root");
  assert.deepEqual(seeded?.events.map((item) => item.event_id), ["reply"]);
  assert.equal(seeded?.has_more, false);
});
