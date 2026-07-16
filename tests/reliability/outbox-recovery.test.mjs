import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/lib/api.ts";
import {
  classifyOutboxFailure,
  nextOutboxWakeAt,
  OUTBOX_RETRY_SCHEDULED_EVENT,
  persistOutboxFailure,
  prepareManualOutboxRetry,
  settleResolvingOutboxFailure,
  shouldFlushOutbox,
} from "../../src/lib/outbox-recovery.ts";
import {
  ackOutbox,
  enqueueOutbox,
  listOutbox,
  updateOutbox,
} from "../../src/lib/outbox.ts";
import {
  deleteDatabase,
  indexedDB,
  installBrowser,
  MemoryStorage,
} from "./helpers.mjs";

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("outbox wake policy does not depend on WebSocket readiness or polling", () => {
  const healthyHttpsWithoutSocket = {
    ownerId: "owner",
    online: true,
    visible: true,
    socketReady: false,
  };
  assert.equal(shouldFlushOutbox("mount", healthyHttpsWithoutSocket), true);
  assert.equal(shouldFlushOutbox("online", healthyHttpsWithoutSocket), true);
  assert.equal(shouldFlushOutbox("foreground", healthyHttpsWithoutSocket), true);
  assert.equal(shouldFlushOutbox("socket-ready", healthyHttpsWithoutSocket), false);
  assert.equal(shouldFlushOutbox("https-poll", healthyHttpsWithoutSocket), true);
  assert.equal(
    shouldFlushOutbox("https-poll", {
      ...healthyHttpsWithoutSocket,
      online: false,
    }),
    true,
    "a completed HTTPS poll is stronger evidence than stale navigator.onLine",
  );
  assert.equal(
    shouldFlushOutbox("mount", { ...healthyHttpsWithoutSocket, ownerId: null }),
    false,
  );

  const now = 1_000;
  assert.equal(
    nextOutboxWakeAt(
      [
        { roomId: "r", clientId: "blocked", body: "x", at: 1, state: "blocked" },
        { roomId: "r", clientId: "later", body: "x", at: 2, nextAttemptAt: 9_000 },
        { roomId: "r", clientId: "first", body: "x", at: 3, nextAttemptAt: 4_000 },
      ],
      now,
    ),
    4_000,
  );
});

test("first failure persists Retry-After and terminal classification", () => {
  const throttled = classifyOutboxFailure({
    status: 429,
    attempts: 1,
    now: 10_000,
    retryAfterMs: 120_000,
    message: "slow down",
  });
  assert.deepEqual(throttled, {
    state: "queued",
    attempts: 1,
    nextAttemptAt: 130_000,
    lastError: "slow down",
  });
  assert.deepEqual(
    classifyOutboxFailure({
      status: 403,
      attempts: 1,
      now: 10_000,
      retryAfterMs: 120_000,
      message: "forbidden",
    }),
    {
      state: "blocked",
      attempts: 1,
      nextAttemptAt: 0,
      lastError: "forbidden",
    },
  );
});

test("manual retry releases durably, preserves held operation, and persists its next failure", async () => {
  await deleteDatabase("silicon-interface-outbox");
  installBrowser();
  const owner = "manual-owner";
  const target = new EventTarget();
  window.addEventListener = target.addEventListener.bind(target);
  window.removeEventListener = target.removeEventListener.bind(target);
  window.dispatchEvent = target.dispatchEvent.bind(target);
  let heldWakes = 0;
  window.addEventListener(OUTBOX_RETRY_SCHEDULED_EVENT, () => {
    heldWakes += 1;
  });

  await enqueueOutbox(owner, {
    roomId: "room",
    clientId: "event-client",
    type: "m.text",
    body: "retry me",
    at: 10,
  });
  await updateOutbox(owner, "event-client", {
    state: "blocked",
    attempts: 1,
    nextAttemptAt: 0,
    lastError: "forbidden",
  });

  let postStarted = false;
  const prepared = await prepareManualOutboxRetry(owner, {
    roomId: "room",
    clientId: "event-client",
    type: "m.text",
    body: "retry me",
    at: 10,
  }, 20_000);
  const beforePost = (await listOutbox(owner)).find((row) => row.clientId === "event-client");
  assert.equal(postStarted, false);
  assert.equal(prepared.operation ?? "event", "event");
  assert.equal(beforePost.state, "queued");
  assert.equal(beforePost.nextAttemptAt, 20_000);
  postStarted = true;

  await persistOutboxFailure(
    owner,
    "event-client",
    new ApiError(429, {}, "provider throttled", 90_000),
  );
  const failedAgain = (await listOutbox(owner)).find((row) => row.clientId === "event-client");
  assert.equal(failedAgain.attempts, 2);
  assert.equal(failedAgain.state, "resolving");
  assert.ok(failedAgain.nextAttemptAt >= Date.now() + 89_000);
  assert.equal(failedAgain.failure.code, "rate_limited");
  assert.equal(failedAgain.failure.retryAfterMs, 90_000);
  assert.equal("body" in failedAgain.failure, false);
  assert.equal(JSON.stringify(failedAgain.failure).includes("provider throttled"), false);
  assert.equal(failedAgain.lastError, "Sending is temporarily limited.");
  assert.equal(await settleResolvingOutboxFailure(owner, "event-client"), true);
  const settled = (await listOutbox(owner)).find((row) => row.clientId === "event-client");
  assert.equal(settled.state, "retry_wait");
  assert.equal(settled.failure.code, "rate_limited");

  const releaseAt = "2026-07-12T00:00:00.000Z";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId: "held-client",
    operation: "held",
    type: "m.text",
    body: "keep the hold namespace",
    releaseAt,
    at: 30,
  });
  await updateOutbox(owner, "held-client", {
    state: "blocked",
    attempts: 1,
    lastError: "create response lost",
  });
  const wakesBeforeHeldRetry = heldWakes;
  const held = await prepareManualOutboxRetry(owner, {
    roomId: "room",
    clientId: "held-client",
    body: "fallback must not replace the row",
    at: 30,
  }, 40_000);
  assert.equal(held.operation, "held");
  assert.equal(held.releaseAt, releaseAt);
  assert.equal(
    heldWakes,
    wakesBeforeHeldRetry + 1,
    "held retry wakes the operation-aware central flusher",
  );

  const rebuiltHeld = await prepareManualOutboxRetry(owner, {
    roomId: "room",
    clientId: "held-ui-only",
    operation: "held",
    type: "m.text",
    body: "rebuild from optimistic hold metadata",
    content: { hold_release_at: releaseAt },
    releaseAt,
    at: 50,
  }, 50_000);
  assert.equal(rebuiltHeld.operation, "held");
  assert.equal(rebuiltHeld.releaseAt, releaseAt);
  assert.equal(
    (await listOutbox(owner)).find((row) => row.clientId === "held-ui-only").operation,
    "held",
  );
});

