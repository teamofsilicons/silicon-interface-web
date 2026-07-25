import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildEmojiPickerEntries } from "../../src/components/chat/expression-picker.tsx";
import { ALL_EMOJI_LIST, searchEmoji } from "../../src/lib/emoji.ts";

const layoutSource = await readFile(
  new URL("../../src/app/layout.tsx", import.meta.url),
  "utf8",
);
const globalCssSource = await readFile(
  new URL("../../src/app/globals.css", import.meta.url),
  "utf8",
);

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

test("current Unicode ZWJ emoji use the bundled color typeface", () => {
  assert.equal(searchEmoji("ballet dancer", 1)[0]?.emoji, "🧑‍🩰");
  assert.match(
    globalCssSource,
    /font-family: var\(--font-sans\), "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"/,
  );
  assert.match(layoutSource, /@fontsource\/noto-color-emoji\/emoji-400\.css/);
  assert.doesNotMatch(layoutSource, /@fontsource\/noto-color-emoji\/400\.css/);
  assert.match(globalCssSource, /\.emoji-glyph \{/);
});
