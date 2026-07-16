import assert from "node:assert/strict";
import test from "node:test";

import {
  draftListPreviewText,
  draftListPreviewVisible,
} from "../../src/lib/draft-list-preview.ts";

test("draft list preview follows Telegram content fallbacks", () => {
  assert.equal(draftListPreviewText("hello\nthere", 0, false), "hello there");
  assert.equal(draftListPreviewText("   ", 1, false), "Attachment");
  assert.equal(draftListPreviewText("", 3, false), "3 attachments");
  assert.equal(draftListPreviewText("", 0, true), "Reply");
  assert.equal(draftListPreviewText("", 0, false), "");
});

test("a newer unread message suppresses a stale draft preview", () => {
  const draft = {
    active: true,
    text: "older draft",
    updatedAt: "2026-07-16T08:00:00.000Z",
    originDevice: "device-a",
  };
  assert.equal(
    draftListPreviewVisible(draft, 1, "2026-07-16T08:00:01.000Z"),
    false,
  );
  assert.equal(
    draftListPreviewVisible(draft, 1, "2026-07-16T07:59:59.000Z"),
    true,
  );
  assert.equal(
    draftListPreviewVisible(draft, 0, "2026-07-16T08:00:01.000Z"),
    true,
  );
});
