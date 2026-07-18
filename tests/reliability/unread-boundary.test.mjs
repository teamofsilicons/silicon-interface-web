import assert from "node:assert/strict";
import test from "node:test";

const unread = await import("../../src/lib/unread-boundary.ts");
const integrity = await import("../../src/lib/sync-integrity.ts");

function event(position, overrides = {}) {
  return {
    event_id: `01K${String(position).padStart(23, "0")}`,
    stream_position: position,
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "alice",
    type: "m.text",
    content: { body: String(position) },
    reply_to_event_id: "",
    is_final: true,
    created_at: "2026-01-01T00:00:00Z",
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
    ...overrides,
  };
}

test("divider keeps exact anchor and falls forward by position after redaction", () => {
  const boundary = {
    last_read_stream_position: 4,
    first_unread_event_id: event(5).event_id,
    first_unread_stream_position: 5,
    unread_count: 3,
    through_stream_position: 7,
  };
  assert.equal(unread.selectUnreadDividerEventId([event(5), event(6)], boundary), event(5).event_id);
  assert.equal(
    unread.selectUnreadDividerEventId([
      event(5, { redacted_at: "2026-01-02T00:00:00Z" }),
      event(6),
    ], boundary),
    event(6).event_id,
  );
  assert.equal(unread.selectUnreadDividerEventId([event(4)], boundary), null);
});

test("read target requires meaningful visibility and advances monotonically", () => {
  const candidates = [
    { event: event(5), top: 0, bottom: 1, height: 80 },
    { event: event(6), top: 20, bottom: 80, height: 60 },
    { event: event(7), top: 70, bottom: 100, height: 30 },
    { event: event(8, { sender_handle: "me" }), top: 10, bottom: 50, height: 40 },
    { event: event(9, { type: "m.system", sender_kind: "system" }), top: 10, bottom: 50, height: 40 },
  ];
  assert.equal(
    unread.selectVisibleReadTarget(candidates, { top: 0, bottom: 90 }, "me", 4)?.stream_position,
    7,
  );
  assert.equal(
    unread.selectVisibleReadTarget(candidates, { top: 0, bottom: 90 }, "me", 7),
    null,
  );
  assert.equal(
    unread.selectVisibleReadTarget(candidates, { top: 101, bottom: 200 }, "me", 4),
    null,
  );
});

test("visible reads use per-writer checkpoints instead of a global scalar maximum", () => {
  const vector = {
    floor: 0,
    writers: { "writer-a": 5, "writer-b": 11 },
  };
  const candidates = [
    {
      event: event(6, { stream_writer: "writer-a" }),
      top: 10,
      bottom: 60,
      height: 50,
    },
  ];

  assert.equal(
    unread.selectVisibleReadTarget(
      candidates,
      { top: 0, bottom: 100 },
      "me",
      11,
      vector,
    )?.event_id,
    event(6).event_id,
    "writer-a:6 is newer than writer-a:5 even though writer-b reached 11",
  );
  assert.equal(
    unread.selectVisibleReadTarget(
      [{ ...candidates[0], event: event(5, { stream_writer: "writer-a" }) }],
      { top: 0, bottom: 100 },
      "me",
      11,
      vector,
    ),
    null,
  );
});

test("unfinished streaming events become read-eligible only after finalization", () => {
  assert.equal(unread.isUnreadEligibleEvent(event(12, { is_final: false })), false);
  assert.equal(unread.isUnreadEligibleEvent(event(12, { is_final: true })), true);
});

test("opening a room clears its projected unread tail before history hydration", () => {
  const room = {
    room_id: "room-open-read",
    observed: false,
    unread: true,
    unread_count: 3,
    unread_boundary: {
      last_read_stream_position: 4,
      first_unread_event_id: event(5).event_id,
      first_unread_stream_position: 5,
      unread_count: 3,
      through_stream_position: 9,
    },
    last_event: {
      event_id: event(8).event_id,
      stream_position: 8,
    },
  };
  assert.deepEqual(unread.roomOpenReadTarget(room), {
    eventId: event(8).event_id,
    streamPosition: 9,
  });
  assert.deepEqual(
    unread.roomOpenReadTarget({ ...room, unread: false, unread_count: 0 }),
    { eventId: event(8).event_id, streamPosition: 9 },
    "a stale top-level count must not mask an authoritative unread boundary",
  );
  assert.equal(unread.roomOpenReadTarget({
    ...room,
    unread: false,
    unread_count: 0,
    unread_boundary: {
      ...room.unread_boundary,
      first_unread_event_id: null,
      first_unread_stream_position: null,
      unread_count: 0,
    },
  }), null);
  assert.equal(unread.roomOpenReadTarget({ ...room, observed: true }), null);
});

test("late lower commit remains unread under a multi-writer read checkpoint", () => {
  const boundary = {
    // Compatibility maxima alone would incorrectly hide writer-a:10 behind 11.
    last_read_stream_position: 11,
    last_read_stream_vector: {
      floor: 0,
      writers: { "writer-a": 5, "writer-b": 11 },
    },
    first_unread_event_id: event(10).event_id,
    first_unread_stream_position: 10,
    first_unread_stream_writer: "writer-a",
    unread_count: 1,
    through_stream_position: 11,
    through_stream_vector: {
      floor: 0,
      writers: { "writer-a": 10, "writer-b": 11 },
    },
  };

  assert.doesNotThrow(() => integrity.validateUnreadBoundary(boundary));
  assert.equal(unread.selectUnreadDividerEventId([event(10)], boundary), event(10).event_id);
});
