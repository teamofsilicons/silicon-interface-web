import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRooms } from "../../src/lib/room-shape.ts";

function direct(roomId, peerId) {
  return {
    room_id: roomId,
    kind: "direct",
    peer_kinds: ["carbon"],
    peers: [{
      kind: "carbon",
      id: peerId,
      handle: peerId,
      name: peerId,
      profile_photo_url: null,
    }],
  };
}

test("legacy direct-room duplicates collapse to the server's oldest canonical room", () => {
  const rooms = normalizeRooms([
    direct("01ZZZZZZZZZZZZZZZZZZZZZZZZ", "prince"),
    direct("01AAAAAAAAAAAAAAAAAAAAAAAA", "prince"),
    direct("01MMMMMMMMMMMMMMMMMMMMMMMM", "another-person"),
    {
      room_id: "01GROUPGROUPGROUPGROUPGROUPG",
      kind: "group",
      name: "Prince project",
      peer_kinds: ["carbon"],
      peers: [{
        kind: "carbon",
        id: "prince",
        handle: "prince",
        name: "Prince",
        profile_photo_url: null,
      }],
    },
  ]);

  assert.deepEqual(
    rooms.map((room) => room.room_id),
    [
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
      "01MMMMMMMMMMMMMMMMMMMMMMMM",
      "01GROUPGROUPGROUPGROUPGROUPG",
    ],
  );
});

test("observer-style direct projections with multiple peers are not collapsed", () => {
  const observed = {
    ...direct("01OBSERVEDROOM000000000000", "prince"),
    peers: [
      direct("unused", "prince").peers[0],
      direct("unused", "colleague").peers[0],
    ],
  };
  assert.equal(normalizeRooms([observed, { ...observed, room_id: "01OBSERVEDROOM000000000001" }]).length, 2);
});
