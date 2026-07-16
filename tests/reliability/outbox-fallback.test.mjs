import assert from "node:assert/strict";
import test from "node:test";

import { indexedDB, installBrowser, MemoryStorage } from "./helpers.mjs";

test("outbox falls back to localStorage", async () => {
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  const storage = installBrowser(new MemoryStorage(), unavailable);
  const outbox = await import("../../src/lib/outbox.ts");
  const health = await import("../../src/lib/storage-health.ts");

  await outbox.enqueueOutbox("owner", {
    roomId: "room",
    clientId: "safe",
    body: "still durable",
    at: 1,
  });
  assert.equal((await outbox.listOutbox("owner"))[0].clientId, "safe");
  assert.ok(storage.length > 0);
  assert.equal(health.currentStorageIssue()?.severity, "degraded");
});

test("outbox refuses an entirely non-durable send", async () => {
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  const brokenStorage = new MemoryStorage();
  brokenStorage.setItem = () => { throw new Error("quota exceeded"); };
  installBrowser(brokenStorage, unavailable);
  const outbox = await import("../../src/lib/outbox.ts");
  const health = await import("../../src/lib/storage-health.ts");

  await assert.rejects(
    outbox.enqueueOutbox("owner", {
      roomId: "room",
      clientId: "unsafe",
      body: "must stay in composer",
      at: 2,
    }),
    /Unable to persist/,
  );
  assert.equal(health.currentStorageIssue()?.severity, "blocked");
});

test("outbox retries a transient IndexedDB open failure without a reload", async () => {
  let opens = 0;
  const transientDatabase = {
    open(...args) {
      opens += 1;
      if (opens === 1) throw new Error("temporary storage policy failure");
      return indexedDB.open(...args);
    },
  };
  const storage = installBrowser(new MemoryStorage(), transientDatabase);
  const outbox = await import("../../src/lib/outbox.ts");

  await outbox.enqueueOutbox("recovered-owner", {
    roomId: "room",
    clientId: "mirror-first",
    body: "survives fallback",
    at: 1,
  });
  await outbox.enqueueOutbox("recovered-owner", {
    roomId: "room",
    clientId: "idb-second",
    body: "storage recovered",
    at: 2,
  });

  assert.equal(opens, 2);
  assert.deepEqual(
    (await outbox.listOutbox("recovered-owner")).map((row) => row.clientId),
    ["mirror-first", "idb-second"],
  );
  assert.ok(storage.length > 0);
});

test("malformed recovery metadata blocks but never hides a saved message", async () => {
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  const storage = new MemoryStorage();
  const owner = "malformed-failure-owner";
  const clientId = "still-visible";
  const key = `silicon-interface:outbox:v2:intent:${encodeURIComponent(owner)}:${encodeURIComponent(clientId)}`;
  storage.setItem(key, JSON.stringify({
    roomId: "room",
    clientId,
    body: "do not lose me",
    at: 10,
    state: "retry_wait",
    failure: {
      domain: "chat.operation",
      code: "server_unavailable",
      messageKey: "send_failure.server_unavailable",
      retryable: false,
      automatic: true,
      correctionActions: [],
      attempt: 1,
      failedAt: 10,
      nextAttemptAt: 20,
      httpStatus: 503,
    },
  }));
  installBrowser(storage, unavailable);
  const outbox = await import("../../src/lib/outbox.ts");

  const [saved] = await outbox.listOutbox(owner);
  assert.equal(saved.clientId, clientId);
  assert.equal(saved.body, "do not lose me");
  assert.equal(saved.state, "blocked");
  assert.equal(saved.failure, undefined);
  assert.equal(saved.lastError, "This saved send has invalid recovery metadata.");
});

test("legacy array migrates copy-first and interleaved tab intents cannot clobber each other", async () => {
  const unavailable = { open: () => { throw new Error("IndexedDB unavailable"); } };
  const storage = new MemoryStorage();
  const owner = "multi-tab-owner";
  const legacyKey = `silicon-interface:outbox:${encodeURIComponent(owner)}`;
  storage.setItem(legacyKey, JSON.stringify([
    { roomId: "room", clientId: "legacy-a", body: "A", at: 1 },
    { roomId: "room", clientId: "legacy-b", body: "B", at: 2 },
  ]));
  installBrowser(storage, unavailable);
  const outbox = await import("../../src/lib/outbox.ts");

  assert.deepEqual(
    (await outbox.listOutbox(owner)).map((row) => row.clientId),
    ["legacy-a", "legacy-b"],
  );
  assert.equal(storage.getItem(legacyKey), null, "legacy bytes are removed only after copy");

  const normalSet = storage.setItem.bind(storage);
  let injected = false;
  storage.setItem = (key, value) => {
    const parsed = key.includes(":v2:intent:") ? JSON.parse(value) : null;
    if (!injected && parsed?.clientId === "tab-a") {
      injected = true;
      const otherKey = key.replace(encodeURIComponent("tab-a"), encodeURIComponent("tab-b"));
      normalSet(otherKey, JSON.stringify({
        roomId: "room",
        clientId: "tab-b",
        body: "from the other tab",
        at: 4,
        updatedAt: 4,
      }));
    }
    normalSet(key, value);
  };

  await outbox.enqueueOutbox(owner, {
    roomId: "room",
    clientId: "tab-a",
    body: "from this tab",
    at: 3,
  });
  assert.deepEqual(
    (await outbox.listOutbox(owner)).map((row) => row.clientId),
    ["legacy-a", "legacy-b", "tab-a", "tab-b"],
  );
});
