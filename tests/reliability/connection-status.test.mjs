import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationConnectionStatusCopy,
  chatConnectingCopy,
  connectionStatusCanRetry,
  connectionStatusCopy,
} from "../../src/lib/connection-status.ts";

test("connection copy is short, plain, and free of implementation terminology", () => {
  assert.equal(connectionStatusCopy("offline"), "You’re offline");
  assert.equal(connectionStatusCopy("captive"), "Check your connection");
  assert.equal(connectionStatusCopy("degraded"), "Connection is unstable");
  for (const state of ["connecting", "authenticating", "syncing"]) {
    assert.equal(connectionStatusCopy(state), "Connecting…");
  }
});

test("the global banner is reserved for application-wide connection failures", () => {
  for (const state of ["offline", "captive", "degraded"]) {
    assert.ok(applicationConnectionStatusCopy(state));
    assert.equal(connectionStatusCanRetry(state), true);
  }
  for (const state of ["connecting", "authenticating", "syncing", "online"]) {
    assert.equal(applicationConnectionStatusCopy(state), null);
    assert.equal(connectionStatusCanRetry(state), false);
  }
});

test("Loading is scoped to a chat with no usable timeline yet", () => {
  for (const state of ["connecting", "authenticating", "syncing"]) {
    assert.equal(chatConnectingCopy(state), null);
    assert.equal(chatConnectingCopy(state, true), "Loading…");
  }
  assert.equal(chatConnectingCopy("online", true), "Loading…");
  assert.equal(chatConnectingCopy("offline", true), null);
  assert.equal(chatConnectingCopy("offline"), null);
  assert.equal(chatConnectingCopy("online"), null);
});

test("online and absent states defer to room activity copy", () => {
  assert.equal(connectionStatusCopy("online"), null);
  assert.equal(connectionStatusCopy(undefined), null);
});
