import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../src/lib/api.ts";
import { classifySendFailure } from "../../src/lib/send-failure.ts";
import {
  cancelPendingOutbox,
  commitOutboxCorrection,
  discardOutbox,
  enqueueOutbox,
  isOutboxAcknowledged,
  listOutbox,
  outboxTerminalState,
  updateOutbox,
} from "../../src/lib/outbox.ts";
import { prepareManualOutboxRetry } from "../../src/lib/outbox-recovery.ts";
import { deleteDatabase, installBrowser } from "./helpers.mjs";

function failure(code, retryable, automatic, correctionActions, status = 422) {
  return classifySendFailure(
    new ApiError(status, {
      failure: {
        domain: "chat.operation",
        code,
        retryable,
        automatic,
        correction_actions: correctionActions,
      },
    }, "raw detail must not persist"),
    { attempt: 1, now: 100, jitter: 1 },
  ).failure;
}

test("remove-reply correction commits the same identity and repairs a stale mirror", async () => {
  await deleteDatabase("silicon-interface-outbox");
  const storage = installBrowser();
  const owner = "remove-reply-owner";
  const clientId = "remove-reply-client";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId,
    type: "m.text",
    body: "body stays exact",
    content: { body: "body stays exact", custom: "keep" },
    replyTo: "deleted-event",
    at: 10,
  });
  await updateOutbox(owner, clientId, {
    state: "blocked",
    failure: failure(
      "invalid_reply",
      false,
      false,
      ["remove_reply", "edit_message", "discard_local"],
    ),
  });
  const before = (await listOutbox(owner))[0];
  const mirrorKey = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .find((key) => key?.includes(":v2:intent:") && key.endsWith(clientId));
  const staleMirror = storage.getItem(mirrorKey);

  const corrected = await commitOutboxCorrection(owner, clientId, "remove_reply", {
    replyTo: undefined,
    state: "queued",
    nextAttemptAt: 200,
    failure: undefined,
    lastError: undefined,
  });
  assert.equal(corrected.clientId, before.clientId);
  assert.equal(corrected.localKey, before.localKey);
  assert.equal(corrected.body, "body stays exact");
  assert.equal(corrected.content.custom, "keep");
  assert.equal(corrected.replyTo, undefined);
  assert.equal(corrected.correction.action, "remove_reply");

  storage.setItem(mirrorKey, staleMirror);
  const [recovered] = await listOutbox(owner);
  assert.equal(recovered.replyTo, undefined);
  assert.equal(recovered.body, "body stays exact");
  await assert.rejects(
    commitOutboxCorrection(owner, clientId, "remove_reply", {
      replyTo: undefined,
      body: "unauthorized mutation",
    }),
    /not valid|safe scope/,
  );
});

test("copy handoff retains the blocked source and local discard writes a distinct body-free tombstone", async () => {
  installBrowser();
  const owner = "copy-discard-owner";
  const clientId = "copy-discard-client";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId,
    body: "private body must not enter the tombstone",
    at: 20,
  });
  await updateOutbox(owner, clientId, {
    state: "blocked",
    failure: failure(
      "invalid_client_id",
      false,
      false,
      ["copy_to_composer", "discard_local"],
    ),
  });
  const copied = await commitOutboxCorrection(owner, clientId, "copy_to_composer");
  assert.equal(copied.state, "blocked");
  assert.equal(copied.body, "private body must not enter the tombstone");
  assert.equal((await listOutbox(owner)).length, 1, "copy does not silently delete its source");

  assert.equal(await discardOutbox(owner, clientId), true);
  assert.deepEqual(await listOutbox(owner), []);
  assert.equal(await outboxTerminalState(owner, clientId), "discarded");
  assert.equal(await isOutboxAcknowledged(owner, clientId), false);
  const tombstone = Array.from(
    { length: window.localStorage.length },
    (_, index) => window.localStorage.key(index),
  )
    .filter((key) => key?.includes(":v2:ack:"))
    .map((key) => window.localStorage.getItem(key))
    .find((value) => value?.includes('"terminal":"discarded"'));
  assert.ok(tombstone);
  assert.equal(tombstone.includes("private body"), false);
});

test("a queued send can be cancelled before it becomes a blocked correction", async () => {
  await deleteDatabase("silicon-interface-outbox");
  installBrowser();
  const owner = "queued-cancel-owner";
  const clientId = "queued-cancel-client";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId,
    type: "m.text",
    body: "do not send",
    content: { body: "do not send" },
    at: 25,
  });

  assert.equal(await cancelPendingOutbox(owner, clientId), true);
  assert.deepEqual(await listOutbox(owner), []);
  assert.equal(await outboxTerminalState(owner, clientId), "discarded");
  assert.equal(await isOutboxAcknowledged(owner, clientId), false);
});

test("manual retry before an automatic deadline performs no durable mutation", async () => {
  installBrowser();
  const owner = "deadline-owner";
  const clientId = "deadline-client";
  await enqueueOutbox(owner, {
    roomId: "room",
    clientId,
    body: "wait for the deadline",
    at: 30,
  });
  const automatic = failure("rate_limited", true, true, [], 429);
  const deadline = 50_000;
  await updateOutbox(owner, clientId, {
    state: "retry_wait",
    attempts: 1,
    nextAttemptAt: deadline,
    failure: { ...automatic, nextAttemptAt: deadline },
  });
  const before = (await listOutbox(owner))[0];
  await assert.rejects(
    prepareManualOutboxRetry(owner, before, 49_999),
    /not eligible/,
  );
  const after = (await listOutbox(owner))[0];
  assert.equal(after.state, "retry_wait");
  assert.equal(after.nextAttemptAt, deadline);
  assert.equal(after.updatedAt, before.updatedAt);
});
