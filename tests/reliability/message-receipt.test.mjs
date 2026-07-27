import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  messageReceiptPresentation,
  readReceiptCoversEvent,
  strongestMessageReceiptStatus,
} from "../../src/lib/message-receipt.ts";
import { mergeDeliverySummaries } from "../../src/lib/delivery-state.ts";
import {
  mergeRoomReceiptProjection,
  replaceRoomsPreservingReceiptFacts,
} from "../../src/lib/room-shape.ts";
import { validateRoomListProjection } from "../../src/lib/sync-integrity.ts";

const sent = {
  state: "sent",
  recipient_count: 1,
  delivered_count: 0,
  read_count: 0,
};
const delivered = {
  state: "delivered",
  recipient_count: 1,
  delivered_count: 1,
  read_count: 0,
};

test("out-of-order snapshots cannot downgrade delivery receipts", () => {
  assert.deepEqual(mergeDeliverySummaries(delivered, sent), delivered);
  assert.deepEqual(mergeDeliverySummaries(sent, delivered), delivered);

  const current = {
    room_id: "room",
    last_event: { event_id: "event", delivery: delivered, read: false },
  };
  const stale = {
    room_id: "room",
    name: "authoritative name",
    last_event: { event_id: "event", delivery: sent, read: false },
  };
  assert.deepEqual(mergeRoomReceiptProjection(current, stale).last_event.delivery, delivered);
  assert.deepEqual(
    replaceRoomsPreservingReceiptFacts([current], [stale])[0].last_event.delivery,
    delivered,
  );
  assert.equal(replaceRoomsPreservingReceiptFacts([current], [stale])[0].name, "authoritative name");
});

test("stale room refreshes cannot roll the sidebar behind the live timeline", () => {
  const projection = (activity, at, draftActive = false) => ({
    version: 1,
    complete: true,
    through_stream_position: activity,
    activity_stream_position: activity,
    activity_at: at,
    draft: {
      active: draftActive,
      version: draftActive ? 4 : 0,
      updated_at: draftActive ? "2026-07-17T05:20:00.000Z" : "",
    },
    held: { active_count: 0, attention_count: 0, next_release_at: "" },
  });
  const current = {
    room_id: "room",
    name: "cached name",
    last_event: {
      event_id: "new-event",
      preview: "you must be hugeee",
      at: "2026-07-17T05:19:25.000Z",
      sender_handle: "me",
      type: "m.text",
      stream_position: 12,
    },
    list_projection: projection(12, "2026-07-17T05:19:25.000Z"),
  };
  const staleRefresh = {
    room_id: "room",
    name: "authoritative name",
    last_event: {
      event_id: "old-event",
      preview: "holaa bade bhaluu",
      at: "2026-07-17T05:18:00.000Z",
      sender_handle: "peer",
      type: "m.text",
      stream_position: 11,
    },
    list_projection: projection(11, "2026-07-17T05:18:00.000Z", true),
  };

  const merged = replaceRoomsPreservingReceiptFacts([current], [staleRefresh])[0];
  assert.equal(merged.last_event.event_id, "new-event");
  assert.equal(merged.last_event.preview, "you must be hugeee");
  assert.equal(merged.list_projection.activity_stream_position, 12);
  assert.equal(merged.name, "authoritative name");
  assert.equal(merged.list_projection.draft.active, true);
});

test("a genuinely newer room projection replaces the local sidebar tail", () => {
  const current = {
    room_id: "room",
    last_event: {
      event_id: "event-12",
      preview: "twelve",
      at: "2026-07-17T05:19:25.000Z",
      sender_handle: "me",
      type: "m.text",
      stream_position: 12,
    },
    list_projection: {
      version: 1,
      complete: true,
      through_stream_position: 12,
      activity_stream_position: 12,
      activity_at: "2026-07-17T05:19:25.000Z",
      draft: { active: false, version: 0, updated_at: "" },
      held: { active_count: 0, attention_count: 0, next_release_at: "" },
    },
  };
  const incoming = {
    ...current,
    last_event: {
      ...current.last_event,
      event_id: "event-13",
      preview: "thirteen",
      stream_position: 13,
    },
    list_projection: {
      ...current.list_projection,
      through_stream_position: 13,
      activity_stream_position: 13,
    },
  };

  const merged = mergeRoomReceiptProjection(current, incoming);
  assert.equal(merged.last_event.event_id, "event-13");
  assert.equal(merged.last_event.preview, "thirteen");
});

test("a newer event from another writer keeps its exact lower activity position", () => {
  const projection = (activity, through, at) => ({
    version: 1,
    complete: true,
    through_stream_position: through,
    activity_stream_position: activity,
    activity_at: at,
    draft: { active: false, version: 0, updated_at: "" },
    held: { active_count: 0, attention_count: 0, next_release_at: "" },
  });
  const current = {
    room_id: "multi-writer-room",
    last_event: {
      event_id: "writer-a-100",
      preview: "older writer-a event",
      at: "2026-07-17T05:19:25.000Z",
      sender_handle: "alice",
      type: "m.text",
      stream_position: 100,
      stream_writer: "writer-a",
    },
    list_projection: projection(100, 100, "2026-07-17T05:19:25.000Z"),
  };
  const incoming = {
    ...current,
    last_event: {
      event_id: "writer-b-7",
      preview: "newer writer-b event",
      at: "2026-07-17T05:20:00.000Z",
      sender_handle: "bob",
      type: "m.text",
      stream_position: 7,
      stream_writer: "writer-b",
    },
    list_projection: projection(7, 7, "2026-07-17T05:20:00.000Z"),
  };

  const merged = mergeRoomReceiptProjection(current, incoming);
  assert.equal(merged.last_event.event_id, "writer-b-7");
  assert.equal(merged.list_projection.activity_stream_position, 7);
  assert.equal(merged.list_projection.through_stream_position, 100);
  assert.doesNotThrow(() =>
    validateRoomListProjection(merged.list_projection, merged.last_event));
});

