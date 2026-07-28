import assert from "node:assert/strict";
import test from "node:test";

import { roomDisplay } from "../../src/lib/peers.ts";
import { normalizeRoom } from "../../src/lib/room-shape.ts";

test("Glass-managed carbon groups use their room logo", () => {
  const normalized = normalizeRoom({
    room_id: "01CARBONGROUP0000000000000",
    kind: "group",
    team: 1,
    team_slug: "tos",
    peer_kinds: ["carbon"],
    peers: [
      {
        kind: "carbon",
        id: "bob",
        handle: "bob",
        name: "Bob",
        profile_photo_url: null,
      },
    ],
    profile_photo_url: "/api/v1/media/profile-assets/group-logo",
    name: "TOS Core",
    topic: "Carbon coordination",
    settings: { glass_carbon_group: true, carbon_only: true },
  });

  assert.ok(normalized);
  assert.equal(
    normalized.profile_photo_url,
    "/api/v1/media/profile-assets/group-logo",
  );
  assert.deepEqual(roomDisplay(normalized), {
    name: "TOS Core",
    handle: "01CARBONGROUP0000000000000",
    photoUrl: "/api/v1/media/profile-assets/group-logo",
    asciiUrl: null,
    peer: null,
    subtitle: "2 members",
  });
});
