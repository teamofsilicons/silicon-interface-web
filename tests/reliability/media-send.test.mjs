import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeMediaSend,
  cancelPendingMediaSend,
  ensureMediaOutboxStaged,
  journalRemoteGifIntent,
  prepareMediaOutboxPayload,
  replaceMediaOutboxSource,
  restartMediaUploadGeneration,
  stageMediaSendIntent,
  sweepAcknowledgedMediaCleanup,
} from "../../src/lib/media-send.ts";
import {
  patchMediaUpload,
  readMediaUpload,
  removeMediaUpload,
  stageMediaUpload,
} from "../../src/lib/media-upload-store.ts";
import {
  ackOutbox,
  commitOutboxCorrection,
  listOutbox,
  updateOutbox,
} from "../../src/lib/outbox.ts";
import { ApiError } from "../../src/lib/api.ts";
import { classifySendFailure } from "../../src/lib/send-failure.ts";
import { deleteDatabase, indexedDB, installBrowser, MemoryStorage } from "./helpers.mjs";

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function directEntry(owner, clientId = "media-client") {
  const blob = new Blob(["media bytes"], { type: "image/gif" });
  return {
    blob,
    input: {
      outboxOwnerId: owner,
      mediaOwnerId: `carbon:${owner}`,
      roomId: "room-1",
      clientId,
      blob,
      kind: "image",
      type: "m.image",
      filename: "saved.gif",
      mime: "image/gif",
      optimisticContent: { mime: "image/gif", filename: "saved.gif" },
      eventContent: { width: 10, height: 20 },
      completionMeta: { width: 10, height: 20 },
      replyTo: "reply-1",
      at: 10,
    },
  };
}

test("GIF click journal survives kill before source fetch begins", async () => {
  await deleteDatabase("silicon-interface-media-outbox");
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "gif-acquire-owner";
  let fetches = 0;
  const entry = await journalRemoteGifIntent({
    outboxOwnerId: owner,
    mediaOwnerId: `carbon:${owner}`,
    roomId: "room-1",
    clientId: "gif-acquire-client",
    gifId: "giphy-123",
    sourceUrl: "https://cdn.example/exact.gif",
    title: "Exact GIF",
    filename: "exact-gif.gif",
    width: 320,
    height: 180,
    replyTo: "reply-1",
    at: 20,
  });
  assert.equal(fetches, 0, "journaling performs no external source fetch");
  assert.equal(entry.media.phase, "acquiring");

  // Simulated reload: the per-client mirror and IndexedDB restore the exact
  // provider acquisition identity without a Blob ever having existed.
  installBrowser(storage);
  const restored = (await listOutbox(owner))[0];
  assert.equal(restored.clientId, "gif-acquire-client");
  assert.deepEqual(restored.media.acquisition, {
    provider: "giphy",
    id: "giphy-123",
    url: "https://cdn.example/exact.gif",
    title: "Exact GIF",
    width: 320,
    height: 180,
  });
  assert.equal(await readMediaUpload(`carbon:${owner}`, restored.clientId), null);
});

test("source failure remains an actionable acquiring intent and retry stages exact bytes", async () => {
  installBrowser();
  const owner = "gif-retry-owner";
  const entry = await journalRemoteGifIntent({
    outboxOwnerId: owner,
    mediaOwnerId: `carbon:${owner}`,
    roomId: "room-1",
    clientId: "gif-retry-client",
    gifId: "gif-retry",
    sourceUrl: "https://cdn.example/retry.gif",
    title: "Retry GIF",
    filename: "retry.gif",
    width: 10,
    height: 20,
  });
  let staged = null;
  let fetches = 0;
  const dependencies = {
    read: async () => staged,
    stage: async (row) => {
      staged = {
        ...row,
        key: `${row.ownerId}:${row.clientId}`,
        state: "staged",
        sessionId: null,
        mediaId: null,
        createdAt: 1,
        updatedAt: 1,
      };
      return staged;
    },
    update: async () => true,
    fetchSource: async (url) => {
      fetches += 1;
      assert.equal(url, "https://cdn.example/retry.gif");
      if (fetches === 1) throw new Error("source expired");
      return new Blob(["retried exact bytes"], { type: "image/gif" });
    },
  };
  await assert.rejects(
    ensureMediaOutboxStaged(owner, entry, dependencies),
    /source expired/,
  );
  assert.equal((await listOutbox(owner))[0].media.phase, "acquiring");
  const recovered = await ensureMediaOutboxStaged(owner, entry, dependencies);
  assert.equal(fetches, 2);
  assert.equal(recovered.media.phase, "staged");
  assert.equal(await staged.blob.text(), "retried exact bytes");
});

