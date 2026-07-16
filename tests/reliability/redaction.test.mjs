import assert from "node:assert/strict";
import test from "node:test";

import { projectRedactedEvent, projectRedactedWindow } from "../../src/lib/redaction-state.ts";

function message(overrides = {}) {
  return {
    event_id: "event-1",
    transaction_id: "tx-1",
    stream_position: 9,
    room: 1,
    sender_kind: "carbon",
    sender_id: 7,
    sender_handle: "alice",
    type: "m.album",
    content: {
      caption: "private caption",
      items: [{ media_id: "media-content", filename: "secret.png" }],
    },
    reply_to_event_id: "root-1",
    thread_root_event_id: "root-1",
    is_final: true,
    created_at: "2026-01-01T00:00:00Z",
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
    link_preview: { url: "https://secret.example", host: "secret.example", title: "Secret", description: "body", image: "image" },
    media_meta: { width: 10, height: 20, duration_ms: null, kind: "image", mime: "image/png" },
    media_items: [{ position: 0, media_id: "media-row", filename: "secret.png", kind: "image", mime: "image/png", size: 42, width: 10, height: 20, duration_ms: null }],
    ...overrides,
  };
}

test("redaction preserves timeline identity while purging every body-bearing projection", () => {
  const source = message();
  const result = projectRedactedEvent(source, "2026-01-02T00:00:00Z", "unsend");
  assert.deepEqual(result.mediaIds.sort(), ["media-content", "media-row"]);
  assert.deepEqual(result.event.content, { redacted: true, reason: "unsend" });
  assert.equal(result.event.media_items, null);
  assert.equal(result.event.media_meta, null);
  assert.equal(result.event.link_preview, null);
  assert.equal(result.event.redacted_at, "2026-01-02T00:00:00Z");
  for (const field of ["event_id", "transaction_id", "stream_position", "sender_id", "reply_to_event_id", "thread_root_event_id", "created_at"]) {
    assert.equal(result.event[field], source[field]);
  }
});

test("window projection changes only requested rows and deduplicates media revocation", () => {
  const untouched = message({ event_id: "event-2", content: { body: "keep" }, media_items: null });
  const result = projectRedactedWindow([message(), untouched], ["event-1"], "now");
  assert.equal(result.changed.length, 1);
  assert.equal(result.events[1], untouched);
  assert.deepEqual(result.mediaIds.sort(), ["media-content", "media-row"]);
});

test("redaction refuses an empty marker so optimistic rollback can be ownership-safe", () => {
  assert.throws(() => projectRedactedEvent(message(), ""), /timestamp/);
});
