import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

const storage = installBrowser(new MemoryStorage());
const sidebar = await import("../../src/lib/sidebar-cache.ts");

const ROOM = {
  room_id: "room-1",
  kind: "direct",
  title: "Room",
  members: [],
  last_event: null,
  unread_count: 0,
};

function reset() {
  storage.clear();
}

function ageSlice(ownerId, slice, ms) {
  const key = `silicon-interface:sidebar-cache:${encodeURIComponent(ownerId)}`;
  const parsed = JSON.parse(storage.getItem(key));
  parsed.sliceSavedAt[slice] -= ms;
  storage.setItem(key, JSON.stringify(parsed));
}

test("rosters with no delta path expire; rooms corrected by cursor do not", () => {
  reset();
  sidebar.saveCachedRooms("owner", [ROOM]);
  sidebar.saveCachedContacts("owner", [{ handle: "a" }]);
  sidebar.saveCachedTeamRoster("owner", "team", [{ handle: "a" }]);

  assert.equal(sidebar.loadCachedContacts("owner").length, 1);
  assert.equal(sidebar.loadCachedTeamRoster("owner", "team").length, 1);

  ageSlice("owner", "contacts", sidebar.ROSTER_CACHE_MAX_AGE_MS + 1);
  ageSlice("owner", "teamRosters", sidebar.ROSTER_CACHE_MAX_AGE_MS + 1);

  // "no data" so the UI waits for the authoritative list instead of asserting
  // a roster that may have lost members weeks ago.
  assert.equal(sidebar.loadCachedContacts("owner"), null);
  assert.equal(sidebar.loadCachedTeamRoster("owner", "team"), null);
  // The room list is corrected by room.upsert/room.remove, so age is not
  // evidence of staleness and expiring it would only cost an instant paint.
  assert.equal(sidebar.loadCachedRooms("owner").length, 1);
});

test("a room-list write never renews the roster clock", () => {
  reset();
  sidebar.saveCachedContacts("owner", [{ handle: "a" }]);
  ageSlice("owner", "contacts", sidebar.ROSTER_CACHE_MAX_AGE_MS + 1);

  // The exact shape of the old bug: one shared savedAt meant any write made
  // every slice look freshly saved, so a stale cache never aged out.
  sidebar.saveCachedRooms("owner", [ROOM]);
  assert.equal(sidebar.loadCachedContacts("owner"), null);
});

test("memberships age out with the rosters they are derived from", () => {
  reset();
  sidebar.saveCachedMemberships("owner", new Map([["carbon:a", new Set(["team"])]]));
  assert.equal(sidebar.loadCachedMemberships("owner").size, 1);
  ageSlice("owner", "memberships", sidebar.ROSTER_CACHE_MAX_AGE_MS + 1);
  assert.equal(sidebar.loadCachedMemberships("owner"), null);
});

test("a cache written before per-slice times is treated as expired, not fresh", () => {
  reset();
  // Exactly what every existing browser holds today: a v3 payload with no
  // sliceSavedAt at all. It must never read as fresh — an unknown write time is
  // the case that most needs re-fetching — but the room list it already holds
  // must survive, which is the whole reason this landed inside v3 instead of
  // bumping the version and discarding every cache in the wild.
  storage.setItem(
    `silicon-interface:sidebar-cache:${encodeURIComponent("owner")}`,
    JSON.stringify({
      version: 3,
      ownerId: "owner",
      rooms: [ROOM],
      contacts: [{ handle: "a" }],
      teams: [],
      memberships: { "carbon:a": ["team"] },
      teamRosters: { team: [{ handle: "a" }] },
      savedAt: Date.now(),
    }),
  );
  assert.equal(sidebar.loadCachedContacts("owner"), null);
  assert.equal(sidebar.loadCachedTeamRoster("owner", "team"), null);
  assert.equal(sidebar.loadCachedMemberships("owner"), null);
  assert.equal(sidebar.loadCachedRooms("owner").length, 1);
});

test("signing in retires every other owner's sidebar cache", () => {
  reset();
  sidebar.saveCachedRooms("owner-a", [ROOM]);
  sidebar.saveCachedRooms("owner-b", [ROOM]);
  assert.deepEqual(sidebar.listCachedSidebarOwners().sort(), ["owner-a", "owner-b"]);

  assert.deepEqual(sidebar.purgeForeignSidebarCaches("owner-b"), ["owner-a"]);
  assert.deepEqual(sidebar.listCachedSidebarOwners(), ["owner-b"]);
  assert.equal(sidebar.loadCachedRooms("owner-a"), null);
  assert.equal(sidebar.loadCachedRooms("owner-b").length, 1);
});

test("clearing one owner leaves unrelated storage keys alone", () => {
  reset();
  sidebar.saveCachedRooms("owner-a", [ROOM]);
  storage.setItem("silicon-interface:sounds", "on");
  sidebar.clearCachedSidebar("owner-a");
  assert.equal(sidebar.loadCachedRooms("owner-a"), null);
  assert.equal(storage.getItem("silicon-interface:sounds"), "on");
  assert.deepEqual(sidebar.listCachedSidebarOwners(), []);
});