test("mirror-only GIF acquisition survives an aborted primary outbox commit", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  // Ensure the shared outbox handle exists, then abort only the journal's
  // strict readwrite transaction. Its per-client localStorage intent remains.
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
        try { transaction.abort(); } catch { /* already completed */ }
      });
    }
    return transaction;
  };
  const owner = "gif-mirror-owner";
  try {
    await journalRemoteGifIntent({
      outboxOwnerId: owner,
      mediaOwnerId: `carbon:${owner}`,
      roomId: "room-1",
      clientId: "gif-mirror-client",
      gifId: "mirror-gif",
      sourceUrl: "https://cdn.example/mirror.gif",
      title: "Mirror GIF",
      filename: "mirror.gif",
      width: 40,
      height: 50,
    });
  } finally {
    proto.transaction = normalTransaction;
  }
  assert.equal(aborted, true);
  const mirrorKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  assert.equal(mirrorKeys.some((key) => key?.includes(":v2:intent:") && key.endsWith("gif-mirror-client")), true);
  installBrowser(storage);
  const restored = (await listOutbox(owner))[0];
  assert.equal(restored.media.phase, "acquiring");
  assert.equal(restored.media.acquisition.url, "https://cdn.example/mirror.gif");
});

test("crash between byte commit and outbox handoff resumes from stored bytes without refetch", async () => {
  installBrowser();
  const owner = "gif-handoff-owner";
  const entry = await journalRemoteGifIntent({
    outboxOwnerId: owner,
    mediaOwnerId: `carbon:${owner}`,
    roomId: "room-1",
    clientId: "gif-handoff-client",
    gifId: "gif-handoff",
    sourceUrl: "https://cdn.example/handoff.gif",
    title: "Handoff GIF",
    filename: "handoff.gif",
    width: 12,
    height: 34,
  });
  let stored = null;
  let fetches = 0;
  let updateAttempts = 0;
  const dependencies = {
    read: async () => stored,
    stage: async (row) => {
      stored = {
        ...row,
        key: `${row.ownerId}:${row.clientId}`,
        state: "staged",
        sessionId: null,
        mediaId: null,
        createdAt: 1,
        updatedAt: 1,
      };
      return stored;
    },
    update: async () => ++updateAttempts > 1,
    fetchSource: async () => {
      fetches += 1;
      return new Blob(["committed before crash"], { type: "image/gif" });
    },
  };
  await assert.rejects(
    ensureMediaOutboxStaged(owner, entry, dependencies),
    /handoff is waiting/,
  );
  assert.equal(fetches, 1);
  assert.ok(stored, "strict byte stage survived the failed outbox revision");

  // Reload still has the acquiring mirror row, but also finds stored bytes.
  // It completes phase two without touching the external provider again.
  const recovered = await ensureMediaOutboxStaged(owner, entry, dependencies);
  assert.equal(fetches, 1);
  assert.equal(updateAttempts, 2);
  assert.equal(recovered.media.phase, "staged");
  assert.equal(recovered.media.size, stored.size);
});

test("media staging precedes outbox intent and an outbox failure retains bytes without optimism", async () => {
  installBrowser();
  const { input } = directEntry("stage-order-owner", "stage-order-client");
  const order = [];
  let retained = null;
  await assert.rejects(
    stageMediaSendIntent(input, {
      read: async () => null,
      stage: async (row) => {
        order.push("bytes");
        retained = row.blob;
        return { ...row, key: "key", state: "staged", sessionId: null, mediaId: null, createdAt: 1, updatedAt: 1 };
      },
      enqueue: async () => {
        order.push("intent");
        throw new Error("outbox quota full");
      },
    }),
    /outbox quota full/,
  );
  assert.deepEqual(order, ["bytes", "intent"]);
  assert.equal(await retained.text(), "media bytes");
});

