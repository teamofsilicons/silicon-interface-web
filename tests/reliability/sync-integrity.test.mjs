import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser } from "./helpers.mjs";

const integrity = await import("../../src/lib/sync-integrity.ts");
const { ApiError } = await import("../../src/lib/api.ts");
const recovery = await import("../../src/lib/sync-recovery.ts");

function eventFrame(position, id = String(position).padStart(26, "0")) {
  return {
    type: "event",
    room_id: "room-1",
    event: {
      event_id: id,
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
    },
  };
}

function range(stream, overrides = {}) {
  return {
    stream,
    from_position: 10,
    next_position: 15,
    through_position: 20,
    first_item_position: 12,
    last_item_position: 15,
    item_count: 2,
    has_more: true,
    complete_through: false,
    coverage: stream === "events" ? "authoritative_projection" : "contiguous",
    ...overrides,
  };
}

function eventPage(overrides = {}) {
  return {
    frames: [eventFrame(12), eventFrame(15)],
    cursor: "signed-next",
    through: "signed-through",
    has_more: true,
    range: range("events"),
    ...overrides,
  };
}

function accountUpdate(position) {
  return {
    position,
    kind: "room.upsert",
    room_id: "room-1",
    object_id: "room-1",
    data: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

function clientOperation() {
  return {
    operation_id: "01K00000000000000000000001",
    room_id: "01K00000000000000000000002",
    kind: "held_send",
    client_id: "client-operation-1",
    device_id: "web-device",
    state: "pending",
    resource_id: "01K00000000000000000000003",
    result_event_id: "",
    http_status: 201,
    accepted_at: "2026-01-01T00:00:00Z",
    terminal_at: "",
    expires_at: "2026-02-01T00:00:00Z",
  };
}

test("event coverage accepts visible jumps and a terminal invisible suffix", () => {
  const first = eventPage();
  assert.equal(integrity.validateEventSyncPage(first, 10).next_position, 15);

  const terminal = eventPage({
    frames: [eventFrame(18)],
    cursor: "signed-terminal",
    has_more: false,
    range: range("events", {
      from_position: 15,
      next_position: 20,
      through_position: 20,
      first_item_position: 18,
      last_item_position: 18,
      item_count: 1,
      has_more: false,
      complete_through: true,
    }),
  });
  assert.equal(integrity.validateEventSyncPage(terminal, 15, 20).next_position, 20);
});

test("event vector coverage accepts a later commit below the prior numeric maximum", () => {
  const start = { floor: 0, writers: { "writer-a": 5, "writer-b": 5 } };
  const afterB = { floor: 0, writers: { "writer-a": 5, "writer-b": 11 } };
  const first = eventPage({
    frames: [eventFrame(11)],
    has_more: false,
    range: null,
    vector_range: {
      version: 1,
      stream: "events",
      from: start,
      next: afterB,
      through: afterB,
      items: [{ writer: "writer-b", position: 11 }],
      item_count: 1,
      has_more: false,
      complete_through: true,
      coverage: "authoritative_projection",
    },
  });
  const firstRange = integrity.validateEventSyncPage(
    first, 0, undefined, start, undefined,
  );
  assert.deepEqual(firstRange.next_vector, afterB);

  const afterA = { floor: 0, writers: { "writer-a": 10, "writer-b": 11 } };
  const second = eventPage({
    frames: [eventFrame(10)],
    has_more: false,
    range: null,
    vector_range: {
      version: 1,
      stream: "events",
      from: afterB,
      next: afterA,
      through: afterA,
      items: [{ writer: "writer-a", position: 10 }],
      item_count: 1,
      has_more: false,
      complete_through: true,
      coverage: "authoritative_projection",
    },
  });
  const secondRange = integrity.validateEventSyncPage(
    second, 0, undefined, afterB, undefined,
  );
  assert.deepEqual(secondRange.next_vector, afterA);
  assert.equal(secondRange.last_item_position, 10);
});

test("event vector checkpoint commits atomically and rejects a scalar stale writer", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const owner = `carbon:vector-${Date.now()}`;
  const afterB = { floor: 0, writers: { "writer-a": 5, "writer-b": 11 } };
  const checkpoint = {
    event: "event-after-b",
    account: "account-zero",
    eventPosition: 0,
    eventVector: afterB,
    accountPosition: 0,
  };
  await store.writeSyncCheckpoint(owner, checkpoint);
  assert.deepEqual(await store.readSyncCheckpoint(owner), checkpoint);

  const afterA = { floor: 0, writers: { "writer-a": 10, "writer-b": 11 } };
  const advanced = { ...checkpoint, event: "event-after-a", eventVector: afterA };
  await store.storeEvents(owner, [], advanced, undefined, undefined, checkpoint);
  assert.deepEqual(await store.readSyncCheckpoint(owner), advanced);

  await assert.rejects(
    store.storeEvents(
      owner,
      [],
      { ...advanced, event: "bad-scalar", eventVector: undefined },
      undefined,
      undefined,
      { ...advanced, eventVector: undefined },
    ),
    /changed concurrently/,
  );
});

test("sync coverage fails closed on discontinuity and malformed progress", () => {
  assert.throws(
    () => integrity.validateEventSyncPage(eventPage(), 9),
    (error) => error instanceof integrity.SyncIntegrityError &&
      error.reason === "position_discontinuity",
  );
  assert.throws(
    () => integrity.validateEventSyncPage(eventPage(), 10, 21),
    /changed its fixed high-water position/,
  );
  assert.throws(
    () => integrity.validateEventSyncPage(eventPage({
      frames: [eventFrame(15), eventFrame(12)],
    }), 10),
    /not strictly commit ordered/,
  );
  assert.throws(
    () => integrity.validateEventSyncPage(eventPage({
      range: range("events", { item_count: 99 }),
    }), 10),
    /item count/,
  );
  assert.throws(
    () => integrity.validateEventSyncPage(eventPage({
      frames: [],
      range: range("events", {
        first_item_position: null,
        last_item_position: null,
        item_count: 0,
      }),
    }), 10),
    /empty sync page cannot require/i,
  );
  assert.throws(
    () => integrity.validateEventSyncPage(eventPage({
      range: range("events", { next_position: 16 }),
    }), 10),
    /does not cover its last item/,
  );
  for (const [field, value] of [["cursor", "  \n"], ["through", "\t"]]) {
    assert.throws(
      () => integrity.validateEventSyncPage(eventPage({ [field]: value }), 10),
      /signed.*cursor/i,
      `whitespace-only ${field} is not a signed token`,
    );
  }
});

test("account coverage is exactly contiguous, including an empty terminal page", () => {
  const page = {
    updates: [accountUpdate(11), accountUpdate(12)],
    cursor: "account-next",
    through: "account-through",
    has_more: true,
    range: range("account", {
      next_position: 12,
      first_item_position: 11,
      last_item_position: 12,
    }),
  };
  assert.equal(integrity.validateAccountSyncPage(page, 10).next_position, 12);
  const operation = clientOperation();
  const operationUpdate = {
    ...accountUpdate(11),
    kind: "client.operation",
    room_id: operation.room_id,
    object_id: operation.operation_id,
    data: operation,
  };
  assert.doesNotThrow(() => integrity.validateAccountSyncPage({
    ...page,
    updates: [operationUpdate],
    has_more: false,
    range: range("account", {
      next_position: 11, through_position: 11,
      first_item_position: 11, last_item_position: 11,
      item_count: 1, has_more: false, complete_through: true,
    }),
  }, 10, 11));
  assert.throws(
    () => integrity.validateAccountSyncPage({
      ...page,
      updates: [{ ...operationUpdate, data: { ...operation, client_id: "" } }],
    }, 10),
    /client operation is malformed/,
  );
  const preferenceUpdate = {
    ...accountUpdate(11),
    kind: "room.list_preferences",
    data: {
      room_id: "room-1",
      preferences: { pinned: true, archived: false },
    },
  };
  assert.doesNotThrow(() => integrity.validateAccountSyncPage({
    ...page,
    updates: [preferenceUpdate],
    has_more: false,
    range: range("account", {
      next_position: 11,
      through_position: 11,
      first_item_position: 11,
      last_item_position: 11,
      item_count: 1,
      has_more: false,
      complete_through: true,
    }),
  }, 10, 11));
  assert.throws(
    () => integrity.validateAccountSyncPage({
      ...page,
      updates: [{ ...preferenceUpdate, data: {
        room_id: "room-1",
        preferences: { pinned: 1, archived: false },
      } }],
    }, 10),
    /preferences are malformed/,
  );
  assert.throws(
    () => integrity.validateAccountSyncPage({
      ...page,
      updates: [accountUpdate(11), accountUpdate(13)],
      range: { ...page.range, next_position: 13, last_item_position: 13 },
    }, 10),
    /skipped or repeated/,
  );
  assert.throws(
    () => integrity.validateAccountSyncPage({
      updates: [],
      cursor: "terminal",
      through: "through",
      has_more: false,
      range: range("account", {
        from_position: 10,
        next_position: 12,
        through_position: 12,
        first_item_position: null,
        last_item_position: null,
        item_count: 0,
        has_more: false,
        complete_through: true,
      }),
    }, 10),
    /skipped a contiguous position range/,
  );
});

test("initial continuity retains the complete event writer vector", () => {
  const vector = { floor: 0, writers: { "writer-a": 10, "writer-b": 11 } };
  assert.deepEqual(
    integrity.validateInitialContinuity({
      event_position: 0,
      event_vector: vector,
      account_position: 7,
      complete_at_barrier: true,
    }).event_vector,
    vector,
  );
  assert.throws(
    () => integrity.validateInitialContinuity({
      event_position: 1,
      event_vector: vector,
      account_position: 7,
      complete_at_barrier: true,
    }),
    /does not match its compatibility position/,
  );
});

test("initial account and notification manifests enforce complete principal semantics", () => {
  const manifest = {
    drafts: [],
    held_sends: [],
    operations: [],
    chat_preferences: { read_receipts_enabled: true },
    devices: [{
      device_id: "web-1",
      platform: "web",
      name: "Browser",
      app_version: "1.0.0",
      capabilities: {
        background_sync: true,
        upload_chunk_size: 1048576,
        codecs: ["opus", "av1"],
        vendor: { name: "browser" },
      },
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:01Z",
      revoked_at: "",
    }],
    blocks: [{
      target_kind: "silicon",
      target_id: "silicon-1",
      created_at: "2026-01-01T00:00:02Z",
    }],
  };
  assert.doesNotThrow(() => integrity.validateInitialAccountManifest(manifest));
  assert.throws(
    () => integrity.validateInitialAccountManifest({ ...manifest, devices: undefined }),
    /account manifests are incomplete/,
  );
  assert.throws(
    () => integrity.validateInitialAccountManifest({ ...manifest, blocks: "missing" }),
    /account manifests are incomplete/,
  );
  assert.throws(
    () => integrity.validateInitialAccountManifest({
      ...manifest,
      devices: [{ ...manifest.devices[0], capabilities: [] }],
    }),
    /malformed row/,
  );
  assert.throws(
    () => integrity.validateInitialAccountManifest({
      ...manifest,
      blocks: [{ ...manifest.blocks[0], target_id: "" }],
    }),
    /malformed row/,
  );
  assert.throws(
    () => integrity.validateInitialAccountManifest({
      ...manifest,
      devices: [manifest.devices[0], { ...manifest.devices[0] }],
    }),
    /repeats an identity/,
  );
  assert.throws(
    () => integrity.validateInitialAccountManifest({
      ...manifest,
      blocks: [manifest.blocks[0], { ...manifest.blocks[0] }],
    }),
    /repeats an identity/,
  );

  assert.throws(
    () => integrity.validateInitialRoomNotificationProjection({
      ...roomListFields(false),
      observed: false,
      notification_preferences: null,
      unread_boundary: emptyUnreadBoundary(),
    }),
    /member room/,
  );
  for (const observed of [undefined, "false", 0, null]) {
    assert.throws(
      () => integrity.validateInitialRoomNotificationProjection({
        ...roomListFields(false),
        observed,
        notification_preferences: {
          mode: "all",
          mute_until: "",
          show_preview: true,
          sound: true,
        },
        unread_boundary: emptyUnreadBoundary(),
      }),
      /observed membership flag/,
      `observed=${String(observed)} must not be inferred as member state`,
    );
  }
  assert.doesNotThrow(
    () => integrity.validateInitialRoomNotificationProjection({
      ...roomListFields(true),
      observed: true,
      notification_preferences: null,
      unread_boundary: emptyUnreadBoundary(),
    }),
  );
  assert.throws(
    () => integrity.validateInitialRoomNotificationProjection({
      ...roomListFields(true),
      observed: true,
      notification_preferences: {
        mode: "all",
        mute_until: "",
        show_preview: true,
        sound: true,
      },
      unread_boundary: emptyUnreadBoundary(),
    }),
    /observed room/,
  );
});

function emptyUnreadBoundary() {
  return {
    last_read_stream_position: 7,
    first_unread_event_id: null,
    first_unread_stream_position: null,
    unread_count: 0,
    through_stream_position: 7,
  };
}

function roomListFields(observed) {
  return {
    last_event: null,
    list_preferences: observed ? null : { pinned: false, archived: false },
    list_projection: {
      version: 1,
      complete: true,
      through_stream_position: 7,
      activity_stream_position: 0,
      activity_at: "",
      draft: { active: false, version: 0, updated_at: "" },
      held: { active_count: 0, attention_count: 0, next_release_at: "" },
    },
  };
}

test("unread boundary is complete, paired, and constrained to its fixed barrier", () => {
  const valid = {
    last_read_stream_position: 7,
    first_unread_event_id: "01K00000000000000000000000",
    first_unread_stream_position: 8,
    unread_count: 3,
    through_stream_position: 10,
  };
  assert.doesNotThrow(() => integrity.validateUnreadBoundary(valid));
  assert.throws(
    () => integrity.validateUnreadBoundary({ ...valid, first_unread_event_id: null }),
    /inconsistent first-unread anchor/,
  );
  assert.throws(
    () => integrity.validateUnreadBoundary({ ...valid, first_unread_stream_position: 7 }),
    /inconsistent first-unread anchor/,
  );
  assert.throws(
    () => integrity.validateUnreadBoundary({ ...valid, through_stream_position: 6 }),
    /invalid positions/,
  );
  assert.throws(
    () => integrity.validateUnreadBoundary({ ...valid, unread_count: 0 }),
    /inconsistent first-unread anchor/,
  );
});

test("room list projection is complete, bounded, and agrees with last-event identity", () => {
  const last = {
    event_id: "01K00000000000000000000000",
    preview: "hello",
    at: "2026-07-12T00:00:00Z",
    sender_handle: "alice",
    sender_kind: "carbon",
    type: "m.text",
    read: false,
    stream_position: 9,
  };
  const valid = {
    version: 1,
    complete: true,
    through_stream_position: 10,
    activity_stream_position: 9,
    activity_at: last.at,
    draft: { active: false, version: 0, updated_at: "" },
    held: { active_count: 2, attention_count: 1, next_release_at: "" },
  };
  assert.doesNotThrow(() => integrity.validateRoomListProjection(valid, last));
  assert.throws(
    () => integrity.validateRoomListProjection({ ...valid, activity_stream_position: 11 }, last),
    /invalid activity coverage/,
  );
  assert.throws(
    () => integrity.validateRoomListProjection({
      ...valid,
      draft: { active: true, version: 0, updated_at: "" },
    }, last),
    /invalid draft state/,
  );
  assert.throws(
    () => integrity.validateRoomListProjection({
      ...valid,
      held: { active_count: 1, attention_count: 2, next_release_at: "" },
    }, last),
    /invalid held-send state/,
  );
  assert.throws(
    () => integrity.validateRoomListProjection({ ...valid, activity_stream_position: 8 }, last),
    /disagrees with its last event/,
  );
});

test("history traversal keeps one high-water and rejects duplicate pages", () => {
  let traversal = { throughEventId: undefined, seenEventIds: new Set() };
  const newest = "00000000000000000000000003";
  traversal = integrity.validateHistoryPage({
    events: [eventFrame(1, "00000000000000000000000002").event],
    cursor: "older",
    has_more: true,
    direction: "backward",
    through_event_id: newest,
  }, traversal, "room-1");
  assert.throws(
    () => integrity.validateHistoryPage({
      events: [eventFrame(1, "00000000000000000000000002").event],
      cursor: null,
      has_more: false,
      direction: "backward",
      through_event_id: newest,
    }, traversal, "room-1"),
    /repeated an event/,
  );
  assert.throws(
    () => integrity.validateHistoryPage({
      events: [eventFrame(1, "00000000000000000000000001").event],
      cursor: null,
      has_more: false,
      direction: "backward",
      through_event_id: "00000000000000000000000004",
    }, traversal, "room-1"),
    /high-water event changed/,
  );
  assert.throws(
    () => integrity.validateHistoryPage({
      events: [eventFrame(1, "00000000000000000000000003").event],
      cursor: null,
      has_more: false,
      direction: "backward",
      through_event_id: newest,
    }, traversal, "room-1"),
    /previous boundary/,
  );
});

test("only explicit recoverable cursor evidence clears a remote checkpoint", () => {
  const retention = recovery.classifySyncFailure(new ApiError(410, {
    code: "resync_required",
    gap: {
      stream: "account",
      reason: "retention_floor",
      requested_position: 4,
      minimum_position: 8,
      current_position: 12,
    },
  }, "expired"));
  assert.deepEqual(retention, {
    action: "resnapshot",
    reason: "retention_floor",
    stream: "account",
    details: { expectedPosition: 8, observedPosition: 4, throughPosition: 12 },
  });

  assert.equal(
    recovery.classifySyncFailure(new ApiError(503, {}, "unavailable")).action,
    "retry",
  );
  assert.equal(
    recovery.classifySyncFailure(new ApiError(410, { code: "resync_required" }, "ambiguous")).action,
    "retry",
    "an unstructured 410 cannot authorize destructive checkpoint recovery",
  );
  assert.deepEqual(
    recovery.classifySyncFailure(new ApiError(410, {
      code: "resync_required",
      gap: {
        stream: "initial",
        reason: "cursor_expired",
        requested_position: null,
        minimum_position: null,
        current_position: null,
      },
    }, "initial page expired")),
    {
      action: "resnapshot",
      reason: "invalid_cursor",
      stream: "initial",
      details: {
        expectedPosition: undefined,
        observedPosition: undefined,
        throughPosition: undefined,
      },
    },
  );
});

test("resnapshot authorization exhaustively rejects malformed or contradictory 410 evidence", () => {
  const valid = [
    {
      name: "event retention floor",
      body: {
        code: "resync_required",
        gap: {
          stream: "events",
          reason: "retention_floor",
          requested_position: 4,
          minimum_position: 5,
          current_position: 9,
        },
      },
      reason: "retention_floor",
    },
    {
      name: "account cursor ahead",
      body: {
        code: "resync_required",
        gap: {
          stream: "account",
          reason: "cursor_ahead",
          requested_position: 10,
          minimum_position: 2,
          current_position: 9,
        },
      },
      reason: "invalid_cursor",
    },
    {
      name: "account position gap",
      body: {
        code: "resync_required",
        gap: {
          stream: "account",
          reason: "position_gap",
          requested_position: 5,
          minimum_position: 2,
          current_position: 9,
        },
      },
      reason: "position_discontinuity",
    },
    {
      name: "event page invariant",
      body: {
        code: "resync_required",
        gap: {
          stream: "events",
          reason: "page_invariant",
          requested_position: 5,
          minimum_position: 2,
          current_position: 9,
        },
      },
      reason: "position_discontinuity",
    },
    {
      name: "initial cursor expiry",
      body: {
        code: "resync_required",
        gap: {
          stream: "initial",
          reason: "cursor_expired",
          requested_position: null,
          minimum_position: null,
          current_position: null,
        },
      },
      reason: "invalid_cursor",
    },
  ];
  for (const row of valid) {
    const decision = recovery.validateResyncEvidence(410, row.body);
    assert.equal(decision?.action, "resnapshot", row.name);
    assert.equal(decision?.reason, row.reason, row.name);
  }

  const retention = valid[0].body;
  const numericGap = (overrides = {}) => ({
    code: "resync_required",
    gap: {
      stream: "events",
      reason: "retention_floor",
      requested_position: 4,
      minimum_position: 5,
      current_position: 9,
      ...overrides,
    },
  });
  const invalid = [
    ["wrong status", 400, retention],
    ["transient status", 503, retention],
    ["null root", 410, null],
    ["array root", 410, []],
    ["missing code", 410, { gap: retention.gap }],
    ["wrong code", 410, { ...retention, code: "invalid_cursor" }],
    ["missing gap", 410, { code: "resync_required" }],
    ["array gap", 410, { code: "resync_required", gap: [] }],
    ["unknown stream", 410, numericGap({ stream: "future" })],
    ["unknown reason", 410, numericGap({ reason: "future" })],
    ["initial numeric reason", 410, numericGap({ stream: "initial" })],
    ["event cursor expiry", 410, {
      code: "resync_required",
      gap: {
        stream: "events",
        reason: "cursor_expired",
        requested_position: null,
        minimum_position: null,
        current_position: null,
      },
    }],
    ["initial positions missing", 410, {
      code: "resync_required",
      gap: { stream: "initial", reason: "cursor_expired" },
    }],
    ["initial requested non-null", 410, {
      code: "resync_required",
      gap: {
        stream: "initial",
        reason: "cursor_expired",
        requested_position: 0,
        minimum_position: null,
        current_position: null,
      },
    }],
    ["missing requested", 410, {
      code: "resync_required",
      gap: {
        stream: "events",
        reason: "retention_floor",
        minimum_position: 5,
        current_position: 9,
      },
    }],
    ["missing minimum", 410, {
      code: "resync_required",
      gap: {
        stream: "events",
        reason: "retention_floor",
        requested_position: 4,
        current_position: 9,
      },
    }],
    ["missing current", 410, {
      code: "resync_required",
      gap: {
        stream: "events",
        reason: "retention_floor",
        requested_position: 4,
        minimum_position: 5,
      },
    }],
    ["string position", 410, numericGap({ requested_position: "4" })],
    ["null numeric position", 410, numericGap({ requested_position: null })],
    ["boolean position", 410, numericGap({ requested_position: true })],
    ["fractional position", 410, numericGap({ requested_position: 4.5 })],
    ["negative position", 410, numericGap({ requested_position: -1 })],
    ["unsafe position", 410, numericGap({ current_position: Number.MAX_SAFE_INTEGER + 1 })],
    ["minimum beyond current", 410, numericGap({ minimum_position: 10 })],
    ["retention equal floor", 410, numericGap({ requested_position: 5 })],
    ["retention above floor", 410, numericGap({ requested_position: 6 })],
    ["cursor ahead equal current", 410, numericGap({
      reason: "cursor_ahead",
      requested_position: 9,
      minimum_position: 2,
    })],
    ["cursor ahead below current", 410, numericGap({
      reason: "cursor_ahead",
      requested_position: 8,
      minimum_position: 2,
    })],
    ["position gap below minimum", 410, numericGap({
      reason: "position_gap",
      requested_position: 1,
      minimum_position: 2,
    })],
    ["position gap above current", 410, numericGap({
      reason: "position_gap",
      requested_position: 10,
      minimum_position: 2,
    })],
    ["page invariant below minimum", 410, numericGap({
      reason: "page_invariant",
      requested_position: 1,
      minimum_position: 2,
    })],
    ["page invariant above current", 410, numericGap({
      reason: "page_invariant",
      requested_position: 10,
      minimum_position: 2,
    })],
  ];
  for (const [name, status, body] of invalid) {
    assert.equal(recovery.validateResyncEvidence(status, body), null, name);
    assert.equal(
      recovery.classifySyncFailure(new ApiError(status, body, name)).action,
      "retry",
      name,
    );
  }

  assert.equal(
    recovery.classifySyncFailure(new integrity.SyncIntegrityError(
      "events",
      "page_invariant",
      "locally malformed page",
    )).action,
    "resnapshot",
    "a locally proven page invariant authorizes clean remote projection recovery",
  );

  assert.deepEqual(
    recovery.classifySyncFailure(new ApiError(400, {
      detail: "signed cursor cannot be decoded",
      code: "invalid_cursor",
    }, "invalid"), "account"),
    {
      action: "resnapshot",
      reason: "invalid_cursor",
      stream: "account",
      details: {},
    },
  );
  for (const [name, status, body] of [
    ["invalid cursor wrong status", 401, { code: "invalid_cursor" }],
    ["invalid cursor missing code", 400, { detail: "invalid_cursor" }],
    ["invalid cursor wrong code", 400, { code: "cursor_invalid" }],
    ["invalid cursor cannot carry a gap", 400, { code: "invalid_cursor", gap: null }],
    ["invalid cursor non-object", 400, "invalid_cursor"],
    ["invalid cursor array", 400, [{ code: "invalid_cursor" }]],
  ]) {
    assert.equal(
      recovery.classifySyncFailure(new ApiError(status, body, name)).action,
      "retry",
      name,
    );
  }
});

test("diagnostics survive checkpoint-only resnapshot and invalid pages never advance it", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const cursors = await import("../../src/lib/sync-cursors.ts");
  const outbox = await import("../../src/lib/outbox.ts");
  const media = await import("../../src/lib/media-upload-store.ts");
  const owner = `carbon:gap-${Date.now()}`;
  window.localStorage.setItem(`draft-proof:${owner}`, "exact composer text  ");
  await outbox.enqueueOutbox(owner, {
    roomId: "room-1",
    clientId: "preserved-outbox",
    type: "m.text",
    body: "never discard me during history repair",
    at: Date.now(),
  });
  await media.stageMediaUpload({
    ownerId: owner,
    roomId: "room-1",
    clientId: "preserved-media",
    outboxClientId: "preserved-outbox",
    name: "proof.txt",
    mime: "text/plain",
    kind: "file",
    size: 5,
    blob: new Blob(["proof"], { type: "text/plain" }),
  });
  await cursors.setSyncCheckpoint(owner, {
    event: "event-10",
    account: "account-7",
    eventPosition: 10,
    accountPosition: 7,
  });

  assert.throws(
    () => integrity.validateEventSyncPage(eventPage(), 11),
    /durable checkpoint/,
  );
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), {
    event: "event-10",
    account: "account-7",
    eventPosition: 10,
    accountPosition: 7,
  });

  await store.writeSyncRecovery(owner, {
    phase: "rebuilding",
    reason: "position_discontinuity",
    stream: "events",
    details: { expectedPosition: 11, observedPosition: 10 },
  });
  await cursors.clearSyncCursors(owner);
  assert.equal(await cursors.getSyncCheckpoint(owner), null);
  assert.equal((await outbox.listOutbox(owner))[0].clientId, "preserved-outbox");
  assert.equal((await media.readMediaUpload(owner, "preserved-media")).size, 5);
  assert.equal(window.localStorage.getItem(`draft-proof:${owner}`), "exact composer text  ");
  const diagnostic = await store.readSyncRecovery(owner);
  assert.equal(diagnostic.phase, "rebuilding");
  assert.equal(diagnostic.reason, "position_discontinuity");
  assert.deepEqual(diagnostic.details, { expectedPosition: 11, observedPosition: 10 });
});

test("a stale recovery acknowledgement cannot hide a newer gap", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const owner = `carbon:gap-cas-${Date.now()}`;
  const old = await store.writeSyncRecovery(owner, {
    phase: "degraded",
    reason: "transient_failure",
    stream: "history",
  });
  const current = await store.writeSyncRecovery(owner, {
    phase: "rebuilding",
    reason: "position_discontinuity",
    stream: "account",
    details: { expectedPosition: 9, observedPosition: 11 },
  });
  const resolution = await store.resolveSyncRecovery(owner, old.revision);
  assert.equal(resolution.updatedAt, current.updatedAt);
  assert.equal(resolution.phase, "rebuilding");
  assert.equal((await store.readSyncRecovery(owner)).stream, "account");
});
