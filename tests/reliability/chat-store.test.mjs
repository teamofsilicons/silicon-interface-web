import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteDatabase,
  event,
  indexedDB,
  installBrowser,
} from "./helpers.mjs";

function openVersionOneChatCache(rows) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-interface-chat-cache", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("events", { keyPath: "key" });
      store.createIndex("ownerRoom", ["ownerId", "roomId", "eventId"]);
      store.createIndex("storedAt", "storedAt");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("events", "readwrite");
      for (const row of rows) transaction.objectStore("events").put(row);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

test("offline timeline migrates v1 rows and remains chronological", async () => {
  await deleteDatabase("silicon-interface-chat-cache");
  installBrowser();
  const oldRows = [
    event("z-random-id", "2026-01-01T00:00:01.000Z", "first"),
    event("a-random-id", "2026-01-01T00:00:02.000Z", "second"),
  ].map((value) => ({
    key: `owner:${value.event_id}`,
    ownerId: "owner",
    roomId: "room",
    eventId: value.event_id,
    event: value,
    storedAt: 1,
  }));
  await openVersionOneChatCache(oldRows);

  const cache = await import("../../src/lib/chat-store.ts");
  assert.deepEqual(
    (await cache.loadStoredRoomEvents("owner", "room", 100)).map(
      (row) => row.content.body,
    ),
    ["first", "second"],
  );

  await cache.storeEvents("owner", [
    {
      roomId: "room",
      event: event("m-random-id", "2026-01-01T00:00:03.000Z", "third"),
    },
  ]);
  assert.deepEqual(
    (await cache.loadStoredRoomEvents("owner", "room", 2)).map(
      (row) => row.content.body,
    ),
    ["second", "third"],
  );
});

test("a newer database version reopens safely without losing cached history", async () => {
  await deleteDatabase("silicon-interface-chat-cache");
  installBrowser();
  const cache = await import("../../src/lib/chat-store.ts");
  const kept = event(
    "01J00000000000000000000009",
    "2026-01-01T00:00:09.000Z",
    "kept across a newer schema",
  );
  await cache.storeEvents("compatible-owner", [{ roomId: "room", event: kept }]);
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-interface-chat-cache", 10);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  assert.deepEqual(
    await cache.loadStoredRoomEvents("compatible-owner", "room"),
    [kept],
  );
});

test("timeline pressure eviction requires reachability and retains each room tail", async () => {
  await deleteDatabase("silicon-interface-chat-cache");
  installBrowser();
  const cache = await import("../../src/lib/chat-store.ts");
  const rows = [];
  for (const roomId of ["room-a", "room-b"]) {
    for (let index = 0; index < 30; index += 1) {
      rows.push({
        roomId,
        event: event(
          `${roomId === "room-a" ? "a" : "b"}${String(index).padStart(25, "0")}`,
          `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          `${roomId}-${index}`,
        ),
      });
    }
  }
  await cache.storeEvents("owner", rows);
  assert.deepEqual(
    await cache.pruneReachableTimelineCache("owner", {
      reachable: false, usage: 99, quota: 100, keepPerRoom: 25,
    }),
    { reason: "offline", deleted: 0, retained: 0 },
  );
  assert.equal((await cache.loadStoredRoomEvents("owner", "room-a", 100)).length, 30);

  const result = await cache.pruneReachableTimelineCache("owner", {
    reachable: true,
    usage: 99,
    quota: 100,
    keepPerRoom: 25,
    maxDeletes: 100,
    protectedEventIds: ["a0000000000000000000000000"],
  });
  assert.deepEqual(result, { reason: "pruned", deleted: 9, retained: 51 });
  const roomA = await cache.loadStoredRoomEvents("owner", "room-a", 100);
  const roomB = await cache.loadStoredRoomEvents("owner", "room-b", 100);
  assert.equal(roomA.length, 26);
  assert.equal(roomB.length, 25);
  assert.equal(roomA[0].event_id, "a0000000000000000000000000");
});

test("browser storage support export excludes content and identities", async () => {
  installBrowser();
  globalThis.navigator.storage = { estimate: async () => ({ usage: 12, quota: 100 }) };
  const health = await import("../../src/lib/storage-health.ts");
  const report = await health.storageSupportReport({
    severity: "blocked",
    area: "timeline",
    message: "secret message and owner-id",
    at: 1,
  });
  assert.match(report, /storage_usage_bytes=12/);
  assert.match(report, /content_included=false/);
  assert.doesNotMatch(report, /secret message|owner-id/);
});

test("manual history rebuild is reachability-gated and preserves the send outbox", async () => {
  installBrowser();
  const cache = await import("../../src/lib/chat-store.ts");
  const outbox = await import("../../src/lib/outbox.ts");
  const ownerId = "rebuild-owner";
  await cache.storeEvents(
    ownerId,
    [{
      roomId: "rebuild-room",
      event: event("rebuild-event", "2026-01-01T00:00:00.000Z", "cached"),
    }],
    {
      event: "signed-event-cursor",
      account: "signed-account-cursor",
      eventPosition: 1,
      accountPosition: 1,
    },
  );
  await outbox.enqueueOutbox(ownerId, {
    roomId: "rebuild-room",
    clientId: "queued-client",
    body: "must survive",
    at: 1,
  });

  await assert.rejects(
    cache.rebuildReachableChatCache(ownerId, false),
    /must be reachable/,
  );
  assert.equal((await cache.loadStoredRoomEvents(ownerId, "rebuild-room")).length, 1);

  assert.deepEqual(await cache.rebuildReachableChatCache(ownerId, true), {
    deletedEvents: 1,
  });
  assert.deepEqual(await cache.loadStoredRoomEvents(ownerId, "rebuild-room"), []);
  assert.equal(await cache.readSyncCheckpoint(ownerId), null);
  assert.deepEqual(
    (await outbox.listOutbox(ownerId)).map((entry) => entry.clientId),
    ["queued-client"],
  );
});
