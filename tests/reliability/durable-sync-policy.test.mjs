import assert from "node:assert/strict";
import test from "node:test";

import { shouldRunDurableSync } from "../../src/lib/durable-sync-policy.ts";

const base = {
  ownerId: "carbon-owner",
  networkAvailable: true,
};

test("durable catch-up remains active behind a healthy realtime socket", () => {
  assert.equal(shouldRunDurableSync({
    ...base,
    socketState: "online",
    socketReady: true,
  }), true);
});

test("socket barrier owns cursors while connecting and syncing", () => {
  for (const socketState of ["connecting", "authenticating", "syncing"]) {
    assert.equal(shouldRunDurableSync({
      ...base,
      socketState,
      socketReady: false,
    }), false);
  }
});

test("HTTPS catch-up covers degraded sockets but never fabricates connectivity", () => {
  for (const socketState of ["offline", "degraded"]) {
    assert.equal(shouldRunDurableSync({
      ...base,
      socketState,
      socketReady: false,
    }), true);
  }
  assert.equal(shouldRunDurableSync({
    ...base,
    socketState: "degraded",
    socketReady: false,
    networkAvailable: false,
  }), false);
});
