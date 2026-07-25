import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../src/lib/giphy.ts", import.meta.url), "utf8");

test("GIPHY results use the compact animated picker rendition for sending", () => {
  assert.match(
    source,
    /const preview = images\.fixed_width_small \?\? images\.fixed_width;/,
  );
  assert.doesNotMatch(source, /downsized_medium|images\.downsized|images\.original/);
  assert.match(source, /width: Number\(preview\.width \|\| 0\)/);
  assert.match(source, /height: Number\(preview\.height \|\| 0\)/);
});
