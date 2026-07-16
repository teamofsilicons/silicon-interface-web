import assert from "node:assert/strict";
import test from "node:test";

import { acceptSocketHelloOnce } from "../../src/lib/ws-handshake.ts";

test("a duplicate hello on one WebSocket fails closed as a protocol violation", () => {
  const state = { received: false };
  const actions = [];
  const effects = {
    abortBarrier: () => actions.push("abort"),
    invalidateGeneration: () => actions.push("invalidate"),
    resetBuffer: () => actions.push("reset"),
    close: (code, reason) => actions.push(["close", code, reason]),
  };

  assert.equal(acceptSocketHelloOnce(state, effects), true);
  assert.deepEqual(actions, []);

  assert.equal(acceptSocketHelloOnce(state, effects), false);
  assert.deepEqual(actions, [
    "abort",
    "invalidate",
    "reset",
    ["close", 1008, "duplicate hello"],
  ]);
});