test("stale snapshots cannot undo a newer edit revision", () => {
  const current = {
    room_id: "room",
    last_event: {
      event_id: "event",
      preview: "new edit",
      at: "2026-07-17T05:19:25.000Z",
      sender_handle: "peer",
      type: "m.text",
      edit_version: 8,
      delivery: delivered,
    },
  };
  const stale = {
    room_id: "room",
    name: "authoritative name",
    last_event: {
      ...current.last_event,
      preview: "old edit",
      edit_version: 7,
      delivery: sent,
    },
  };

  const merged = mergeRoomReceiptProjection(current, stale);
  assert.equal(merged.last_event.preview, "new edit");
  assert.equal(merged.last_event.edit_version, 8);
  assert.deepEqual(merged.last_event.delivery, delivered);
  assert.equal(merged.name, "authoritative name");
});

test("timeline and sidebar receipt projections always render the strongest fact", () => {
  assert.equal(strongestMessageReceiptStatus("sent", "delivered"), "delivered");
  assert.equal(strongestMessageReceiptStatus("delivered", "sent"), "delivered");
  assert.equal(strongestMessageReceiptStatus("delivered", "read"), "read");
});

test("receipts distinguish local waiting from server acceptance", () => {
  for (const status of ["pending", "resolving", "retry_wait", "retrying"]) {
    assert.deepEqual(messageReceiptPresentation(status), {
      visual: "waiting",
      label: "waiting",
    });
  }
  assert.deepEqual(messageReceiptPresentation("sent"), {
    visual: "sent",
    label: "sent",
  });
  assert.deepEqual(messageReceiptPresentation("delivered"), {
    visual: "delivered",
    label: "delivered",
  });
  assert.deepEqual(messageReceiptPresentation("read"), {
    visual: "read",
    label: "read",
  });
});

test("waiting, sent, delivered, and read use the requested Phosphor glyph classes", async () => {
  const source = await readFile(
    new URL("../../src/components/chat/message-receipt-glyph.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /"ph ph-clock opacity-60"/);
  assert.match(source, /"ph ph-check scale-\[0\.71\]"/);
  assert.match(source, /"ph ph-checks"/);
  assert.match(source, /weight="fill"/);
  assert.match(source, /"ph-fill ph-checks"/);
  assert.doesNotMatch(source, /SignalReceiptMark/);
});

test("receipt glyphs have a deliberate metadata and sidebar footprint", async () => {
  const bubbleSource = await readFile(
    new URL("../../src/components/chat/message-bubble.tsx", import.meta.url),
    "utf8",
  );
  const roomListSource = await readFile(
    new URL("../../src/components/chat/room-list.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    bubbleSource,
    /MessageReceiptGlyph status=\{status\} className="h-4 w-4 shrink-0"/,
  );
  assert.match(
    roomListSource,
    /className="h-5 w-5 shrink-0 text-foreground"/,
  );
});

test("group receipts never overclaim partial delivery or partial read", () => {
  assert.deepEqual(messageReceiptPresentation("partially_delivered"), {
    visual: "delivered",
    label: "delivered to some",
  });
  assert.deepEqual(messageReceiptPresentation("partially_read"), {
    visual: "delivered",
    label: "delivered · read by some",
  });
});

test("failures and verification needs stay visibly actionable", () => {
  assert.equal(messageReceiptPresentation("failed").visual, "attention");
  assert.equal(messageReceiptPresentation("challenge").visual, "attention");
});

test("sidebar read ticks accept receipts that cover a newer checkpoint", () => {
  const event = {
    event_id: "01J00000000000000000000001",
    stream_position: 7,
    stream_writer: "writer-a",
  };
  assert.equal(readReceiptCoversEvent({
    event_id: "01J00000000000000000000002",
    read_stream_position: 9,
  }, event), true);
  assert.equal(readReceiptCoversEvent({
    event_id: "other",
    read_stream_position: 12,
    read_stream_vector: { floor: 2, writers: { "writer-a": 7, "writer-b": 12 } },
  }, event), true);
  assert.equal(readReceiptCoversEvent({
    event_id: "other",
    read_stream_position: 12,
    read_stream_vector: { floor: 2, writers: { "writer-a": 6, "writer-b": 12 } },
  }, event), false);
});

test("direct-room receipt frames update the sidebar without waiting for refresh", async () => {
  const source = await readFile(
    new URL("../../src/app/chat/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(!incoming && candidate\.kind !== "direct"\) return candidate/);
  assert.match(source, /if \(r\.kind === "direct"\)/);
  assert.match(source, /last_event: \{ \.\.\.le, delivery, read: true \}/);
});
