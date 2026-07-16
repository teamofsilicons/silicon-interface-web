import assert from "node:assert/strict";
import test from "node:test";

import {
  albumContentMediaIds,
  albumMediaIdsOwnedByOutbox,
  albumMediaItems,
  buildAlbumContent,
} from "../../src/lib/albums.ts";
import { enqueueOutbox, listOutbox } from "../../src/lib/outbox.ts";
import { deleteDatabase, installBrowser } from "./helpers.mjs";

test("album builder keeps one caption and the exact attachment order", () => {
  const content = buildAlbumContent([
    { mediaId: "media-a", filename: "first.png" },
    { mediaId: "media-b", filename: "notes.pdf" },
    { mediaId: "media-c", filename: "last.jpg" },
  ], "one caption");

  assert.deepEqual(content, {
    caption: "one caption",
    caption_item_index: 0,
    items: [
      { media_id: "media-a", filename: "first.png" },
      { media_id: "media-b", filename: "notes.pdf" },
      { media_id: "media-c", filename: "last.jpg" },
    ],
  });
  assert.throws(
    () => buildAlbumContent([
      { mediaId: "same", filename: "one" },
      { mediaId: "same", filename: "two" },
    ], ""),
    /ready and unique/,
  );
  const normalized = buildAlbumContent([
    { mediaId: "media-a", filename: "\u0000  first.png  " },
    { mediaId: "media-b", filename: "x".repeat(300) },
  ], "caption");
  assert.equal(normalized.items[0].filename, "first.png");
  assert.equal([...normalized.items[1].filename].length, 255);
  assert.throws(
    () => buildAlbumContent([
      { mediaId: "media-a", filename: "first.png" },
      { mediaId: "media-b", filename: "second.png" },
    ], "x".repeat(4_001)),
    /at most 4000/,
  );
});

test("one album outbox row survives reload and rejects reordered identity reuse", async () => {
  await deleteDatabase("silicon-interface-outbox");
  installBrowser();
  const owner = "album-owner";
  const content = buildAlbumContent([
    { mediaId: "media-a", filename: "first.png" },
    { mediaId: "media-b", filename: "second.png" },
  ], "atomic");
  const row = {
    roomId: "room-1",
    clientId: "album-client",
    type: "m.album",
    body: "",
    content,
    replyTo: "reply-1",
    at: 100,
  };

  await enqueueOutbox(owner, row);
  const restored = await listOutbox(owner);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].type, "m.album");
  assert.deepEqual(restored[0].content, content);
  assert.equal(restored[0].replyTo, "reply-1");

  const reordered = buildAlbumContent([
    { mediaId: "media-b", filename: "second.png" },
    { mediaId: "media-a", filename: "first.png" },
  ], "atomic");
  await assert.rejects(
    enqueueOutbox(owner, { ...row, content: reordered }),
    /changed immutable payload/,
  );
});

test("album renderer prefers authoritative ordered metadata", () => {
  const event = {
    content: {
      items: [
        { media_id: "media-a", filename: "draft-a.png" },
        { media_id: "media-b", filename: "draft-b.pdf" },
      ],
    },
    media_items: [
      { position: 1, media_id: "media-b", filename: "b.pdf", kind: "file", mime: "application/pdf", size: 20, width: null, height: null, duration_ms: null },
      { position: 0, media_id: "media-a", filename: "a.png", kind: "image", mime: "image/png", size: 10, width: 640, height: 480, duration_ms: null },
    ],
  };
  assert.deepEqual(albumMediaItems(event).map((item) => item.media_id), ["media-a", "media-b"]);
});

test("restart recovery gives queued album media exclusively to its outbox", () => {
  const entries = [{
    roomId: "room-1",
    clientId: "album-client",
    type: "m.album",
    content: buildAlbumContent([
      { mediaId: "media-a", filename: "first.png" },
      { mediaId: "media-b", filename: "second.png" },
    ], "atomic"),
  }, {
    roomId: "room-2",
    clientId: "other-album",
    type: "m.album",
    content: buildAlbumContent([
      { mediaId: "media-c", filename: "third.png" },
      { mediaId: "media-d", filename: "fourth.png" },
    ], "other room"),
  }];

  assert.deepEqual(
    [...albumMediaIdsOwnedByOutbox(entries, "room-1")],
    ["media-a", "media-b"],
  );
  assert.deepEqual(
    albumContentMediaIds({
      items: [
        { media_id: " exact " },
        { media_id: "media-a" },
        { media_id: "media-a" },
        null,
      ],
    }),
    ["media-a"],
  );
});