test("an aborted manual-release transaction plus mirror failure never authorizes POST", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "abort-owner";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId: "abort-client",
    body: "remain blocked",
    at: 50,
  });
  await updateOutbox(owner, "abort-client", {
    state: "blocked",
    attempts: 1,
    lastError: "terminal",
  });

  const probe = await openDatabase("silicon-interface-outbox");
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const normalTransaction = proto.transaction;
  let readwriteCalls = 0;
  proto.transaction = function (...args) {
    const transaction = normalTransaction.apply(this, args);
    if (args[1] === "readwrite" && ++readwriteCalls === 2) {
      queueMicrotask(() => {
        try { transaction.abort(); } catch { /* already finished */ }
      });
    }
    return transaction;
  };
  const normalSet = storage.setItem.bind(storage);
  storage.setItem = () => { throw new Error("mirror quota full"); };
  try {
    await assert.rejects(
      prepareManualOutboxRetry(owner, {
        roomId: "room",
        clientId: "abort-client",
        body: "remain blocked",
        at: 50,
      }, 60_000),
      /Unable to release/,
    );
  } finally {
    proto.transaction = normalTransaction;
    storage.setItem = normalSet;
  }
  const stillBlocked = (await listOutbox(owner)).find((row) => row.clientId === "abort-client");
  assert.equal(stillBlocked.state, "blocked");
});

test("server acceptance remains successful when every local ack cleanup write fails", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "ack-failure-owner";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId: "accepted-client",
    body: "already accepted",
    at: 70,
  });

  const probe = await openDatabase("silicon-interface-outbox");
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const normalTransaction = proto.transaction;
  let aborted = false;
  proto.transaction = function (...args) {
    const transaction = normalTransaction.apply(this, args);
    if (!aborted && args[1] === "readwrite") {
      aborted = true;
      queueMicrotask(() => {
        try { transaction.abort(); } catch { /* already finished */ }
      });
    }
    return transaction;
  };
  const normalSet = storage.setItem.bind(storage);
  storage.setItem = () => { throw new Error("ack journal unavailable"); };
  try {
    await assert.doesNotReject(ackOutbox(owner, "accepted-client"));
  } finally {
    proto.transaction = normalTransaction;
    storage.setItem = normalSet;
  }
  assert.equal(
    (await listOutbox(owner)).some((row) => row.clientId === "accepted-client"),
    true,
    "cleanup failure retains idempotent recovery state instead of reporting send failure",
  );
});

test("an aborted primary listing falls back to the durable mirror and reopens later", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "list-abort-owner";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId: "mirror-survivor",
    body: "still visible",
    at: 80,
  });

  const probe = await openDatabase("silicon-interface-outbox");
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const normalTransaction = proto.transaction;
  let aborted = false;
  proto.transaction = function (...args) {
    const transaction = normalTransaction.apply(this, args);
    if (!aborted && args[1] === "readwrite") {
      aborted = true;
      queueMicrotask(() => {
        try { transaction.abort(); } catch { /* already finished */ }
      });
    }
    return transaction;
  };
  let fallback;
  try {
    fallback = await listOutbox(owner);
  } finally {
    proto.transaction = normalTransaction;
  }
  assert.deepEqual(fallback.map((row) => row.clientId), ["mirror-survivor"]);
  assert.deepEqual(
    (await listOutbox(owner)).map((row) => row.clientId),
    ["mirror-survivor"],
    "the cached aborted handle was discarded and reopened",
  );
});
