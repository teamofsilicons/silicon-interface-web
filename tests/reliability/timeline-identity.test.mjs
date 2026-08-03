import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage, event } from "./helpers.mjs";
import {
  allocateTimelineIdentity,
  applyTimelineIdentity,
  authoritativeActionId,
  bindAcceptedTimelineEvent,
  canEditAuthoritativeTimelineEvent,
  decorateDirectAcceptedTimelineEvent,
  hasAuthoritativeEventId,
  identityFromPersistedFields,
  readTimelineIdentity,
  reconcileTimelineEvents,
  timelineRenderKey,
} from "../../src/lib/timeline-identity.ts";
import {
  appendRoomEventSnippet,
  readRoomEventSnippet,
  saveRoomEventSnippet,
} from "../../src/lib/room-snippet.ts";
import { ackOutbox, enqueueOutbox, listOutbox } from "../../src/lib/outbox.ts";
import { loadStoredRoomEvents } from "../../src/lib/chat-store.ts";
import { mergeEventRevision } from "../../src/lib/event-revision.ts";
import {
  isProjectedRoomTail,
  reconcileRoomTailProjection,
  seedTimelineWithRoomTail,
} from "../../src/lib/room-tail-projection.ts";

function localEvent(identity, body = "draft") {
  return applyTimelineIdentity(
    {
      ...event(`temp-${identity.clientId}`, identity.localCreatedAt, body),
      content: { body, client_id: identity.clientId },
      _status: "pending",
    },
    identity,
  );
}

function serverEvent(id, createdAt, body, transactionId = null) {
  return {
    ...event(id, createdAt, body),
    transaction_id: transactionId,
    content: { body, client_id: transactionId ?? "shared-client" },
  };
}

test("cross-device content.client_id collision cannot claim a local row", async () => {
  installBrowser();
  const owner = "timeline-cross-device-owner";
  const identity = await allocateTimelineIdentity(owner, "shared-client", "web-a", 1_000);
  const local = localEvent(identity, "mine");
  const fromOtherDevice = serverEvent(
    "event-other-device",
    "2026-01-01T00:00:01.000Z",
    "theirs",
    null,
  );

  const rows = reconcileTimelineEvents([local], [fromOtherDevice], {
    ownerId: owner,
    currentDevice: "web-a",
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.event_id === local.event_id));
  assert.ok(rows.some((row) => row.event_id === "event-other-device"));
  assert.equal(timelineRenderKey(rows.find((row) => row.event_id === local.event_id)), identity.localKey);
});