test("prepared media is deterministic and cleanup waits for a durable ack", async () => {
  installBrowser();
  const owner = "media-cleanup-owner";
  const { input } = directEntry(owner, "media-cleanup-client");
  const entry = await stageMediaSendIntent(input);
  const payload = await prepareMediaOutboxPayload(owner, entry, {
    ensure: async () => entry,
    read: readMediaUpload,
    upload: async (options) => {
      assert.equal(options.retainSourceUntilEventAck, true);
      return "media-authoritative";
    },
    transcribe: async () => { throw new Error("image must not transcribe"); },
  });
  assert.deepEqual(payload, {
    type: "m.image",
    content: {
      width: 10,
      height: 20,
      media_id: "media-authoritative",
      mime: "image/gif",
      filename: "saved.gif",
    },
    reply_to_event_id: "reply-1",
  });

  const reports = [];
  const acknowledged = await acknowledgeMediaSend(owner, entry, {
    markCleanup: patchMediaUpload,
    acknowledge: ackOutbox,
    remove: async () => { throw new Error("simulated cleanup failure"); },
    report: (issue) => reports.push(issue),
  });
  assert.equal(acknowledged, true);
  assert.equal((await readMediaUpload(`carbon:${owner}`, entry.clientId)).state, "cleanup");
  assert.deepEqual(await listOutbox(owner), [], "accepted event cannot replay");
  assert.equal(reports.length, 1);

  assert.equal(await sweepAcknowledgedMediaCleanup(owner), 1);
  assert.equal(await readMediaUpload(`carbon:${owner}`, entry.clientId), null);
});

test("an already uploaded document can become a durable media send without restaging bytes", async () => {
  await deleteDatabase("silicon-interface-media-outbox");
  installBrowser();
  const owner = "uploaded-document-owner";
  const clientId = "uploaded-document-client";
  const blob = new Blob(["document bytes"], { type: "application/pdf" });
  await stageMediaUpload({
    ownerId: `carbon:${owner}`,
    roomId: "document-room",
    clientId,
    outboxClientId: clientId,
    name: "document.pdf",
    mime: "application/pdf",
    kind: "file",
    size: blob.size,
    blob,
  });
  await patchMediaUpload(`carbon:${owner}`, clientId, {
    state: "completed",
    mediaId: "01J00000000000000000000000",
  });

  const entry = await stageMediaSendIntent({
    outboxOwnerId: owner,
    mediaOwnerId: `carbon:${owner}`,
    roomId: "document-room",
    clientId,
    kind: "file",
    type: "m.file",
    filename: "document.pdf",
    mime: "application/pdf",
    optimisticContent: { filename: "document.pdf", mime: "application/pdf" },
  });
  assert.equal(entry.operation, "media");
  assert.equal(entry.media.size, blob.size);
  assert.equal(await (await readMediaUpload(`carbon:${owner}`, clientId)).blob.text(), "document bytes");

  assert.equal(await cancelPendingMediaSend(owner, entry), true);
  assert.deepEqual(await listOutbox(owner), []);
  assert.equal(await readMediaUpload(`carbon:${owner}`, clientId), null);
});

test("a legacy failed voice retry never waits for transcription", async () => {
  await deleteDatabase("silicon-interface-media-outbox");
  installBrowser();
  const owner = "legacy-voice-retry-owner";
  const blob = new Blob(["encoded voice"], { type: "audio/webm" });
  const entry = await stageMediaSendIntent({
    outboxOwnerId: owner,
    mediaOwnerId: `carbon:${owner}`,
    roomId: "voice-room",
    clientId: "legacy-voice-client",
    blob,
    kind: "voice",
    type: "m.voice",
    filename: "voice.webm",
    mime: "audio/webm",
    optimisticContent: { duration_ms: 1_000 },
    eventContent: { duration_ms: 1_000 },
    completionMeta: { duration_ms: 1_000 },
    transcribe: true,
  });
  let transcriptionCalls = 0;
  const payload = await prepareMediaOutboxPayload(owner, entry, {
    ensure: async () => entry,
    read: readMediaUpload,
    upload: async () => "voice-media-id",
    transcribe: async () => {
      transcriptionCalls += 1;
      throw new Error("retired STT gate must not run");
    },
  });

  assert.equal(transcriptionCalls, 0);
  assert.deepEqual(payload, {
    type: "m.voice",
    content: {
      duration_ms: 1_000,
      media_id: "voice-media-id",
      mime: "audio/webm",
      filename: "voice.webm",
    },
  });
});

