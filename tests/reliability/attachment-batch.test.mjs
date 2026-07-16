import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMPOSER_ATTACHMENTS,
  planAttachmentBatch,
} from "../../src/lib/attachment-batch.ts";

test("multi-file picker, paste, and drop batches preserve every file in order", () => {
  const files = [
    { name: "first.png" },
    { name: "second.pdf" },
    { name: "third.txt" },
  ];
  const fileListShape = { 0: files[0], 1: files[1], 2: files[2], length: 3 };
  const batch = planAttachmentBatch(fileListShape, 0);
  assert.deepEqual(batch.accepted, files);
  assert.equal(batch.rejected, 0);
});

test("attachment batches share the ten-file composer capacity", () => {
  const files = Array.from({ length: 5 }, (_, index) => ({ name: `${index}.txt` }));
  const batch = planAttachmentBatch(files, 8);
  assert.deepEqual(batch.accepted, files.slice(0, 2));
  assert.equal(batch.rejected, 3);
  assert.equal(MAX_COMPOSER_ATTACHMENTS, 10);
});
