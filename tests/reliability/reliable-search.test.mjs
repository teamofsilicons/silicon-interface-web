import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeSearchPage,
  recentLocalSearch,
  searchableEventText,
} from "../../src/lib/reliable-search.ts";

function event(id, type, content, extra = {}) {
  return {
    event_id: id,
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "alice",
    type,
    content,
    reply_to_event_id: "",
    is_final: true,
    created_at: `2026-01-01T00:00:0${id}Z`,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
    ...extra,
  };
}

test("local projection matches the Glass content_text rules", () => {
  assert.equal(searchableEventText(event("1", "m.text", { body: "hello" })), "hello");
  assert.equal(
    searchableEventText(event("2", "m.voice", { transcript: "spoken", caption: "fallback" })),
    "spoken",
  );
  assert.equal(searchableEventText(event("3", "m.voice", { caption: "fallback" })), "fallback");
  assert.equal(searchableEventText(event("4", "m.album", { caption: "trip" })), "trip");
  assert.equal(
    searchableEventText(event("5", "m.session_marker", { summary: "session summary" })),
    "session summary",
  );
  assert.equal(searchableEventText(event("6", "m.reaction", { key: "hello" })), "");
});

test("recent local search is normalized, edited-current, and redaction safe", () => {
  const events = [
    event("1", "m.text", { body: "Cafe\u0301 plan" }),
    event("2", "m.text", { body: "new edited wording" }, { edited_at: "2026-01-01T01:00:00Z" }),
    event("3", "m.text", { body: "secret" }, { redacted_at: "2026-01-01T01:00:00Z" }),
    event("4", "m.text", { body: "secret", redacted: true }),
  ];

  assert.deepEqual(recentLocalSearch(events, "CAFÉ").map((row) => row.event_id), ["1"]);
  assert.deepEqual(recentLocalSearch(events, "edited").map((row) => row.event_id), ["2"]);
  assert.deepEqual(recentLocalSearch(events, "secret"), []);
});

test("cursor page merging is retry-safe and prefers authoritative replacements", () => {
  const old = event("1", "m.text", { body: "old" });
  const newer = event("2", "m.text", { body: "newer" });
  const replacement = event("1", "m.text", { body: "edited" }, { edit_version: 1 });

  const merged = mergeSearchPage([newer, old], [replacement]);
  assert.deepEqual(merged.map((row) => row.event_id), ["2", "1"]);
  assert.equal(merged[1].content.body, "edited");
});
