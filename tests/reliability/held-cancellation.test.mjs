import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/lib/api.ts";
import {
  findHeldCancellationEvent,
  garbageCollectHeldCancellations,
  getHeldCancellation,
  heldCancellationCanHide,
  listHeldCancellations,
  markHeldCancellationProjected,
  maySendHeldOutbox,
  reconcileHeldCancellation,
  requestHeldCancellation,
  withOutboxClientLock,
} from "../../src/lib/held-cancellation.ts";
import { ackOutbox, enqueueOutbox, listOutbox } from "../../src/lib/outbox.ts";
import {
  deleteDatabase,
  indexedDB,
  installBrowser,
  MemoryStorage,
} from "./helpers.mjs";

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function held(row, state, id = "held-1") {
  return {
    held_send_id: id,
    room_id: row.roomId,
    client_id: row.clientId,
    device_id: "device-1",
    type: "m.text",
    content: { ...row.content, body: row.body, client_id: row.clientId },
    reply_to_event_id: row.replyTo ?? "",
    state,
    release_at: row.releaseAt ?? "2026-07-12T00:00:00.000Z",
    sent_event_id: state === "sent" ? "event-1" : "",
    version: 1,
    error: "",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    terminal_at: state === "pending" ? "" : "2026-07-11T00:00:01.000Z",
  };
}

function operation(row, result) {
  const state = result.state === "sent"
    ? "succeeded"
    : result.state === "cancelled"
      ? "cancelled"
      : result.state === "failed"
        ? "failed"
        : "pending";
  return {
    operation_id: "operation-1",
    room_id: row.roomId,
    kind: "held_send",
    client_id: row.clientId,
    device_id: "device-1",
    state,
    resource_id: result.held_send_id,
    result_event_id: result.sent_event_id,
    http_status: 200,
    accepted_at: "2026-07-11T00:00:00.000Z",
    terminal_at: result.terminal_at,
    expires_at: "2026-08-11T00:00:00.000Z",
    result: { kind: "held_send", held_send: result },
  };
}

test("held cancellation survives ack races and restart while permanently shadowing send", async () => {
  await deleteDatabase("silicon-interface-held-cancellations");
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "cancel-race-owner";
  await enqueueOutbox(owner, {
    roomId: "room-1",
    clientId: "client-1",
    operation: "held",
    type: "m.text",
    body: "never release me",
    content: { body: "never release me" },
    releaseAt: "2026-07-12T00:00:00.000Z",
    at: 10,
  });

  await Promise.all([
    requestHeldCancellation(owner, {
      roomId: "room-1",
      clientId: "client-1",
      body: "never release me",
      content: { body: "never release me" },
      releaseAt: "2026-07-12T00:00:00.000Z",
    }),
    ackOutbox(owner, "client-1"),
  ]);

  assert.equal(await maySendHeldOutbox(owner, "client-1"), false);
  assert.deepEqual(await listOutbox(owner), []);
  assert.equal((await getHeldCancellation(owner, "client-1")).state, "pending");

  // A fresh window/tab sees both IndexedDB and the per-client mirror. The send
  // acknowledgement cannot delete the independent cancellation journal.
  installBrowser(storage);
  const restored = await listHeldCancellations(owner);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].body, "never release me");
  assert.equal(await maySendHeldOutbox(owner, "client-1"), false);
});

test("cancellation storage failure leaves the held send visible/sendable", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const probe = await openDatabase("silicon-interface-held-cancellations");
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const normalTransaction = proto.transaction;
  proto.transaction = function (...args) {
    const transaction = normalTransaction.apply(this, args);
    if (args[1] === "readwrite") {
      queueMicrotask(() => {
        try { transaction.abort(); } catch { /* transaction already completed */ }
      });
    }
    return transaction;
  };
  const normalSet = storage.setItem.bind(storage);
  storage.setItem = () => { throw new Error("quota full"); };
  try {
    await assert.rejects(
      requestHeldCancellation("cancel-failure-owner", {
        roomId: "room-1",
        clientId: "failure-client",
        body: "still visible",
      }),
      /Unable to durably cancel/,
    );
  } finally {
    proto.transaction = normalTransaction;
    storage.setItem = normalSet;
  }
  assert.equal(await maySendHeldOutbox("cancel-failure-owner", "failure-client"), true);
});