test("cleanup marker failure retains the idempotent outbox and all source bytes", async () => {
  installBrowser();
  const owner = "media-marker-failure-owner";
  const { input } = directEntry(owner, "media-marker-failure-client");
  const entry = await stageMediaSendIntent(input);
  let ackCalls = 0;
  let removeCalls = 0;
  const result = await acknowledgeMediaSend(owner, entry, {
    markCleanup: async () => { throw new Error("media DB aborted"); },
    acknowledge: async () => { ackCalls += 1; return true; },
    remove: async () => { removeCalls += 1; },
    report: () => undefined,
  });
  assert.equal(result, false);
  assert.equal(ackCalls, 0, "never tombstone before cleanup recovery is journaled");
  assert.equal(removeCalls, 0);
  assert.equal((await listOutbox(owner))[0].clientId, entry.clientId);
  assert.equal(
    await (await readMediaUpload(`carbon:${owner}`, entry.clientId)).blob.text(),
    "media bytes",
  );
});

test("attachment replacement is copy-on-write and preserves caption/reply across commit failure", async () => {
  installBrowser();
  const owner = "media-replace-owner";
  const direct = directEntry(owner, "media-replace-client");
  direct.input.optimisticContent = {
    mime: "image/gif",
    filename: "saved.gif",
    caption: "keep this caption",
    custom_context: "keep this too",
  };
  direct.input.eventContent = {
    width: 10,
    height: 20,
    caption: "keep this caption",
    custom_context: "keep this too",
  };
  await stageMediaSendIntent(direct.input);
  const failure = classifySendFailure(
    new ApiError(422, {
      failure: {
        domain: "chat.operation",
        code: "media_mismatch",
        retryable: false,
        automatic: false,
        correction_actions: ["replace_attachment", "discard_local"],
      },
    }, "unsafe provider detail"),
    { attempt: 1, now: 100, jitter: 1 },
  ).failure;
  await updateOutbox(owner, direct.input.clientId, {
    state: "blocked",
    failure,
    lastError: "local safe copy",
  });
  const original = (await listOutbox(owner))[0];
  const originalSource = original.media.sourceClientId ?? original.clientId;
  const replacementBlob = new Blob(["replacement bytes"], { type: "image/png" });
  let removeCalls = 0;
  await assert.rejects(
    replaceMediaOutboxSource(
      owner,
      original,
      {
        blob: replacementBlob,
        filename: "replacement.png",
        mime: "image/png",
        kind: "image",
      },
      {
        stage: stageMediaUpload,
        commit: async () => { throw new Error("simulated outbox commit failure"); },
        markSuperseded: patchMediaUpload,
        remove: async () => { removeCalls += 1; },
        sourceId: () => "crash-before-commit",
      },
    ),
    /commit failure/,
  );
  assert.equal(removeCalls, 0, "the old generation is never removed before commit");
  assert.equal(
    await (await readMediaUpload(original.media.ownerId, originalSource)).blob.text(),
    "media bytes",
  );
  assert.equal(
    await (await readMediaUpload(
      original.media.ownerId,
      `${original.clientId}:source:crash-before-commit`,
    )).blob.text(),
    "replacement bytes",
    "a crash after staging leaves a harmless unreferenced generation",
  );
  assert.equal((await listOutbox(owner))[0].media.sourceClientId, originalSource);

  const committed = await replaceMediaOutboxSource(
    owner,
    original,
    {
      blob: replacementBlob,
      filename: "replacement.png",
      mime: "image/png",
      kind: "image",
    },
    {
      stage: stageMediaUpload,
      commit: commitOutboxCorrection,
      markSuperseded: patchMediaUpload,
      remove: removeMediaUpload,
      sourceId: () => "committed-generation",
    },
  );
  assert.equal(committed.replyTo, "reply-1");
  assert.equal(committed.body, original.body);
  assert.equal(committed.content.caption, "keep this caption");
  assert.equal(committed.content.custom_context, "keep this too");
  assert.equal(committed.media.eventContent.caption, "keep this caption");
  assert.equal(committed.media.eventContent.custom_context, "keep this too");
  assert.equal(
    committed.media.sourceClientId,
    `${original.clientId}:source:committed-generation`,
  );
  assert.equal(
    committed.media.uploadClientId,
    `${original.clientId}:source:committed-generation`,
    "replacement gets a fresh multipart idempotency identity",
  );
  await prepareMediaOutboxPayload(owner, committed, {
    ensure: async () => committed,
    read: readMediaUpload,
    upload: async (options) => {
      assert.equal(options.clientId, committed.media.uploadClientId);
      assert.equal(options.outboxClientId, committed.clientId);
      assert.notEqual(options.clientId, committed.clientId);
      return "replacement-media-id";
    },
    transcribe: async () => { throw new Error("image must not transcribe"); },
  });
  assert.equal(await readMediaUpload(original.media.ownerId, originalSource), null);
});

