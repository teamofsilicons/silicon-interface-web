import assert from "node:assert/strict";
import test from "node:test";

import { emojiOnly } from "../../src/lib/emoji.ts";

test("emoji-only messages include multiple grapheme clusters", () => {
  assert.deepEqual(emojiOnly("😀 🎉"), { ok: true, count: 2 });
  assert.deepEqual(emojiOnly("👨‍👩‍👧 🇮🇳 1️⃣"), { ok: true, count: 3 });
});

test("emoji mixed with text keeps the normal message treatment", () => {
  assert.deepEqual(emojiOnly("great 😀"), { ok: false, count: 0 });
  assert.deepEqual(emojiOnly("123"), { ok: false, count: 0 });
});
