import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

test("mirror-only tombstone rejects cross-scope and changed-payload reuse", async () => {
  const storage = new MemoryStorage();
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  installBrowser(storage, unavailable);
  const outbox = await import("../../src/lib/outbox.ts");
  const owner = "mirror-scope-owner";
  const original = {
    roomId: "room-a",
    clientId: "mirror-client",
    body: "immutable body",
    content: { body: "immutable body", mention_ids: ["a", "b"] },
    at: 1,
  };
  await outbox.enqueueOutbox(owner, original);
  assert.equal(await outbox.ackOutbox(owner, original.clientId), true);
  assert.deepEqual(await outbox.listOutbox(owner), []);

  await assert.rejects(
    outbox.enqueueOutbox(owner, { ...original, roomId: "room-b", at: 2 }),
    /different room or operation namespace/,
  );
  await assert.rejects(
    outbox.enqueueOutbox(owner, { ...original, operation: "held", at: 3 }),
    /different room or operation namespace/,
  );
  await assert.rejects(
    outbox.enqueueOutbox(owner, {
      ...original,
      body: "mutated body",
      content: { body: "mutated body", mention_ids: ["a", "b"] },
      at: 4,
    }),
    /different payload/,
  );

  // An exact same-scope replay is the only acknowledged reuse that is safe.
  await outbox.enqueueOutbox(owner, { ...original, at: 5 });
  assert.deepEqual(await outbox.listOutbox(owner), []);
});

test("scope-less legacy acknowledgement fails closed", async () => {
  const storage = new MemoryStorage();
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  installBrowser(storage, unavailable);
  const outbox = await import("../../src/lib/outbox.ts");
  const owner = "legacy-ack-scope-owner";
  const clientId = "legacy-ack-client";
  storage.setItem(
    `silicon-interface:outbox:v2:ack:${encodeURIComponent(owner)}:${encodeURIComponent(clientId)}`,
    String(Date.now()),
  );
  await assert.rejects(
    outbox.enqueueOutbox(owner, {
      roomId: "unknown-room",
      clientId,
      body: "must not post",
      at: 1,
    }),
    /ambiguous client scope or payload/,
  );
});
