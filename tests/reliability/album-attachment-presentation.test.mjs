import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageBubble } from "../../src/components/chat/message-bubble.tsx";

function albumEvent(caption) {
  return {
    event_id: "album-1",
    type: "m.album",
    content: {
      caption,
      items: [
        { media_id: "media-a", filename: "first.png" },
        { media_id: "media-b", filename: "notes.zip" },
      ],
    },
    media_items: [
      {
        position: 0,
        media_id: "media-a",
        filename: "first.png",
        mime: "image/png",
        kind: "image",
      },
      {
        position: 1,
        media_id: "media-b",
        filename: "notes.zip",
        mime: "application/zip",
        kind: "file",
      },
    ],
    sender_kind: "carbon",
    sender_handle: "sender",
    sender_public_id: "sender",
    created_at: "2026-08-03T10:00:00.000Z",
    redacted_at: null,
    is_final: true,
  };
}

function renderAlbum(caption, isMine = true) {
  return renderToStaticMarkup(
    React.createElement(MessageBubble, {
      event: albumEvent(caption),
      isMine,
      showTime: false,
    }),
  );
}

test("captioned albums render compact attachment pins above the message bubble", () => {
  const html = renderAlbum("testing");
  const pinsAt = html.indexOf('data-attachment-pins="true"');
  const bubbleAt = html.indexOf('data-message-bubble="true"');

  assert.ok(pinsAt >= 0);
  assert.ok(pinsAt < bubbleAt);
  assert.equal(html.match(/w-36 max-w-full/g)?.length, 2);
  assert.equal(html.match(/data-attachment-footer-tone="sent"/g)?.length, 2);
  assert.equal(html.match(/bg-primary text-primary-foreground/g)?.length, 3);
  assert.doesNotMatch(html, /grid max-w-\[36rem\] grid-cols-2/);
  assert.match(html, />testing</);
});

test("incoming attachment pin footers match the received message bubble", () => {
  const html = renderAlbum("testing", false);

  assert.equal(html.match(/data-attachment-footer-tone="received"/g)?.length, 2);
  assert.equal(html.match(/bg-bubble-received text-foreground/g)?.length, 2);
  assert.match(html, /bg-bubble-received/);
});

test("captionless albums retain the inline gallery presentation", () => {
  const html = renderAlbum("");

  assert.doesNotMatch(html, /data-attachment-pins="true"/);
  assert.match(html, /grid max-w-\[36rem\] grid-cols-2/);
});