test("trusted transaction echo keeps local key, position, and timestamp", async () => {
  installBrowser();
  const owner = "timeline-trusted-owner";
  const identity = await allocateTimelineIdentity(owner, "client-1", "web-a", 2_000);
  const local = localEvent(identity);
  const accepted = serverEvent(
    "event-1",
    "2035-02-03T04:05:06.000Z",
    "enriched",
    "client-1",
  );
  const rows = reconcileTimelineEvents([local], [accepted], {
    ownerId: owner,
    currentDevice: "web-a",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_id, "event-1");
  assert.equal(timelineRenderKey(rows[0]), identity.localKey);
  assert.equal(rows[0].created_at, identity.localCreatedAt);
  assert.equal(rows[0]._authoritativeCreatedAt, "2035-02-03T04:05:06.000Z");
  assert.equal(rows[0].content.body, "enriched");
  assert.equal(
    readTimelineIdentity(owner, "client-1")?.eventId,
    "event-1",
    "a trusted transaction echo must permanently record server acceptance",
  );
});

test("a stale history response cannot undo a newer edit", () => {
  const original = {
    ...serverEvent("event-edited", "2026-07-16T16:00:00.000Z", "original"),
    accepted_at: "2026-07-16T16:00:00.000Z",
    edit_version: 0,
    edited_at: null,
  };
  const edited = {
    ...original,
    content: { body: "edited" },
    edit_version: 1,
    edited_at: "2026-07-16T16:01:00.000Z",
    stream_position: 50,
  };
  const merged = mergeEventRevision(edited, { ...original, stream_position: 12 });
  assert.equal(merged.content.body, "edited");
  assert.equal(merged.edit_version, 1);
});

test("an edit mutation position never moves an accepted timeline row", () => {
  installBrowser();
  const first = {
    ...serverEvent("01K00000000000000000000001", "2026-07-16T16:00:00.000Z", "first"),
    accepted_at: "2026-07-16T16:00:00.000Z",
    stream_position: 99,
    edit_version: 1,
    edited_at: "2026-07-16T16:03:00.000Z",
  };
  const second = {
    ...serverEvent("01K00000000000000000000002", "2026-07-16T16:01:00.000Z", "second"),
    accepted_at: "2026-07-16T16:01:00.000Z",
    stream_position: 20,
  };
  const rows = reconcileTimelineEvents([], [second, first], {
    ownerId: "accepted-order-owner",
    currentDevice: "web-a",
  });
  assert.deepEqual(rows.map((row) => row.content.body), ["first", "second"]);
});

test("socket-before-response aliases collapse without a remount", async () => {
  installBrowser();
  const owner = "timeline-race-owner";
  const identity = await allocateTimelineIdentity(owner, "race-client", "web-a", 3_000);
  const local = localEvent(identity);
  const socketEcho = serverEvent(
    "event-race",
    "2026-01-01T00:00:03.500Z",
    "socket",
    "race-client",
  );
  const afterSocket = reconcileTimelineEvents([local], [socketEcho], {
    ownerId: owner,
    currentDevice: "web-a",
  });
  const keyAfterSocket = timelineRenderKey(afterSocket[0]);

  // An older direct response may omit transaction_id. The call site supplies
  // only the exact client ID of this POST, which is a trusted binding source.
  const directResponse = { ...socketEcho, transaction_id: null, content: { body: "http" } };
  bindAcceptedTimelineEvent(owner, "race-client", directResponse);
  const afterHttp = reconcileTimelineEvents(
    [...afterSocket, socketEcho],
    [directResponse],
    {
      ownerId: owner,
      currentDevice: "web-a",
      directClientId: "race-client",
    },
  );
  assert.equal(afterHttp.length, 1);
  assert.equal(timelineRenderKey(afterHttp[0]), keyAfterSocket);
  assert.equal(afterHttp[0].content.body, "http");
});

test("a recovery-owned direct response replaces its pending timeline row", async () => {
  installBrowser();
  const owner = "timeline-recovery-owner";
  const identity = await allocateTimelineIdentity(owner, "voice-client", "web-a", 4_000);
  const local = localEvent(identity, "voice pending");
  const response = serverEvent(
    "event-voice",
    "2035-02-03T04:05:06.000Z",
    "voice accepted",
    null,
  );
  const accepted = decorateDirectAcceptedTimelineEvent(
    owner,
    "voice-client",
    response,
  );

  const rows = reconcileTimelineEvents([local], [accepted], {
    ownerId: owner,
    currentDevice: "web-a",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_id, "event-voice");
  assert.equal(rows[0]._clientId, "voice-client");
  assert.equal(timelineRenderKey(rows[0]), identity.localKey);
});

test("snippet reload retains identity and exact transaction dedupes history", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = "timeline-snippet-owner";
  const identity = await allocateTimelineIdentity(
    owner,
    "reload-client",
    "web-a",
    Date.now(),
  );
  const local = localEvent(identity, "offline");
  saveRoomEventSnippet("timeline-room-reload", [local]);

  // Simulated remount reads serialized local metadata, then history arrives.
  installBrowser(storage);
  const restored = readRoomEventSnippet("timeline-room-reload");
  assert.equal(timelineRenderKey(restored[0]), identity.localKey);
  assert.equal(appendRoomEventSnippet(
    "timeline-room-reload",
    serverEvent(
      "event-reload",
      "2040-01-01T00:00:00.000Z",
      "authoritative",
      "reload-client",
    ),
  ), false, "accepting the optimistic identity is a revision, not a new message");
  const reconciled = readRoomEventSnippet("timeline-room-reload");
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].event_id, "event-reload");
  assert.equal(timelineRenderKey(reconciled[0]), identity.localKey);
  assert.equal(reconciled[0].created_at, identity.localCreatedAt);
});

