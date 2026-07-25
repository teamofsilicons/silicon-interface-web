import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPLETE_HISTORY_PAGE_SIZE,
  loadCompleteRoomHistory,
} from "../../src/lib/room-history-archive.ts";

function event(id, streamPosition) {
  return {
    event_id: id,
    stream_position: streamPosition,
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "c_test",
    type: "m.file",
    content: { media_id: `media-${id}` },
    reply_to_event_id: "",
    is_final: true,
    created_at: new Date(streamPosition * 1_000).toISOString(),
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

test("profile history collection follows every signed page", async () => {
  const calls = [];
  const pages = {
    "": {
      events: [event("event-3", 3), event("event-4", 4)],
      cursor: "older-1",
      has_more: true,
      direction: "backward",
      through_event_id: "event-4",
    },
    "older-1": {
      events: [event("event-1", 1), event("event-2", 2)],
      cursor: null,
      has_more: false,
      direction: "backward",
      through_event_id: "event-4",
    },
  };

  const result = await loadCompleteRoomHistory("room-a", async (roomId, cursor, limit) => {
    calls.push({ roomId, cursor, limit });
    return pages[cursor];
  });

  assert.deepEqual(result.map((row) => row.event_id), [
    "event-1",
    "event-2",
    "event-3",
    "event-4",
  ]);
  assert.deepEqual(calls, [
    { roomId: "room-a", cursor: "", limit: COMPLETE_HISTORY_PAGE_SIZE },
    { roomId: "room-a", cursor: "older-1", limit: COMPLETE_HISTORY_PAGE_SIZE },
  ]);
});
