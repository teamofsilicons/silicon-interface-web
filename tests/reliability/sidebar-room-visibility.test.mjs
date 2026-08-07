import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { roomVisibleInSidebar } from "../../src/lib/sidebar-room-visibility.ts";

test("sidebar hides peerless direct rooms even when stale activity remains", () => {
  assert.equal(roomVisibleInSidebar({ kind: "direct", peers: [] }), false);
});

test("sidebar keeps identified direct rooms and groups", () => {
  assert.equal(
    roomVisibleInSidebar({
      kind: "direct",
      peers: [{ kind: "carbon", id: "carbon-1" }],
    }),
    true,
  );
  assert.equal(roomVisibleInSidebar({ kind: "group", peers: [] }), true);
});

test("chat page applies peer visibility before sidebar projections and filtering", () => {
  const source = readFileSync(
    new URL("../../src/app/chat/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /rooms\.filter\(roomVisibleInSidebar\)/);
  assert.match(source, /const list = sidebarRooms\.filter/);
  assert.match(source, /projectArchivedRoomListEntry\(sidebarRooms\)/);
});
