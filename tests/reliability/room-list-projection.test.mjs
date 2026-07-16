import assert from "node:assert/strict";
import test from "node:test";

const projection = await import("../../src/lib/room-list-projection.ts");

function room(id, activity, overrides = {}) {
  return {
    room_id: id,
    list_preferences: { pinned: false, archived: false },
    list_projection: {
      version: 1,
      complete: true,
      through_stream_position: activity,
      activity_stream_position: activity,
      activity_at: activity ? "2026-07-12T00:00:00Z" : "",
      draft: { active: false, version: 0, updated_at: "" },
      held: { active_count: 0, attention_count: 0, next_release_at: "" },
    },
    ...overrides,
  };
}

test("room list ordering is pinned then authoritative activity then stable identity", () => {
  const rows = [
    room("room-a", 9),
    room("room-b", 7, { list_preferences: { pinned: true, archived: false } }),
    room("room-c", 9),
  ].sort(projection.compareRoomListRows);
  assert.deepEqual(rows.map((value) => value.room_id), ["room-b", "room-c", "room-a"]);
});

test("archive view is principal-scoped while search spans both views", () => {
  const active = room("active", 1);
  const archived = room("archived", 2, {
    list_preferences: { pinned: false, archived: true },
  });
  assert.equal(projection.roomVisibleInArchiveView(active, false, false), true);
  assert.equal(projection.roomVisibleInArchiveView(archived, false, false), false);
  assert.equal(projection.roomVisibleInArchiveView(archived, true, false), true);
  assert.equal(projection.roomVisibleInArchiveView(active, true, false), false);
  assert.equal(projection.roomVisibleInArchiveView(archived, false, true), true);
});

test("server status cannot displace a stronger draft or attention state", () => {
  const value = room("room", 1);
  assert.equal(projection.serverRoomListStatus(value), null);
  value.list_projection.held.active_count = 1;
  assert.equal(projection.serverRoomListStatus(value), "held");
  value.list_projection.held.attention_count = 1;
  assert.equal(projection.serverRoomListStatus(value), "attention");
  value.list_projection.held.active_count = 0;
  value.list_projection.held.attention_count = 0;
  value.list_projection.draft = {
    active: true,
    version: 2,
    updated_at: "2026-07-12T00:00:00Z",
  };
  assert.equal(projection.serverRoomListStatus(value), null);
});
