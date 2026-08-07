import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deleteDatabase, event, installBrowser } from "./helpers.mjs";

const chatStoreSource = await readFile(
  new URL("../../src/lib/chat-store.ts", import.meta.url),
  "utf8",
);
const chatPageSource = await readFile(
  new URL("../../src/app/chat/page.tsx", import.meta.url),
  "utf8",
);

const CHECKPOINT = { event: "c1", account: "a1", eventPosition: 1, accountPosition: 1 };

async function seedOwner(cache, ownerId, roomId, eventId) {
  await cache.storeEvents(ownerId, [
    { roomId, event: event(eventId, "2026-01-01T00:00:01.000Z", "hello") },
  ]);
  await cache.writeSyncCheckpoint(ownerId, CHECKPOINT);
}

test("signing in retires every other owner's cached projections", async () => {
  await deleteDatabase("silicon-interface-chat-cache");
  installBrowser();
  const cache = await import("../../src/lib/chat-store.ts");

  await seedOwner(cache, "owner-a", "room-a", "event-a");
  await seedOwner(cache, "owner-b", "room-b", "event-b");
  assert.deepEqual((await cache.listCachedChatOwners()).sort(), ["owner-a", "owner-b"]);

  const result = await cache.purgeForeignChatCaches("owner-b");
  assert.deepEqual(result.owners, ["owner-a"]);
  assert.equal(result.deletedEvents, 1);

  // The signed-out owner is gone from every store...
  assert.deepEqual(await cache.listCachedChatOwners(), ["owner-b"]);
  assert.deepEqual(await cache.loadStoredRoomEvents("owner-a", "room-a", 100), []);
  assert.equal(await cache.readSyncCheckpoint("owner-a"), null);
  assert.deepEqual(await cache.pendingDeliveryAcknowledgements("owner-a"), []);

  // ...and the owner signing in is untouched.
  assert.equal(
    (await cache.loadStoredRoomEvents("owner-b", "room-b", 100)).length,
    1,
  );
  assert.deepEqual(await cache.readSyncCheckpoint("owner-b"), CHECKPOINT);
  assert.deepEqual(await cache.pendingDeliveryAcknowledgements("owner-b"), ["event-b"]);
});

test("a purge never widens past its own owner prefix", async () => {
  await deleteDatabase("silicon-interface-chat-cache");
  installBrowser();
  const cache = await import("../../src/lib/chat-store.ts");

  // "owner" is a strict prefix of "owner-2", and the composite key separator
  // sorts between them. A naive range would take both.
  await seedOwner(cache, "owner", "room", "event-1");
  await seedOwner(cache, "owner-2", "room", "event-2");
  await seedOwner(cache, "owner:odd", "room", "event-3");

  const result = await cache.purgeChatCacheOwners(["owner"]);
  assert.deepEqual(result.owners, ["owner"]);
  assert.equal(result.deletedEvents, 1);
  assert.equal((await cache.loadStoredRoomEvents("owner-2", "room", 100)).length, 1);
  assert.equal((await cache.loadStoredRoomEvents("owner:odd", "room", 100)).length, 1);
});

test("purging is a no-op when nothing foreign is cached", async () => {
  await deleteDatabase("silicon-interface-chat-cache");
  installBrowser();
  const cache = await import("../../src/lib/chat-store.ts");

  await seedOwner(cache, "owner-a", "room-a", "event-a");
  assert.deepEqual(await cache.purgeForeignChatCaches("owner-a"), {
    owners: [],
    deletedEvents: 0,
  });
  assert.deepEqual(await cache.purgeChatCacheOwners([]), {
    owners: [],
    deletedEvents: 0,
  });
  assert.deepEqual(await cache.purgeForeignChatCaches(""), {
    owners: [],
    deletedEvents: 0,
  });
  assert.equal((await cache.loadStoredRoomEvents("owner-a", "room-a", 100)).length, 1);
});

test("logout purges replaceable projections but never unsent local work", () => {
  const listener = chatStoreSource.indexOf('"silicon-interface:auth-clear"');
  assert.ok(listener > 0);
  const handler = chatStoreSource.slice(listener);
  assert.match(handler, /purgeChatCacheOwners\(\[ownerId\]\)/);

  // The outbox, drafts, media uploads, and voice drafts hold work that has
  // never reached Glass. No logout path may reach into their databases.
  for (const forbidden of [
    "silicon-interface-outbox",
    "silicon-interface-media-outbox",
    "silicon-interface-draft-journal",
    "silicon-interface-voice-drafts",
  ]) {
    assert.doesNotMatch(chatStoreSource, new RegExp(forbidden));
  }
});

test("the sign-in sweep runs once per owner and covers both caches", () => {
  const sweep = chatPageSource.indexOf("sweptForeignOwnerRef");
  assert.ok(sweep > 0);
  const effect = chatPageSource.slice(sweep, sweep + 900);
  assert.match(effect, /sweptForeignOwnerRef\.current === ownerId\) return/);
  assert.match(effect, /purgeForeignSidebarCaches\(ownerId\)/);
  assert.match(effect, /purgeForeignChatCaches\(ownerId\)/);
});
