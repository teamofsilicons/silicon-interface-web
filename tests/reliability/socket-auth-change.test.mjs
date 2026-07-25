import assert from "node:assert/strict";
import test from "node:test";

import { socketActionForAuthChange } from "../../src/lib/socket-auth-change.ts";

test("routine HTTP auth and profile updates do not restart a healthy socket", () => {
  for (const change of ["tokens", "profile", "access-expired"]) {
    assert.equal(
      socketActionForAuthChange({ change, socketPresent: true, hasAuthority: true }),
      "ignore",
    );
  }
});

test("a newly restored token connects only when no socket exists", () => {
  assert.equal(
    socketActionForAuthChange({
      change: "tokens",
      socketPresent: false,
      hasAuthority: true,
    }),
    "connect",
  );
});

test("principal replacement restarts and logout closes", () => {
  assert.equal(
    socketActionForAuthChange({
      change: "silicon-key",
      socketPresent: true,
      hasAuthority: true,
    }),
    "restart",
  );
  assert.equal(
    socketActionForAuthChange({
      change: "cleared",
      socketPresent: true,
      hasAuthority: false,
    }),
    "close",
  );
});
