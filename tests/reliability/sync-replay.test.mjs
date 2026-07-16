import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

function event(position, id = String(position).padStart(26, "0")) {
  return {
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
    created_at: `2026-01-01T00:00:${String(position).padStart(2, "0")}Z`,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

function room(roomId = "room-1") {
  return {
    room_id: roomId,
    kind: "direct",
    team: null,
    team_slug: null,
    peer_kinds: ["carbon"],
    peers: [],
    unread: false,
    unread_count: 0,
    unread_boundary: {
      last_read_stream_position: 0,
      first_unread_event_id: null,
      first_unread_stream_position: null,
      unread_count: 0,
      through_stream_position: 0,
    },
    list_preferences: { pinned: false, archived: false },
    list_projection: {
      version: 1,
      complete: true,
      through_stream_position: 0,
      activity_stream_position: 0,
      activity_at: "",
      draft: { active: false, version: 0, updated_at: "" },
      held: { active_count: 0, attention_count: 0, next_release_at: "" },
    },
    observed: false,
    last_event: null,
    name: "Reliable room",
    topic: "",
    settings: {},
    security_mode: "server_managed",
    security_version: 1,
    security_frozen_at: null,
    created_by_kind: "carbon",
    created_by_id: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    notification_preferences: {
      mode: "all",
      mute_until: "",
      show_preview: true,
      sound: true,
    },
  };
}

function accountManifest(overrides = {}) {
  return {
    drafts: [],
    held_sends: [],
    operations: [],
    devices: [],
    blocks: [],
    chat_preferences: { read_receipts_enabled: true },
    ...overrides,
  };
}

function deviceRecord(deviceId = "web-device") {
  return {
    device_id: deviceId,
    platform: "web",
    name: "Browser",
    app_version: "1.0.0",
    capabilities: {
      background_sync: true,
      upload_chunk_size: 1048576,
      codecs: ["opus", "av1"],
    },
    created_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:01Z",
    revoked_at: "",
  };
}

function blockRecord() {
  return {
    target_kind: "silicon",
    target_id: "silicon-1",
    created_at: "2026-01-01T00:00:02Z",
  };
}

function held(position, id = "held-1") {
  return {
    position,
    kind: "held_send",
    room_id: "room-1",
    object_id: id,
    data: {
      held_send_id: id,
      room_id: "room-1",
      client_id: `client-${id}`,
      state: "pending",
      updated_at: "2026-01-01T00:00:08Z",
      created_at: "2026-01-01T00:00:08Z",
    },
    created_at: "2026-01-01T00:00:08Z",
  };
}

function receipt(position) {
  return {
    position,
    kind: "read_receipt",
    room_id: "room-1",
    object_id: "carbon:peer",
    data: {
      room_id: "room-1",
      member_kind: "carbon",
      member_id: 2,
      member_handle: "peer",
      event_id: "00000000000000000000000012",
      deliveries: {},
    },
    created_at: "2026-01-01T00:00:09Z",
  };
}

test("account replay is atomic with cursors and blocks every newer page until projection", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const cursors = await import("../../src/lib/sync-cursors.ts");
  const owner = `replay-${Date.now()}`;
  const base = {
    event: "event-10",
    account: "account-7",
    eventPosition: 10,
    accountPosition: 7,
  };
  await cursors.setSyncCheckpoint(owner, base);
  const next = {
    event: "event-12",
    account: "account-9",
    eventPosition: 12,
    accountPosition: 9,
  };
  const replay = {
    fromPosition: 7,
    nextPosition: 9,
    throughPosition: 9,
    updates: [held(8), receipt(9)],
    eventPage: {
      cursor: "event-12",
      fromPosition: 10,
      nextPosition: 12,
      eventIds: ["00000000000000000000000012"],
    },
  };

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    store.storeEvents(
      owner,
      [{ roomId: "room-1", event: event(12) }],
      next,
      replay,
      aborted.signal,
      base,
    ),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), base);
  assert.equal(await store.readPendingAccountReplay(owner), null);

  // Simulated crash after cursor/event commit but before any UI projection.
  await store.storeEvents(
    owner,
    [{ roomId: "room-1", event: event(12) }],
    next,
    replay,
    undefined,
    base,
  );
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), next);
  const afterRestart = await store.readPendingAccountReplay(owner);
  assert.deepEqual(afterRestart.updates.map((update) => update.kind), [
    "held_send",
    "read_receipt",
  ]);

  // Projection failure leaves the marker and refuses a newer cursor page.
  assert.equal(await store.commitPendingAccountProjection(owner, 10), "mismatch");
  assert.ok(await store.readPendingAccountReplay(owner));
  await assert.rejects(
    store.storeEvents(owner, [], {
      ...next,
      event: "event-13",
      eventPosition: 13,
    }, undefined, undefined, next),
    /replay must finish/,
  );

  assert.equal(await store.commitPendingAccountProjection(owner, 9), "committed");
  assert.equal(await store.readPendingAccountReplay(owner), null);
  const projections = await store.readAccountProjections(owner);
  assert.deepEqual(projections.map((update) => update.kind), [
    "held_send",
    "read_receipt",
  ]);
  assert.equal(projections[0].data.held_send_id, "held-1");
  assert.equal(projections[1].data.event_id, "00000000000000000000000012");

  await store.storeEvents(owner, [], {
    ...next,
    event: "event-13",
    eventPosition: 13,
  }, undefined, undefined, next);
  assert.equal((await cursors.getSyncCheckpoint(owner)).eventPosition, 13);
});

