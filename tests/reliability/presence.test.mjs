import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePresence,
  observePresenceActivity,
  presenceIsOnline,
} from "../../src/lib/presence-state.ts";

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

test("accepted peer activity prevents an impossible stale last-seen label", () => {
  const stale = {
    state: "offline",
    expires_at: "",
    last_seen_at: "2026-07-16T22:45:00.000Z",
    revision: 40,
  };
  const observed = observePresenceActivity(stale, "2026-07-16T23:29:00.000Z");
  assert.equal(observed.last_seen_at, "2026-07-16T23:29:00.000Z");

  const heartbeat = mergePresence(observed, {
    state: "offline",
    expires_at: "",
    last_seen_at: "2026-07-16T22:46:00.000Z",
    revision: 41,
  });
  assert.equal(heartbeat.last_seen_at, "2026-07-16T23:29:00.000Z");
});

test("observed activity never bypasses hidden presence privacy", () => {
  const hidden = { state: "hidden", expires_at: "", last_seen_at: "", revision: 50 };
  assert.equal(
    observePresenceActivity(hidden, "2026-07-16T23:29:00.000Z"),
    hidden,
  );
});