test("lost create response is materialized with the same client id then authoritatively cancelled", async () => {
  installBrowser();
  const row = await requestHeldCancellation("materialize-owner", {
    roomId: "room-1",
    clientId: "materialize-client",
    body: "cancel across restart",
    content: { hold_group_id: "group-1" },
    releaseAt: new Date(Date.now() + 10_000).toISOString(),
  });
  const calls = [];
  const state = await reconcileHeldCancellation(row, {
    lookup: async () => {
      calls.push("lookup");
      throw new ApiError(404, {}, "not found");
    },
    create: async (saved, holdSeconds) => {
      calls.push(["create", saved.clientId, holdSeconds]);
      return held(saved, "pending");
    },
    cancel: async (_roomId, heldSendId) => {
      calls.push(["cancel", heldSendId]);
      return held(row, "cancelled", heldSendId);
    },
  }, "device-1");
  assert.equal(state, "cancelled");
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "lookup",
    "create",
    "cancel",
  ]);
  assert.equal((await getHeldCancellation(row.ownerId, row.clientId)).state, "cancelled");
  assert.equal(await maySendHeldOutbox(row.ownerId, row.clientId), false);
});

test("cross-tab lock holder rechecks the durable cancellation before release", async () => {
  installBrowser();
  const tails = new Map();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(name, _options, callback) {
          const prior = tails.get(name) ?? Promise.resolve();
          const result = prior.then(callback);
          tails.set(name, result.catch(() => undefined));
          return result;
        },
      },
    },
  });
  const owner = "locked-race-owner";
  const clientId = "locked-race-client";
  let releaseGate;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let releases = 0;
  const staleFlush = withOutboxClientLock(owner, clientId, async () => {
    startedResolve();
    await gate;
    if (await maySendHeldOutbox(owner, clientId)) releases += 1;
  });
  await started;
  await requestHeldCancellation(owner, {
    roomId: "room-1",
    clientId,
    body: "cancel while another tab is flushing",
  });
  releaseGate();
  await staleFlush;
  assert.equal(releases, 0);
});

test("no-Web-Locks races never hide a release that already won", async () => {
  installBrowser();
  Object.defineProperty(globalThis, "navigator", {
    value: {},
    configurable: true,
  });
  await enqueueOutbox("no-lock-owner", {
    roomId: "room-1",
    clientId: "no-lock-client",
    operation: "held",
    type: "m.text",
    body: "race",
    at: 100,
  });
  const row = await requestHeldCancellation("no-lock-owner", {
    roomId: "room-1",
    clientId: "no-lock-client",
    body: "race",
  });
  assert.equal(globalThis.navigator?.locks, undefined);

  // Cancellation won before a stale flusher's final preflight: no release.
  let releases = 0;
  if (await maySendHeldOutbox(row.ownerId, row.clientId)) releases += 1;
  assert.equal(releases, 0);

  // If Glass already atomically released, reconciliation returns `sent`.
  // Callers keep/reconcile the visible row instead of reporting cancellation.
  const sent = held(row, "sent");
  const state = await reconcileHeldCancellation(row, {
    lookup: async () => operation(row, sent),
    create: async () => { throw new Error("must not create"); },
    cancel: async () => { throw new Error("must not cancel a sent row"); },
  }, "device-1");
  assert.equal(state, "sent");
  let restored = await getHeldCancellation(row.ownerId, row.clientId);
  assert.equal(restored.state, "sent");
  assert.equal(restored.sentEventId, "event-1");
  assert.equal(heldCancellationCanHide(restored), false);
  assert.equal(findHeldCancellationEvent(restored, []), null);
  assert.equal((await listOutbox(row.ownerId)).length, 1);

  // Restart while offline: without the authoritative event projection the
  // sent-awaiting-sync row remains visible and the last local representation
  // is not acknowledged away.
  installBrowser(window.localStorage);
  restored = await getHeldCancellation(row.ownerId, row.clientId);
  assert.equal(heldCancellationCanHide(restored), false);
  const collidingOtherDevice = {
    event_id: "other-device-event",
    content: { client_id: row.clientId, body: "different device" },
  };
  assert.equal(
    findHeldCancellationEvent(restored, [collidingOtherDevice]),
    null,
    "a cross-device client_id collision cannot project or ack this held row",
  );

  const authoritative = {
    event_id: "event-1",
    content: { client_id: row.clientId, body: "race" },
  };
  assert.equal(findHeldCancellationEvent(restored, [authoritative]), authoritative);
  assert.equal(await markHeldCancellationProjected(row.ownerId, row.clientId), true);
  restored = await getHeldCancellation(row.ownerId, row.clientId);
  assert.equal(heldCancellationCanHide(restored), true);
  await ackOutbox(row.ownerId, row.clientId);
  assert.equal(
    await garbageCollectHeldCancellations(
      row.ownerId,
      Date.now() + 31 * 24 * 60 * 60 * 1_000,
    ),
    1,
  );
  assert.equal(await getHeldCancellation(row.ownerId, row.clientId), null);
});