test("a missing room tail paints from the list projection before history resolves", () => {
  installBrowser();
  const cached = [serverEvent("older-event", "2026-07-18T09:00:00.000Z", "older")];
  const room = {
    last_event: {
      event_id: "newest-event",
      preview: "the newest message",
      at: "2026-07-18T09:01:00.000Z",
      sender_handle: "alice",
      sender_kind: "carbon",
      type: "m.text",
      stream_position: 42,
      stream_writer: "writer-a",
      edit_version: 0,
      edited_at: null,
    },
  };

  const seeded = seedTimelineWithRoomTail(room, cached);
  assert.deepEqual(seeded.map((row) => row.content.body), ["older", "the newest message"]);
  assert.equal(isProjectedRoomTail(seeded[1]), true);
  assert.equal(hasAuthoritativeEventId(seeded[1]), false);
  assert.equal(authoritativeActionId(seeded[1]), null);

  saveRoomEventSnippet("projected-tail-room", seeded);
  assert.deepEqual(
    readRoomEventSnippet("projected-tail-room").map((row) => row.event_id),
    ["older-event"],
    "a preview-only row must never replace the canonical timeline cache",
  );

  const canonical = reconcileRoomTailProjection(
    seeded[1],
    serverEvent(
      "newest-event",
      "2026-07-18T09:01:00.000Z",
      "the newest message in full",
    ),
  );
  assert.equal(canonical.content.body, "the newest message in full");
  assert.equal(isProjectedRoomTail(canonical), false);
  assert.equal(hasAuthoritativeEventId(canonical), true);

  const editedProjection = seedTimelineWithRoomTail(
    {
      last_event: {
        ...room.last_event,
        preview: "newer edited preview",
        edit_version: 2,
        edited_at: "2026-07-18T09:02:00.000Z",
      },
    },
    [canonical],
  ).at(-1);
  const staleHistory = reconcileRoomTailProjection(editedProjection, {
    ...canonical,
    edit_version: 1,
    edited_at: "2026-07-18T09:01:30.000Z",
  });
  assert.equal(staleHistory.content.body, "newer edited preview");
  assert.equal(isProjectedRoomTail(staleHistory), true);
  assert.equal(hasAuthoritativeEventId(staleHistory), false);
});

test("persisted local sequence survives clock regression and orders sends", async () => {
  installBrowser();
  const owner = "timeline-clock-owner";
  const first = await allocateTimelineIdentity(owner, "clock-first", "web-a", 9_000);
  const second = await allocateTimelineIdentity(owner, "clock-second", "web-a", 1_000);
  assert.ok(second.localSequence > first.localSequence);

  const rows = reconcileTimelineEvents(
    [localEvent(first, "first"), localEvent(second, "second")],
    [
      serverEvent("clock-event-2", "1990-01-01T00:00:00.000Z", "second", "clock-second"),
      serverEvent("clock-event-1", "2090-01-01T00:00:00.000Z", "first", "clock-first"),
    ],
    { ownerId: owner, currentDevice: "web-a" },
  );
  assert.deepEqual(rows.map((row) => row.content.body), ["first", "second"]);
  assert.deepEqual(rows.map(timelineRenderKey), [first.localKey, second.localKey]);
});

test("accepted messages follow authoritative ULID order despite client timestamp skew", () => {
  installBrowser();
  const older = serverEvent(
    "01J00000000000000000000001",
    "2090-01-01T00:00:00.000Z",
    "older",
  );
  const newer = serverEvent(
    "01J00000000000000000000002",
    "1990-01-01T00:00:00.000Z",
    "newer",
  );
  const rows = reconcileTimelineEvents([], [newer, older], {
    ownerId: "timeline-authoritative-order-owner",
    currentDevice: "web-a",
  });
  assert.deepEqual(rows.map((row) => row.content.body), ["older", "newer"]);
  assert.equal(rows.at(-1).event_id, newer.event_id);
});

test("cross-writer accepted messages follow commit position when ULIDs disagree", () => {
  installBrowser();
  const committedFirst = {
    ...serverEvent("01J00000000000000000000002", "2026-01-01T00:00:00.000Z", "first"),
    stream_position: 40,
  };
  const committedSecond = {
    ...serverEvent("01J00000000000000000000001", "2026-01-01T00:00:00.000Z", "second"),
    stream_position: 41,
  };
  const rows = reconcileTimelineEvents([], [committedSecond, committedFirst], {
    ownerId: "timeline-cross-writer-order-owner",
    currentDevice: "web-a",
  });
  assert.deepEqual(rows.map((row) => row.content.body), ["first", "second"]);
});

test("duplicate history pages are idempotent and synthetic rows gate server actions", async () => {
  installBrowser();
  const authoritative = serverEvent(
    "event-history",
    "2026-01-01T00:00:00.000Z",
    "once",
    null,
  );
  const rows = reconcileTimelineEvents([authoritative], [authoritative, authoritative], {
    ownerId: "timeline-history-owner",
    currentDevice: "web-a",
  });
  assert.equal(rows.length, 1);
  assert.equal(authoritativeActionId(rows[0]), "event-history");
  assert.equal(
    authoritativeActionId({ ...authoritative, event_id: "temp-no-server-id" }),
    null,
  );
  assert.equal(
    canEditAuthoritativeTimelineEvent(
      { ...authoritative, event_id: "temp-no-server-id" },
      { isMine: true, roomIncludesSilicon: false, hasEditableText: true },
    ),
    false,
    "pending rows must never reach api.editEvent(temp-*)",
  );
  assert.equal(
    canEditAuthoritativeTimelineEvent(authoritative, {
      isMine: true,
      roomIncludesSilicon: false,
      hasEditableText: true,
    }),
    true,
  );
});

