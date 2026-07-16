import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { deleteDatabase, indexedDB } from "./helpers.mjs";

test("service worker durably stores out-of-band proof before displaying notification", async () => {
  await deleteDatabase("silicon-interface-abuse-proofs");
  const handlers = new Map();
  const notifications = [];
  const self = {
    indexedDB,
    addEventListener(type, handler) { handlers.set(type, handler); },
    skipWaiting() {},
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async () => null,
    },
    registration: {
      getNotifications: async () => [],
      showNotification: async (title, options) => notifications.push({ title, options }),
    },
  };
  const source = await fs.readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self,
    indexedDB,
    navigator: {},
    fetch: async () => ({ ok: true }),
    URLSearchParams,
    Date,
  });
  let ownerCompletion;
  handlers.get("message")({
    data: { type: "silicon-active-notification-owner", ownerId: "owner-1" },
    waitUntil(promise) { ownerCompletion = promise; },
  });
  await ownerCompletion;
  let completion;
  handlers.get("push")({
    data: {
      json: () => ({
        kind: "abuse_challenge",
        title: "Verify",
        challenge_token: "signed-token",
        challenge_answer: "secret-proof",
      }),
    },
    waitUntil(promise) { completion = promise; },
  });
  await completion;

  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-interface-abuse-proofs", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const request = db.transaction("proofs", "readonly").objectStore("proofs").get("signed-token");
  const proof = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(proof.answer, "secret-proof");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.body, "Open Silicon to continue sending.");
  assert.equal(notifications[0].options.data.challengeToken, "signed-token");
  db.close();
});

test("read reconciliation closes the room, applies badge, wakes tabs, and acknowledges", async () => {
  await deleteDatabase("silicon-interface-notification-state");
  const handlers = new Map();
  const closed = [];
  const messages = [];
  const requests = [];
  const badges = [];
  const self = {
    indexedDB,
    addEventListener(type, handler) { handlers.set(type, handler); },
    skipWaiting() {},
    clients: {
      claim: async () => undefined,
      matchAll: async () => [{ postMessage: (message) => messages.push(message) }],
      openWindow: async () => null,
    },
    registration: {
      getNotifications: async () => [
        {
          tag: "room-7",
          data: {
            ownerId: "owner-1", roomId: "room-7",
            streamWriter: "writer-a", streamPosition: 8,
          },
          close: () => closed.push("matching"),
        },
        {
          tag: "room-7",
          data: {
            ownerId: "owner-1", roomId: "room-7",
            streamWriter: "writer-a", streamPosition: 10,
          },
          close: () => closed.push("newer"),
        },
        { tag: "other", data: {}, close: () => closed.push("other") },
      ],
      showNotification: async () => undefined,
    },
  };
  const source = await fs.readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self,
    indexedDB,
    navigator: { setAppBadge: async (badge) => badges.push(badge) },
    fetch: async (url, options) => {
      requests.push({
        url,
        body: Object.fromEntries(options.body.entries()),
        headers: options.headers,
      });
      return { ok: true };
    },
    URLSearchParams,
    Date,
  });
  let activeOwnerCompletion;
  handlers.get("message")({
    data: { type: "silicon-active-notification-owner", ownerId: "owner-1" },
    waitUntil(promise) { activeOwnerCompletion = promise; },
  });
  await activeOwnerCompletion;
  let completion;
  handlers.get("push")({
    data: { json: () => ({
      kind: "read_sync",
      owner_id: "owner-1",
      tag: "room-7",
      room_id: "room-7",
      badge: 2,
      badge_revision: 21,
      reconciliation_revision: 17,
      read_stream_vector: { floor: 9, writers: {} },
      delivery_id: "delivery-17",
      display_ack_token: "capability-17",
      display_ack_url: "https://glass.example/ack",
      traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
    }) },
    waitUntil(promise) { completion = promise; },
  });
  await completion;

  assert.deepEqual(closed, ["matching"]);
  assert.deepEqual(badges, [2]);
  assert.equal(messages[0].type, "silicon-read-reconciliation");
  assert.equal(messages[0].revision, 17);
  assert.equal(requests[0].body.outcome, "reconciled");
  assert.equal(requests[0].body.delivery_id, "delivery-17");
  assert.equal(
    requests[0].headers.traceparent,
    "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
  );

  let staleCompletion;
  handlers.get("push")({
    data: { json: () => ({
      kind: "read_sync", owner_id: "owner-1", room_id: "room-stale", badge: 9,
      badge_revision: 20,
      reconciliation_revision: 16,
      read_stream_vector: { floor: 1, writers: {} },
      delivery_id: "delivery-16", display_ack_token: "capability-16",
      display_ack_url: "https://glass.example/ack",
    }) },
    waitUntil(promise) { staleCompletion = promise; },
  });
  await staleCompletion;
  assert.deepEqual(closed, ["matching"]);
  assert.deepEqual(badges, [2]);
  assert.equal(messages.length, 1);
  assert.equal(requests[1].body.outcome, "reconciled");

  let newerBadgeCompletion;
  handlers.get("push")({
    data: { json: () => ({
      owner_id: "owner-1", room_id: "room-8", title: "newer",
      badge: 1, badge_revision: 22,
    }) },
    waitUntil(promise) { newerBadgeCompletion = promise; },
  });
  await newerBadgeCompletion;
  let reorderedBadgeCompletion;
  handlers.get("push")({
    data: { json: () => ({
      owner_id: "owner-1", room_id: "room-9", title: "older",
      badge: 8, badge_revision: 21,
    }) },
    waitUntil(promise) { reorderedBadgeCompletion = promise; },
  });
  await reorderedBadgeCompletion;
  assert.deepEqual(badges, [2, 1]);
  await deleteDatabase("silicon-interface-notification-state");
});
