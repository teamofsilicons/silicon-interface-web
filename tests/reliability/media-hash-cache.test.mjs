import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cachedMediaForHash,
  clearCachedMediaHashes,
  hashMediaBlob,
  MAX_CACHED_MEDIA_HASHES,
  rememberCachedMedia,
} from "../../src/lib/media-hash-cache.ts";
import { MemoryStorage } from "./helpers.mjs";

const composerSource = await readFile(
  new URL("../../src/components/chat/composer.tsx", import.meta.url),
  "utf8",
);
const uploadSource = await readFile(
  new URL("../../src/lib/media-upload.ts", import.meta.url),
  "utf8",
);

function install(storage = new MemoryStorage()) {
  globalThis.window = {
    localStorage: storage,
    crypto: globalThis.crypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    addEventListener() {},
  };
  return storage;
}

test("media digests are stable SHA-256 identities", async () => {
  install();
  const first = await hashMediaBlob(new Blob(["same bytes"]));
  const second = await hashMediaBlob(new Blob(["same bytes"]));
  const changed = await hashMediaBlob(new Blob(["different bytes"]));
  assert.deepEqual(first, second);
  assert.notEqual(first.hex, changed.hex);
  assert.match(first.hex, /^[0-9a-f]{64}$/);
});

test("media reuse is owner, room, MIME, kind, and size scoped", async () => {
  install();
  const digest = await hashMediaBlob(new Blob(["document"]));
  rememberCachedMedia({
    ownerId: "owner-a", roomId: "room-a", digest, mediaId: "media-a",
    size: 8, mime: "application/pdf", kind: "file", at: 1,
  });
  const lookup = {
    ownerId: "owner-a", roomId: "room-a", digest,
    size: 8, mime: "application/pdf", kind: "file",
  };
  assert.equal(cachedMediaForHash(lookup)?.mediaId, "media-a");
  assert.equal(cachedMediaForHash({ ...lookup, ownerId: "owner-b" }), null);
  assert.equal(cachedMediaForHash({ ...lookup, roomId: "room-b" }), null);
  assert.equal(cachedMediaForHash({ ...lookup, mime: "image/png" }), null);
  assert.equal(cachedMediaForHash({ ...lookup, size: 9 }), null);
});

test("only the 100 most recent uploaded file hashes are retained", () => {
  install();
  for (let index = 0; index < MAX_CACHED_MEDIA_HASHES + 5; index += 1) {
    const hex = index.toString(16).padStart(64, "0");
    rememberCachedMedia({
      ownerId: "bounded-owner",
      roomId: "room",
      digest: { hex, base64: "unused" },
      mediaId: `media-${index}`,
      size: index,
      mime: "application/octet-stream",
      kind: "file",
      at: index + 1,
    });
  }
  const oldest = { hex: "0".repeat(64), base64: "unused" };
  const newest = {
    hex: (MAX_CACHED_MEDIA_HASHES + 4).toString(16).padStart(64, "0"),
    base64: "unused",
  };
  const base = {
    ownerId: "bounded-owner",
    roomId: "room",
    mime: "application/octet-stream",
    kind: "file",
  };
  assert.equal(cachedMediaForHash({ ...base, digest: oldest, size: 0 }), null);
  assert.equal(
    cachedMediaForHash({
      ...base,
      digest: newest,
      size: MAX_CACHED_MEDIA_HASHES + 4,
    })?.mediaId,
    `media-${MAX_CACHED_MEDIA_HASHES + 4}`,
  );
  clearCachedMediaHashes("bounded-owner");
  assert.equal(cachedMediaForHash({
    ...base,
    digest: newest,
    size: MAX_CACHED_MEDIA_HASHES + 4,
  }), null);
});

test("attachment upload checks reuse before multipart and posts completed media directly", () => {
  const uploadOneStart = composerSource.indexOf("const uploadOne");
  const uploadOneEnd = composerSource.indexOf("const removeAttachment", uploadOneStart);
  assert.ok(uploadOneStart >= 0 && uploadOneEnd > uploadOneStart);
  const uploadOne = composerSource.slice(uploadOneStart, uploadOneEnd);
  const hash = uploadOne.indexOf("hashMediaBlob(file)");
  const lookup = uploadOne.indexOf("cachedMediaForHash", hash);
  const reuse = uploadOne.indexOf("stageReusedMediaUpload", lookup);
  const multipart = uploadOne.indexOf("uploadMediaResumable", reuse);
  assert.ok(hash >= 0 && lookup > hash && reuse > lookup && multipart > reuse);
  assert.match(uploadOne, /wholeSha256: digest/);

  assert.match(uploadSource, /const whole = opts\.wholeSha256 \?\? await sha256\(source\)/);
  assert.match(uploadSource, /session\.part_count === 1 && number === 1[\s\S]*whole\.base64/);

  const sendStart = composerSource.indexOf("const sendUploadedAttachmentImmediately");
  const sendEnd = composerSource.indexOf("const processDurableGif", sendStart);
  const send = composerSource.slice(sendStart, sendEnd);
  assert.match(send, /preparedUploadedMediaPayload/);
  assert.doesNotMatch(send, /prepareMediaOutboxPayload|uploadMediaResumable/);
  assert.match(send, /api\.sendEvent/);
});
