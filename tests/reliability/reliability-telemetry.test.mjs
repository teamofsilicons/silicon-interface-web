import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

test("web durability telemetry counts real commit boundaries without content or identifiers", async () => {
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  const storage = installBrowser(new MemoryStorage(), unavailable);
  storage.setItem(
    "silicon-interface:carbon",
    JSON.stringify({ carbon_id: "private-carbon-id" }),
  );
  const telemetry = await import("../../src/lib/reliability-telemetry.ts");
  const outbox = await import("../../src/lib/outbox.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const before = telemetry.pendingClientCommitTelemetry();

  await outbox.enqueueOutbox("private-owner-id", {
    roomId: "private-room-id",
    clientId: "private-operation-id",
    body: "private message body",
    at: 1,
  });
  assert.equal(await drafts.setDraft("private-draft-room", "private draft body"), true);

  const after = telemetry.pendingClientCommitTelemetry();
  assert.equal(after.send.attempted - before.send.attempted, 1);
  assert.equal(after.send.succeeded - before.send.succeeded, 1);
  assert.equal(after.send.failed - before.send.failed, 0);
  assert.equal(after.draft.attempted - before.draft.attempted, 1);
  assert.equal(after.draft.succeeded - before.draft.succeeded, 1);
  assert.equal(after.draft.failed - before.draft.failed, 0);

  const persisted = storage.getItem("silicon-interface:reliability-telemetry:v1");
  assert.ok(persisted);
  for (const prohibited of [
    "private-carbon-id",
    "private-owner-id",
    "private-room-id",
    "private-operation-id",
    "private message body",
    "private draft body",
  ]) {
    assert.equal(persisted.includes(prohibited), false);
  }
  assert.deepEqual(Object.keys(JSON.parse(persisted)).sort(), ["draft", "send"]);
});

test("a fully failed send commit is counted but telemetry never changes its result", async () => {
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  const storage = new MemoryStorage();
  const normalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (String(key).includes(":outbox:")) throw new Error("quota exceeded");
    normalSet(key, value);
  };
  installBrowser(storage, unavailable);
  const telemetry = await import("../../src/lib/reliability-telemetry.ts");
  const outbox = await import("../../src/lib/outbox.ts");
  const before = telemetry.pendingClientCommitTelemetry();

  await assert.rejects(
    outbox.enqueueOutbox("failure-owner", {
      roomId: "failure-room",
      clientId: "failure-operation",
      body: "still private",
      at: 2,
    }),
    /Unable to persist/,
  );

  const after = telemetry.pendingClientCommitTelemetry();
  assert.equal(after.send.attempted - before.send.attempted, 1);
  assert.equal(after.send.failed - before.send.failed, 1);
  assert.equal(after.send.succeeded - before.send.succeeded, 0);
});