test("initial snapshot bundle swaps atomically, replaces stale events and held manifests", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const cursors = await import("../../src/lib/sync-cursors.ts");
  const owner = `initial-${Date.now()}`;
  await store.storeEvents(owner, [{ roomId: "stale-room", event: event(1) }]);

  const checkpoint = {
    event: "initial-event-20",
    account: "initial-account-10",
    eventPosition: 20,
    accountPosition: 10,
  };
  const accountData = accountManifest({
    held_sends: [held(10, "held-active").data],
  });
  await store.commitInitialSyncBundle(owner, {
    rooms: [room()],
    accountData,
    events: [{ roomId: "room-1", event: event(20) }],
    checkpoint,
  });

  // Crash-before-UI-swap: the next process can recover the complete room,
  // account manifest, event bytes and matching numeric cursor from IndexedDB.
  const recovered = await store.readInitialSyncBundle(owner);
  assert.equal(recovered.rooms[0].room_id, "room-1");
  assert.equal(recovered.accountData.held_sends[0].held_send_id, "held-active");
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), checkpoint);
  assert.deepEqual(
    (await store.loadStoredRoomEvents(owner, "room-1")).map((row) => row.event_id),
    ["00000000000000000000000020"],
  );
  assert.deepEqual(await store.loadStoredRoomEvents(owner, "stale-room"), []);

  const replacement = {
    ...checkpoint,
    event: "initial-event-21",
    account: "initial-account-11",
    eventPosition: 21,
    accountPosition: 11,
  };
  const interrupted = new AbortController();
  interrupted.abort();
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      rooms: [room("replacement-room")],
      accountData: { ...accountData, held_sends: [] },
      events: [{ roomId: "replacement-room", event: event(21) }],
      checkpoint: replacement,
    }, interrupted.signal),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), checkpoint);
  assert.equal((await store.readInitialSyncBundle(owner)).rooms[0].room_id, "room-1");
  assert.deepEqual(
    (await store.loadStoredRoomEvents(owner, "room-1")).map((row) => row.event_id),
    ["00000000000000000000000020"],
    "projection bytes cannot commit without their matching checkpoint",
  );

  await store.commitInitialSyncBundle(owner, {
    rooms: [room()],
    accountData: { ...accountData, held_sends: [] },
    events: [{ roomId: "room-1", event: event(21) }],
    checkpoint: replacement,
  });
  assert.equal(
    (await store.readAccountProjections(owner)).some(
      (update) => update.kind === "held_send" && update.object_id === "held-active",
    ),
    false,
    "an absent authoritative held send cannot resurrect from the old projection",
  );
  assert.deepEqual(
    (await store.loadStoredRoomEvents(owner, "room-1")).map((row) => row.event_id),
    ["00000000000000000000000021"],
  );
});

