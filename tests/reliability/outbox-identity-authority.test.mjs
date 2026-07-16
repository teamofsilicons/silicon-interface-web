import assert from "node:assert/strict";
import test from "node:test";

import { indexedDB, installBrowser, MemoryStorage } from "./helpers.mjs";

function seedDurableOutbox(owner, entry) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-interface-outbox", 2);
    request.onupgradeneeded = () => {
      const entries = request.result.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("ownerAt", ["ownerId", "at"]);
      request.result.createObjectStore("meta", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(["entries", "meta"], "readwrite");
      tx.objectStore("entries").put({
        key: `${owner}:${entry.clientId}`,
        ownerId: owner,
        at: entry.at,
        entry,
      });
      tx.objectStore("meta").put({
        key: `sequence:${owner}:${entry.originDevice}`,
        value: entry.localSequence,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

test("valid strict-IDB identity repairs a stale localStorage mirror", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "idb-authority-owner";
  const clientId = "idb-authority-client";
  const durable = {
    roomId: "authority-room",
    clientId,
    body: "durable authority",
    at: 50_000,
    localKey: "local:device-a:idb-authority-client",
    localSequence: 50_000_000,
    originDevice: "device-a",
    localCreatedAt: "1970-01-01T00:00:50.000Z",
  };
  await seedDurableOutbox(owner, durable);
  storage.setItem(
    `silicon-interface:timeline-identity:v1:${encodeURIComponent(owner)}:${encodeURIComponent(clientId)}`,
    JSON.stringify({
      clientId,
      localKey: "local:device-a:stale-wrong-key",
      localSequence: 1,
      originDevice: "device-a",
      localCreatedAt: "1970-01-01T00:00:00.001Z",
      eventId: "wrong-event",
    }),
  );

  const outbox = await import("../../src/lib/outbox.ts");
  const timeline = await import("../../src/lib/timeline-identity.ts");
  const listed = await outbox.listOutbox(owner);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].localKey, durable.localKey);
  assert.deepEqual(timeline.readTimelineIdentity(owner, clientId), {
    clientId,
    localKey: durable.localKey,
    localSequence: durable.localSequence,
    originDevice: durable.originDevice,
    localCreatedAt: durable.localCreatedAt,
  });
});
