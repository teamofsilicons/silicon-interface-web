import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, deleteDatabase } from "./helpers.mjs";

test("trace roots are strict opaque W3C contexts", async () => {
  const trace = await import("../../src/lib/trace-context.ts");
  const one = trace.newTraceparent();
  const two = trace.newTraceparent();
  assert.match(one, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.notEqual(one, two);
  assert.equal(trace.validTraceparent(one.toUpperCase()), one);
  assert.equal(trace.validTraceparent("00-" + "0".repeat(32) + "-1234567890abcdef-01"), "");
  assert.equal(trace.validTraceparent(one + "-extension"), "");
});

test("an outbox retry after reload retains its original trace root", async () => {
  await deleteDatabase("silicon-interface-outbox");
  installBrowser();
  const outbox = await import("../../src/lib/outbox.ts");
  const first = await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "stable-trace",
    body: "private body must not influence trace identity",
    at: 1,
  });
  assert.match(first.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const replay = await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "stable-trace",
    body: "private body must not influence trace identity",
    at: 1,
  });
  assert.equal(replay.traceparent, first.traceparent);
  assert.equal(await outbox.outboxTraceparent("owner", "stable-trace"), first.traceparent);
});
