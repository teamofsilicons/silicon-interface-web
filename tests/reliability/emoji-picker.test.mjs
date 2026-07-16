import assert from "node:assert/strict";
import test from "node:test";

import { buildEmojiPickerEntries } from "../../src/components/chat/expression-picker.tsx";
import { ALL_EMOJI_LIST } from "../../src/lib/emoji.ts";

test("emoji picker browses the complete emoji catalog with recents first", () => {
  const recent = [ALL_EMOJI_LIST.at(-1).emoji, ALL_EMOJI_LIST[100].emoji];
  const entries = buildEmojiPickerEntries([...recent, recent[0], "not-an-emoji"]);

  assert.equal(entries.length, ALL_EMOJI_LIST.length);
  assert.deepEqual(entries.slice(0, recent.length).map((entry) => entry.emoji), recent);
  assert.deepEqual(
    new Set(entries.map((entry) => entry.emoji)),
    new Set(ALL_EMOJI_LIST.map((entry) => entry.emoji)),
  );
});
