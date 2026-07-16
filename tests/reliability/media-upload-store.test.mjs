import assert from "node:assert/strict";
import test from "node:test";

import { deleteDatabase, installBrowser } from "./helpers.mjs";

test("media source survives reopen until the event outbox owns it", async () => {
  await deleteDatabase("silicon-interface-media-outbox");
  installBrowser();
  const store = await import("../../src/lib/media-upload-store.ts");
  const health = await import("../../src/lib/storage-health.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  store.beginMediaDurability("carbon:alice", "precommit-client");
  assert.equal(drafts.allowDraftNavigation(), false);
  store.endMediaDurability("carbon:alice", "precommit-client");
  assert.equal(drafts.allowDraftNavigation(), true);
  store.beginMediaTransfer("carbon:alice", "uploading-client");
  assert.equal(drafts.allowDraftNavigation(), false);
  store.endMediaTransfer("carbon:alice", "uploading-client");
  assert.equal(drafts.allowDraftNavigation(), true);
  health.reportStorageIssue({ severity: "blocked", area: "media", message: "simulated quota failure" });
  store.markMediaDurabilityFailure("carbon:alice", "failed-client");
  assert.equal(drafts.allowDraftNavigation(), false);
  const blob = new Blob(["durable bytes"], { type: "text/plain" });
  await store.stageMediaUpload({
    ownerId: "carbon:alice",
    roomId: "room-1",
    clientId: "client-1",
    name: "note.txt",
    mime: "text/plain",
    kind: "file",
    size: blob.size,
    blob,
  });
  store.resolveMediaDurabilityFailure("carbon:alice", "client-1");
  assert.notEqual(health.currentStorageIssue(), null);
  assert.equal(drafts.allowDraftNavigation(), false);
  store.resolveMediaDurabilityFailure("carbon:alice", "failed-client");
  assert.equal(health.currentStorageIssue(), null);
  assert.equal(drafts.allowDraftNavigation(), true);

  let rows = await store.listRoomMediaUploads("carbon:alice", "room-1");
  assert.equal(rows.length, 1);
  assert.equal(await rows[0].blob.text(), "durable bytes");

  await store.patchMediaUpload("carbon:alice", "client-1", {
    state: "completed",
    sessionId: "session-1",
    mediaId: "media-1",
    blob: null,
  });
  rows = await store.listRoomMediaUploads("carbon:alice", "room-1");
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].mediaId, "media-1");
  assert.equal(rows[0].blob, null);

  await store.removeMediaUpload("carbon:alice", "client-1");
  assert.deepEqual(await store.listRoomMediaUploads("carbon:alice", "room-1"), []);
});

test("media sources are account scoped and logout cleanup is selective", async () => {
  const store = await import("../../src/lib/media-upload-store.ts");
  const blob = new Blob(["x"]);
  for (const ownerId of ["carbon:alice", "carbon:bob"]) {
    await store.stageMediaUpload({
      ownerId, roomId: "room-2", clientId: `${ownerId}-client`, name: "x.bin",
      mime: "application/octet-stream", kind: "file", size: 1, blob,
    });
  }
  await store.clearMediaUploads("carbon:alice");
  assert.equal((await store.listRoomMediaUploads("carbon:alice", "room-2")).length, 0);
  assert.equal((await store.listRoomMediaUploads("carbon:bob", "room-2")).length, 1);
});