test("initial manifests and member notification preferences fail closed before DB replacement", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const owner = `initial-contract-${Date.now()}`;
  const checkpoint = {
    event: "initial-event-30",
    account: "initial-account-30",
    eventPosition: 30,
    accountPosition: 30,
  };
  const input = {
    rooms: [room()],
    accountData: accountManifest(),
    events: [{ roomId: "room-1", event: event(30) }],
    checkpoint,
  };
  await store.commitInitialSyncBundle(owner, input);

  const missingDevices = accountManifest();
  delete missingDevices.devices;
  await assert.rejects(
    store.commitInitialSyncBundle(owner, { ...input, accountData: missingDevices }),
    /account manifests are incomplete/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      accountData: accountManifest({ blocks: {} }),
    }),
    /account manifests are incomplete/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      accountData: accountManifest({ devices: [{ device_id: "missing-fields" }] }),
    }),
    /malformed row/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      accountData: accountManifest({
        devices: [deviceRecord(), deviceRecord()],
      }),
    }),
    /repeats an identity/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      accountData: accountManifest({
        blocks: [blockRecord(), { ...blockRecord() }],
      }),
    }),
    /repeats an identity/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      accountData: accountManifest({
        blocks: [{
          target_kind: "system",
          target_id: "invalid-kind",
          created_at: "2026-01-01T00:00:00Z",
        }],
      }),
    }),
    /malformed row/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      rooms: [{ ...room(), notification_preferences: null }],
    }),
    /member room/,
  );
  await assert.rejects(
    store.commitInitialSyncBundle(owner, {
      ...input,
      rooms: [{ ...room(), observed: true }],
    }),
    /observed room/,
  );

  const durable = await store.readInitialSyncBundle(owner);
  assert.deepEqual(durable.accountData.devices, []);
  assert.deepEqual(durable.accountData.blocks, []);
  assert.notEqual(durable.rooms[0].notification_preferences, null);

  const observer = {
    ...room("observer-room"),
    observed: true,
    notification_preferences: null,
    list_preferences: null,
  };
  await store.commitInitialSyncBundle(`${owner}-observer`, {
    rooms: [observer],
    accountData: accountManifest(),
    events: [],
    checkpoint: {
      event: "initial-event-observer",
      account: "initial-account-observer",
      eventPosition: 0,
      accountPosition: 0,
    },
  });
  assert.equal(
    (await store.readInitialSyncBundle(`${owner}-observer`)).rooms[0].notification_preferences,
    null,
  );
});

test("initial draft manifest clears only clean server-synced copies", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  const owner = `draft-manifest-${Date.now()}`;
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: owner }));
  const prefix = `silicon-interface:draft-v2:carbon:${owner}:`;
  storage.setItem(`${prefix}synced-room`, JSON.stringify({
    room_id: "synced-room",
    text: "cleared elsewhere",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 4,
    updated_at: "2026-01-01T00:00:00Z",
    dirty: false,
    focused: false,
    lastServerSyncAt: 100,
  }));
  storage.setItem(`${prefix}unsynced-room`, JSON.stringify({
    room_id: "unsynced-room",
    text: "never uploaded",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 0,
    updated_at: "",
    dirty: true,
    focused: false,
    lastLocalEditAt: 200,
    lastServerSyncAt: 0,
  }));
  const drafts = await import("../../src/lib/drafts.ts");
  assert.equal(
    await drafts.reconcileServerDraftManifest([], ["synced-room", "unsynced-room"]),
    true,
  );
  assert.equal(drafts.getDraft("synced-room"), "");
  assert.equal(drafts.getDraft("unsynced-room"), "never uploaded");
  assert.equal(JSON.parse(storage.getItem(`${prefix}synced-room`)).localClearedAt > 0, true);
  assert.equal(JSON.parse(storage.getItem(`${prefix}unsynced-room`)).dirty, true);
});

test("a superseded connection cannot commit its late page over a new generation", async () => {
  installBrowser();
  const store = await import("../../src/lib/chat-store.ts");
  const cursors = await import("../../src/lib/sync-cursors.ts");
  const owner = `generation-${Date.now()}`;
  const base = {
    event: "event-1",
    account: "account-0",
    eventPosition: 1,
    accountPosition: 0,
  };
  await cursors.setSyncCheckpoint(owner, base);
  const oldGeneration = new AbortController();
  oldGeneration.abort();
  await assert.rejects(
    store.storeEvents(owner, [{ roomId: "room-1", event: event(2) }], {
      ...base,
      event: "old-event-2",
      eventPosition: 2,
    }, undefined, oldGeneration.signal, base),
    (error) => error?.name === "AbortError",
  );
  await store.storeEvents(owner, [{ roomId: "room-1", event: event(3) }], {
    ...base,
    event: "new-event-3",
    eventPosition: 3,
  }, undefined, undefined, base);
  assert.equal((await cursors.getSyncCheckpoint(owner)).event, "new-event-3");
  assert.deepEqual(
    (await store.loadStoredRoomEvents(owner, "room-1")).map((row) => row.event_id),
    ["00000000000000000000000003"],
  );
});