test("outbox identity is durable and event alias commits before acknowledgement", async () => {
  installBrowser();
  const owner = "timeline-outbox-owner";
  const queued = await enqueueOutbox(owner, {
    roomId: "timeline-outbox-room",
    clientId: "durable-client",
    body: "durable",
    at: 10_000,
  });
  assert.ok(queued.localKey);
  assert.ok(Number.isSafeInteger(queued.localSequence));
  assert.ok(queued.originDevice);
  assert.equal((await listOutbox(owner))[0].localKey, queued.localKey);

  const accepted = serverEvent(
    "event-durable",
    "2050-01-01T00:00:00.000Z",
    "durable",
    "durable-client",
  );
  assert.equal(
    await ackOutbox(owner, "durable-client", {
      roomId: "timeline-outbox-room",
      event: accepted,
    }),
    true,
  );
  assert.deepEqual(await listOutbox(owner), []);
  const cached = await loadStoredRoomEvents(owner, "timeline-outbox-room", 10);
  assert.equal(cached.length, 1);
  assert.equal(timelineRenderKey(cached[0]), queued.localKey);
  assert.equal(cached[0].created_at, queued.localCreatedAt);
  assert.equal(cached[0]._authoritativeCreatedAt, "2050-01-01T00:00:00.000Z");
});

test("IDB allocates unique sequences atomically without Web Locks", async () => {
  installBrowser();
  const owner = "timeline-atomic-sequence-owner";
  const entries = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      enqueueOutbox(owner, {
        roomId: "atomic-room",
        clientId: `atomic-${String(index).padStart(2, "0")}`,
        body: String(index),
        at: 20_000,
      }),
    ),
  );
  const sequences = entries.map((row) => row.localSequence);
  assert.equal(new Set(sequences).size, entries.length);
  const sorted = [...sequences].sort((left, right) => left - right);
  assert.deepEqual(sorted, Array.from({ length: 24 }, (_, index) => sorted[0] + index));
  assert.ok(entries.every((row) => row.localKey && row.originDevice && row.localCreatedAt));
});

test("same client ID cannot overwrite a different room or operation namespace", async () => {
  installBrowser();
  const owner = "timeline-scope-owner";
  await enqueueOutbox(owner, {
    roomId: "room-a",
    clientId: "scope-client-room",
    body: "room a",
    at: 30_000,
  });
  await assert.rejects(
    enqueueOutbox(owner, {
      roomId: "room-b",
      clientId: "scope-client-room",
      body: "room b",
      at: 30_001,
    }),
    /different room or operation namespace/,
  );

  await enqueueOutbox(owner, {
    roomId: "room-a",
    clientId: "scope-client-kind",
    body: "event",
    at: 30_002,
  });
  await assert.rejects(
    enqueueOutbox(owner, {
      roomId: "room-a",
      clientId: "scope-client-kind",
      operation: "held",
      body: "held",
      at: 30_003,
    }),
    /different room or operation namespace/,
  );
  const pending = await listOutbox(owner);
  assert.equal(pending.find((row) => row.clientId === "scope-client-room").roomId, "room-a");
  assert.equal(pending.find((row) => row.clientId === "scope-client-kind").operation, undefined);
});

test("stale outbox fields cannot erase or mutate a bound event alias", async () => {
  installBrowser();
  const owner = "timeline-stale-bound-owner";
  const queued = await enqueueOutbox(owner, {
    roomId: "stale-room",
    clientId: "stale-client",
    body: "stale",
    at: 40_000,
  });
  const accepted = serverEvent(
    "stale-event",
    "2060-01-01T00:00:00.000Z",
    "accepted",
    "stale-client",
  );
  bindAcceptedTimelineEvent(owner, queued.clientId, accepted);
  const stale = identityFromPersistedFields(owner, queued.clientId, {
    localKey: queued.localKey,
    localSequence: queued.localSequence,
    originDevice: queued.originDevice,
    localCreatedAt: queued.localCreatedAt,
  });
  assert.equal(stale.eventId, "stale-event");
  assert.equal(readTimelineIdentity(owner, queued.clientId).eventId, "stale-event");
  assert.throws(
    () =>
      identityFromPersistedFields(owner, queued.clientId, {
        localKey: `${queued.localKey}-changed`,
        localSequence: queued.localSequence,
        originDevice: queued.originDevice,
        localCreatedAt: queued.localCreatedAt,
      }),
    /changed immutable identity/,
  );
});
