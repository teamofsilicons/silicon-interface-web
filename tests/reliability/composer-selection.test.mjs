import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_SELECTION_COMMIT_DELAY_MS,
  mayRestoreComposerSnapshot,
} from "../../src/lib/composer-selection.ts";

test("async draft hydration cannot replace a range after user interaction", () => {
  assert.equal(mayRestoreComposerSnapshot(7, 7), true);
  assert.equal(mayRestoreComposerSnapshot(7, 8), false);
  assert.equal(mayRestoreComposerSnapshot(undefined, 99), true);
});

test("intermediate selection movements are checkpointed after a short idle", () => {
  assert.equal(COMPOSER_SELECTION_COMMIT_DELAY_MS, 120);
});
