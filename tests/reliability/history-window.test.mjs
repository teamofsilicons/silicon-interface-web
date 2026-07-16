import assert from "node:assert/strict";
import test from "node:test";

import {
  countNovelHistoryRows,
  hasNovelHistoryRows,
} from "../../src/lib/history-window.ts";

const visible = (event) => event.type !== "m.reaction" && event.type !== "m.progress";

test("cached overlap does not satisfy an older-history window", () => {
  const cached = new Set(["event-28", "event-29", "event-30"]);
  const overlap = [
    { event_id: "event-28", type: "m.text" },
    { event_id: "event-29", type: "m.text" },
    { event_id: "event-30", type: "m.text" },
  ];

  assert.equal(countNovelHistoryRows(overlap, cached, visible), 0);
  assert.equal(hasNovelHistoryRows(overlap, cached, visible), false);
});

test("only novel renderable rows advance the visible history target", () => {
  const cached = new Set(["event-30"]);
  const page = [
    { event_id: "event-27", type: "m.reaction" },
    { event_id: "event-28", type: "m.progress" },
    { event_id: "event-29", type: "m.text" },
    { event_id: "event-30", type: "m.text" },
  ];

  assert.equal(countNovelHistoryRows(page, cached, visible), 1);
  assert.equal(hasNovelHistoryRows(page, cached, visible), true);
});
