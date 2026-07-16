import assert from "node:assert/strict";
import test from "node:test";

import { emojiShortcodeQuery } from "../../src/lib/emoji-shortcode.ts";

test("emoji shortcode waits for two characters", () => {
  assert.equal(emojiShortcodeQuery(":"), null);
  assert.equal(emojiShortcodeQuery(":s"), null);
  assert.equal(emojiShortcodeQuery(":sm"), "sm");
  assert.equal(emojiShortcodeQuery("hello :joy"), "joy");
});

test("emoji shortcode does not trigger inside words, times, or URLs", () => {
  assert.equal(emojiShortcodeQuery("12:30"), null);
  assert.equal(emojiShortcodeQuery("http://"), null);
  assert.equal(emojiShortcodeQuery("word:sm"), null);
});
