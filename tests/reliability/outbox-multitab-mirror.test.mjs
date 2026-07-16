import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

test("mirror-only concurrent tab intents are independent and ack is per client", async () => {
  const storage = new MemoryStorage();
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  installBrowser(storage, unavailable);
  const outbox = await import("../../src/lib/outbox.ts");
  const owner = "shared-tab-owner";

  await Promise.all([
    outbox.enqueueOutbox(owner, {
      roomId: "room",
      clientId: "tab-one",
      body: "from one tab",
      at: 1,
    }),
    outbox.enqueueOutbox(owner, {
      roomId: "room",
      clientId: "tab-two",
      body: "from another tab",
      at: 2,
    }),
  ]);

  assert.deepEqual(
    (await outbox.listOutbox(owner)).map((row) => row.clientId),
    ["tab-one", "tab-two"],
  );
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  assert.equal(keys.filter((key) => key?.includes(":v2:intent:")).length, 2);

  await outbox.ackOutbox(owner, "tab-one");
  assert.deepEqual(
    (await outbox.listOutbox(owner)).map((row) => row.clientId),
    ["tab-two"],
    "acknowledging one tab's client ID cannot rewrite or erase another tab's intent",
  );
  assert.ok(
    Array.from({ length: storage.length }, (_, index) => storage.key(index)).some(
      (key) => key?.includes(":v2:intent:") && key.endsWith("tab-two"),
    ),
  );

  await outbox.enqueueOutbox(owner, {
    roomId: "room",
    clientId: "tab-three",
    body: "acked during fallback listing",
    at: 3,
  });
  const normalGet = storage.getItem.bind(storage);
  const normalSet = storage.setItem.bind(storage);
  let ackInjected = false;
  storage.getItem = (key) => {
    if (!ackInjected && key.includes(":v2:ack:") && key.endsWith("tab-three")) {
      ackInjected = true;
      normalSet(key, String(Date.now()));
    }
    return normalGet(key);
  };
  assert.deepEqual(
    (await outbox.listOutbox(owner)).map((row) => row.clientId),
    ["tab-two"],
    "a live ack that lands after the mirror snapshot wins in fallback mode",
  );
});
