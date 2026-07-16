import assert from "node:assert/strict";
import test from "node:test";

import { deleteDatabase, installBrowser } from "./helpers.mjs";

test("outbox is ordered, idempotently replayed, and removed only by ack", async () => {
  await deleteDatabase("silicon-interface-outbox");
  const storage = installBrowser();
  const outbox = await import("../../src/lib/outbox.ts");

  await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "later",
    operation: "held",
    body: "replacement",
    releaseAt: "2026-01-01T00:00:10.000Z",
    at: 20,
  });
  // An exact replay is idempotent. Reusing the client ID with a changed
  // room/operation/payload now fails closed instead of overwriting intent.
  await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "first",
    body: "first",
    at: 10,
  });
  await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "later",
    operation: "held",
    body: "replacement",
    releaseAt: "2026-01-01T00:00:10.000Z",
    at: 20,
  });

  const pending = await outbox.listOutbox("owner");
  assert.deepEqual(
    pending.map(({ clientId, body }) => ({ clientId, body })),
    [
      { clientId: "first", body: "first" },
      { clientId: "later", body: "replacement" },
    ],
  );

  await outbox.ackOutbox("owner", "first");
  const mirrorKey = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .find((candidate) => candidate?.includes(":v2:intent:") && candidate.endsWith(encodeURIComponent("later")));
  assert.ok(mirrorKey);
  const staleMirror = storage.getItem(mirrorKey);
  assert.equal(
    await outbox.updateOutbox("owner", "later", {
      state: "blocked",
      attempts: 1,
      lastError: "permission denied",
    }),
    true,
  );
  // Simulate a partial quota/downgrade failure leaving the older recovery
  // mirror behind. Listing must not regress the authoritative IDB revision.
  storage.setItem(mirrorKey, staleMirror);
  const blocked = (await outbox.listOutbox("owner"))[0];
  assert.equal(blocked.operation, "held");
  assert.equal(blocked.releaseAt, "2026-01-01T00:00:10.000Z");
  assert.equal(blocked.state, "blocked");
  assert.deepEqual((await outbox.listOutbox("owner")).map((row) => row.clientId), [
    "later",
  ]);

  // A quota failure can leave the stale mirror behind after Glass accepted the
  // send. The IDB acknowledgement tombstone must prevent resurrection.
  const normalSet = storage.setItem.bind(storage);
  const normalRemove = storage.removeItem.bind(storage);
  storage.setItem = () => { throw new Error("quota full"); };
  storage.removeItem = () => { throw new Error("cleanup interrupted"); };
  await outbox.ackOutbox("owner", "later");
  assert.equal(
    await outbox.updateOutbox("owner", "later", { state: "queued" }),
    false,
  );
  assert.deepEqual(await outbox.listOutbox("owner"), []);
  storage.setItem = normalSet;
  storage.removeItem = normalRemove;
  // A changed stale UI intent cannot hide behind an acknowledgement for a
  // different operation/payload. An exact replay remains safely idempotent.
  await assert.rejects(
    outbox.enqueueOutbox("owner", {
      roomId: "room",
      clientId: "later",
      body: "must not resurrect",
      at: 30,
    }),
    /different|ambiguous/,
  );
  await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "later",
    operation: "held",
    body: "replacement",
    releaseAt: "2026-01-01T00:00:10.000Z",
    at: 20,
  });
  assert.deepEqual(await outbox.listOutbox("owner"), []);
  assert.equal(storage.getItem(mirrorKey), null);

  // An ack can land after listOutbox snapshots localStorage but before its IDB
  // read returns. The final per-client tombstone recheck must still shadow the
  // stale intent in this very call.
  await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "ack-during-list",
    body: "must stay accepted",
    at: 40,
  });
  const normalGet = storage.getItem.bind(storage);
  let injectedAck = false;
  storage.getItem = (candidate) => {
    if (!injectedAck && candidate.includes(":v2:ack:") && candidate.endsWith("ack-during-list")) {
      injectedAck = true;
      normalSet(candidate, String(Date.now()));
    }
    return normalGet(candidate);
  };
  assert.deepEqual(await outbox.listOutbox("owner"), []);
  storage.getItem = normalGet;
});
