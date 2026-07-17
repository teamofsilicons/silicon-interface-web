import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COMPOSER_SELECTION_COMMIT_DELAY_MS,
  mayPersistComposerSelection,
  mayRestoreComposerSnapshot,
} from "../../src/lib/composer-selection.ts";

const composerSource = await readFile(
  new URL("../../src/components/chat/composer.tsx", import.meta.url),
  "utf8",
);

test("async draft hydration cannot replace a range after user interaction", () => {
  assert.equal(mayRestoreComposerSnapshot(7, 7), true);
  assert.equal(mayRestoreComposerSnapshot(7, 8), false);
  assert.equal(mayRestoreComposerSnapshot(undefined, 99), true);
});

test("intermediate selection movements are checkpointed after a short idle", () => {
  assert.equal(COMPOSER_SELECTION_COMMIT_DELAY_MS, 120);
});

test("autoFocus cannot overwrite selection during a draft snapshot restore", () => {
  assert.equal(mayPersistComposerSelection(false, true), false);
  assert.equal(mayPersistComposerSelection(false, false), true);
  assert.equal(mayPersistComposerSelection(true, false), false);
});

test("long drafts keep the end caret visible and notify the timeline of composer growth", () => {
  assert.match(composerSource, /caretAtEnd \? el\.scrollHeight : previousScrollTop/);
  assert.match(composerSource, /onLayoutChange\?\.\(\)/);
});