test("media caption edit keeps the exact source and every non-caption identity field", async () => {
  installBrowser();
  const owner = "media-caption-edit-owner";
  const direct = directEntry(owner, "media-caption-edit-client");
  direct.input.optimisticContent = {
    mime: "image/gif",
    filename: "saved.gif",
    caption: "old caption",
    custom_context: "unchanged",
  };
  direct.input.eventContent = {
    width: 10,
    height: 20,
    caption: "old caption",
    custom_context: "unchanged",
  };
  await stageMediaSendIntent(direct.input);
  const failure = classifySendFailure(
    new ApiError(413, {
      failure: {
        domain: "chat.operation",
        code: "payload_too_large",
        retryable: false,
        automatic: false,
        correction_actions: ["edit_message", "replace_attachment", "discard_local"],
      },
    }, "unsafe provider detail"),
    { attempt: 1, now: 100, jitter: 1 },
  ).failure;
  await updateOutbox(owner, direct.input.clientId, { state: "blocked", failure });
  const before = (await listOutbox(owner))[0];
  const after = await commitOutboxCorrection(
    owner,
    before.clientId,
    "edit_message",
    {
      body: "new caption",
      content: { ...before.content, caption: "new caption" },
      media: {
        ...before.media,
        eventContent: { ...before.media.eventContent, caption: "new caption" },
      },
      state: "queued",
      nextAttemptAt: 200,
      failure: undefined,
      lastError: undefined,
    },
  );
  assert.equal(after.content.caption, "new caption");
  assert.equal(after.media.eventContent.caption, "new caption");
  assert.equal(after.media.sourceClientId, before.media.sourceClientId);
  assert.equal(after.replyTo, before.replyTo);
  assert.equal(after.media.filename, before.media.filename);
  assert.equal(after.media.mime, before.media.mime);
  assert.equal(after.content.custom_context, "unchanged");
});

test("upload identity conflict restarts the same bytes under a fresh multipart generation", async () => {
  installBrowser();
  const owner = "media-upload-identity-owner";
  const direct = directEntry(owner, "media-upload-identity-client");
  await stageMediaSendIntent(direct.input);
  await patchMediaUpload(direct.input.mediaOwnerId, direct.input.clientId, {
    state: "uploading",
    sessionId: "conflicting-session",
  });
  const failure = classifySendFailure(
    new ApiError(409, {
      failure: {
        domain: "chat.operation",
        code: "upload_identity_conflict",
        retryable: false,
        automatic: false,
        correction_actions: ["restart_upload", "replace_attachment", "discard_local"],
      },
    }, "unsafe provider detail"),
    { attempt: 1, now: 100, jitter: 1 },
  ).failure;
  await updateOutbox(owner, direct.input.clientId, { state: "blocked", failure });
  const before = (await listOutbox(owner))[0];
  const after = await restartMediaUploadGeneration(owner, before, {
    reset: patchMediaUpload,
    commit: commitOutboxCorrection,
    uploadId: () => "fresh-upload-generation",
  });
  assert.equal(after.clientId, before.clientId, "logical event identity stays fixed");
  assert.equal(after.localKey, before.localKey, "timeline identity stays fixed");
  assert.equal(after.media.sourceClientId, before.media.sourceClientId, "same bytes stay retained");
  assert.equal(
    after.media.uploadClientId,
    `${before.clientId}:upload:fresh-upload-generation`,
  );
  const source = await readMediaUpload(
    after.media.ownerId,
    after.media.sourceClientId ?? after.clientId,
  );
  assert.equal(source.state, "staged");
  assert.equal(source.sessionId, null);
  assert.equal(await source.blob.text(), "media bytes");
});
