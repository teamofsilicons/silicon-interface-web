import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOM_SCROLL_MEMORY_TTL_MS,
  clearRoomScrollMemories,
  readRoomScrollMemory,
  rememberRoomScroll,
} from "../../src/lib/room-scroll-memory.ts";

const snapshot = {
  anchorEventId: "event-42",
  anchorOffset: -18,
  scrollTop: 420,
  atBottom: false,
  events: [],
};

test("chat scroll memory restores during the first hour", () => {
  clearRoomScrollMemories();
  rememberRoomScroll("room-a", snapshot, 1_000);

  assert.deepEqual(
    readRoomScrollMemory("room-a", 1_000 + ROOM_SCROLL_MEMORY_TTL_MS - 1),
    { ...snapshot, savedAt: 1_000 },
  );
});

test("chat scroll memory expires at one hour so the room opens at the bottom", () => {
  clearRoomScrollMemories();
  rememberRoomScroll("room-a", snapshot, 1_000);

  assert.equal(
    readRoomScrollMemory("room-a", 1_000 + ROOM_SCROLL_MEMORY_TTL_MS),
    null,
  );
});
