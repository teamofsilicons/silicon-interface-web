import assert from "node:assert/strict";
import test from "node:test";

import { isGifMedia } from "../../src/lib/media-meta.ts";

test("GIF identity prefers MIME and supports legacy filenames", () => {
  assert.equal(isGifMedia("image/gif", "photo.bin"), true);
  assert.equal(isGifMedia("image/gif; charset=binary"), true);
  assert.equal(isGifMedia("", "animation.GIF"), true);
  assert.equal(isGifMedia("image/png", "photo.png"), false);
});
