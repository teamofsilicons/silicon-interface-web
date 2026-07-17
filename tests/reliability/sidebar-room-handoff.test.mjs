import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatPageSource = await readFile(
  new URL("../../src/app/chat/page.tsx", import.meta.url),
  "utf8",
);

test("accepted socket events always enter the room handoff cache", () => {
  assert.match(chatPageSource, /appendRoomEventSnippet\(rid, ev\);/);
  assert.doesNotMatch(
    chatPageSource,
    /if \(!isOpen\) appendRoomEventSnippet\(rid, ev\);/,
  );
});
