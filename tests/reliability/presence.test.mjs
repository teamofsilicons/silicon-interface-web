import assert from "node:assert/strict";
import test from "node:test";

import { mergePresence, presenceIsOnline } from "../../src/lib/presence-state.ts";

test("online presence is bounded by the server lease", () => {
  const presence = {
    state: "online",
    expires_at: "2026-07-13T12:00:10.000Z",
    last_seen_at: "2026-07-13T12:00:00.000Z",
    revision: 10,
  };
  assert.equal(presenceIsOnline(presence, Date.parse("2026-07-13T12:00:09.999Z")), true);
  assert.equal(presenceIsOnline(presence, Date.parse("2026-07-13T12:00:10.000Z")), false);
});

test("stale presence frames cannot overwrite a newer projection", () => {
  const current = {
    state: "offline",
    expires_at: "",
    last_seen_at: "2026-07-13T12:00:00.000Z",
    revision: 20,
  };
  const stale = {
    state: "online",
    expires_at: "2026-07-13T12:01:00.000Z",
    last_seen_at: "",
    revision: 19,
  };
  assert.equal(mergePresence(current, stale), current);
});

test("equal-revision contradictions fail closed to hidden then offline", () => {
  const online = {
    state: "online",
    expires_at: "2026-07-13T12:01:00.000Z",
    last_seen_at: "",
    revision: 30,
  };
  const hidden = { state: "hidden", expires_at: "", last_seen_at: "", revision: 30 };
  assert.equal(mergePresence(online, hidden).state, "hidden");
  const offline = {
    state: "offline",
    expires_at: "",
    last_seen_at: "2026-07-13T12:00:00.000Z",
    revision: 31,
  };
  assert.equal(mergePresence(online, offline).state, "offline");
});
