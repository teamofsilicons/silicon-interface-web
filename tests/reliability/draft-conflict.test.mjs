import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("remote draft conflict is preserved until an explicit choice", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "alice" }));
  storage.setItem("silicon-interface:draft-v2:carbon:alice:room", JSON.stringify({
    room_id: "room",
    text: "local copy",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 3,
    updated_at: "",
    dirty: true,
    focused: true,
    lastLocalEditAt: 1,
    lastServerSyncAt: 0,
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  drafts.applyServerDraft({
    room_id: "room",
    text: "remote copy",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 4,
    updated_at: "2026-07-11T00:00:00Z",
    origin_device: "another-device",
  });

  assert.equal(drafts.getDraft("room"), "local copy");
  drafts.resolveDraftConflict("room", "remote");
  assert.equal(drafts.getDraft("room"), "remote copy");
  const saved = JSON.parse(storage.getItem("silicon-interface:draft-v2:carbon:alice:room"));
  assert.equal(saved.dirty, false);
  assert.equal(saved.pendingRemote, null);
  assert.equal(saved.version, 4);
});

test("an older authored draft re-saved later never prompts over a newer local edit", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "authored-order" }));
  const localAt = Date.parse("2026-07-16T02:00:00Z");
  storage.setItem("silicon-interface:draft-v2:carbon:authored-order:authored-room", JSON.stringify({
    room_id: "authored-room",
    text: "newer local copy",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 3,
    updated_at: "2026-07-16T02:00:01Z",
    content_updated_at: "2026-07-16T02:00:00Z",
    dirty: true,
    lastLocalEditAt: localAt,
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  await drafts.applyServerDraft({
    room_id: "authored-room",
    text: "old remote copy",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 4,
    updated_at: "2026-07-16T03:00:00Z",
    content_updated_at: "2026-07-16T01:00:00Z",
    origin_device: "another-device",
  });

  const saved = JSON.parse(
    storage.getItem("silicon-interface:draft-v2:carbon:authored-order:authored-room"),
  );
  assert.equal(saved.text, "newer local copy");
  assert.equal(saved.pendingRemote, null);
  assert.equal(saved.version, 4);
  assert.equal(saved.dirty, true);
  assert.equal(saved.content_updated_at, "2026-07-16T02:00:00Z");
  await drafts.applyServerDraft({
    ...saved,
    room_id: "authored-room",
    text: "newer remote cleanup",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 5,
    updated_at: "2026-07-16T04:00:00Z",
    content_updated_at: "2026-07-16T04:00:00Z",
    origin_device: "another-device",
  });
});

test("draft prompt requires two non-empty drafts and a gap greater than 30 seconds", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "gap-rule" }));
  const drafts = await import("../../src/lib/drafts.ts");
  const localAt = Date.parse("2026-07-16T02:00:00Z");
  const local = (roomId) => storage.setItem(
    `silicon-interface:draft-v2:carbon:gap-rule:${roomId}`,
    JSON.stringify({
      room_id: roomId,
      text: "local",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 1,
      updated_at: "2026-07-16T02:00:00Z",
      content_updated_at: "2026-07-16T02:00:00Z",
      dirty: true,
      lastLocalEditAt: localAt,
    }),
  );
  const remote = (roomId, text, contentUpdatedAt) => ({
    room_id: roomId,
    text,
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 2,
    updated_at: "2026-07-16T03:00:00Z",
    content_updated_at: contentUpdatedAt,
    origin_device: "another-device",
  });

  local("exact-gap");
  await drafts.applyServerDraft(remote("exact-gap", "remote", "2026-07-16T02:00:30Z"));
  assert.equal(JSON.parse(storage.getItem(
    "silicon-interface:draft-v2:carbon:gap-rule:exact-gap",
  )).pendingRemote, null);

  local("empty-remote");
  await drafts.applyServerDraft(remote("empty-remote", "", "2026-07-16T03:00:00Z"));
  assert.equal(JSON.parse(storage.getItem(
    "silicon-interface:draft-v2:carbon:gap-rule:empty-remote",
  )).pendingRemote, null);

  await drafts.applyServerDraft({
    ...remote("exact-gap", "cleanup", "2026-07-16T04:00:00Z"), version: 3,
  });
  await drafts.applyServerDraft({
    ...remote("empty-remote", "cleanup", "2026-07-16T04:00:00Z"), version: 3,
  });

  local("over-gap");
  await drafts.applyServerDraft(remote("over-gap", "remote", "2026-07-16T02:00:31Z"));
  const prompted = JSON.parse(storage.getItem(
    "silicon-interface:draft-v2:carbon:gap-rule:over-gap",
  ));
  assert.equal(prompted.pendingRemote.text, "remote");
  assert.equal(prompted.syncBlocked, true);
});

test("auto-focus does not turn a clean remote clear into a conflict", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "focused-clean" }));
  storage.setItem("silicon-interface:draft-v2:carbon:focused-clean:focused-room", JSON.stringify({
    room_id: "focused-room",
    text: "previously synced",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 8,
    updated_at: "2026-07-14T00:00:00Z",
    dirty: false,
    focused: false,
    lastLocalEditAt: 1,
    lastServerSyncAt: 1,
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  drafts.setDraftFocused("focused-room", true); // Composer is auto-focused on mount.
  await drafts.applyServerDraft({
    room_id: "focused-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 9,
    updated_at: "2026-07-15T00:00:00Z",
    cleared_at: "2026-07-15T00:00:00Z",
    origin_device: "another-device",
  });

  assert.equal(drafts.getDraft("focused-room"), "");
  assert.equal(drafts.draftSyncStatus("focused-room").dirty, false);
  const saved = JSON.parse(
    storage.getItem("silicon-interface:draft-v2:carbon:focused-clean:focused-room"),
  );
  assert.equal(saved.pendingRemote, null);
  assert.equal(saved.version, 9);
});

test("a persisted focus-only conflict is repaired without reopening the modal", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "legacy-focus" }));
  storage.setItem("silicon-interface:draft-v2:carbon:legacy-focus:legacy-room", JSON.stringify({
    room_id: "legacy-room",
    text: "old clean projection",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 12,
    updated_at: "2026-07-14T00:00:00Z",
    dirty: false,
    focused: false,
    lastLocalEditAt: 1,
    lastServerSyncAt: 1,
    syncBlocked: false,
    pendingRemote: {
      room_id: "legacy-room",
      text: "",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 13,
      updated_at: "2026-07-15T00:00:00Z",
      cleared_at: "2026-07-15T00:00:00Z",
      origin_device: "another-device",
    },
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  assert.equal(drafts.getDraft("legacy-room"), "");
  await drafts.applyServerDraft({
    room_id: "legacy-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 13,
    updated_at: "2026-07-15T00:00:00Z",
    cleared_at: "2026-07-15T00:00:00Z",
    origin_device: "another-device",
  });
  const saved = JSON.parse(
    storage.getItem("silicon-interface:draft-v2:carbon:legacy-focus:legacy-room"),
  );
  assert.equal(saved.pendingRemote, null);
  assert.equal(saved.text, "");
});

test("legacy repair discards an older pending frame without regressing a clean projection", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "stale-pending" }));
  const key = "silicon-interface:draft-v2:carbon:stale-pending:stale-pending-room";
  storage.setItem(key, JSON.stringify({
    room_id: "stale-pending-room",
    text: "newer clean projection",
    selection_start: 22,
    selection_end: 22,
    attachments: [{ id: "new-local-id", mediaId: "media-new", mime: "image/png", name: "new.png" }],
    reply_to_event_id: "event-new",
    reply_to_snapshot: { event_id: "event-new", preview: "new reply" },
    version: 20,
    updated_at: "2026-07-15T00:02:00Z",
    dirty: false,
    focused: false,
    lastLocalEditAt: 1,
    lastServerSyncAt: 2,
    syncBlocked: false,
    pendingRemote: {
      room_id: "stale-pending-room",
      text: "stale pending copy",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 19,
      updated_at: "2026-07-15T00:01:00Z",
      origin_device: "another-device",
    },
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  assert.equal(drafts.getDraft("stale-pending-room"), "newer clean projection");
  assert.equal(drafts.getDraftAttachments("stale-pending-room")[0].mediaId, "media-new");
  assert.equal(drafts.getDraftReply("stale-pending-room").event_id, "event-new");
  // Persist the repaired in-memory snapshot so we can verify every semantic
  // field and the monotonic version, not merely the text projection.
  drafts.setDraftSelection("stale-pending-room", 0, 0);
  const saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.text, "newer clean projection");
  assert.equal(saved.attachments[0].mediaId, "media-new");
  assert.equal(saved.reply_to_event_id, "event-new");
  assert.equal(saved.version, 20);
  assert.equal(saved.updated_at, "2026-07-15T00:02:00Z");
  assert.equal(saved.pendingRemote, null);
});

test("legacy repair discards malformed pending snapshots against a version-zero local", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "malformed-pending" }));
  const prefix = "silicon-interface:draft-v2:carbon:malformed-pending:";
  const validPending = {
    room_id: "",
    text: "remote replacement",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 1,
    updated_at: "2026-07-15T00:03:00Z",
    origin_device: "another-device",
  };
  const cases = [
    {
      roomId: "missing-version",
      pending: { ...validPending, version: undefined },
    },
    {
      roomId: "invalid-text",
      pending: { ...validPending, text: { invalid: true } },
    },
    {
      roomId: "invalid-attachments",
      pending: { ...validPending, attachments: "not-an-array" },
    },
    {
      roomId: "invalid-reply",
      pending: {
        ...validPending,
        reply_to_event_id: "event-remote",
        reply_to_snapshot: { event_id: ["not", "text"] },
      },
    },
  ];
  for (const row of cases) {
    const localText = `local ${row.roomId}`;
    storage.setItem(`${prefix}${row.roomId}`, JSON.stringify({
      room_id: row.roomId,
      text: localText,
      selection_start: localText.length,
      selection_end: localText.length,
      attachments: [{ id: `id-${row.roomId}`, mediaId: `media-${row.roomId}`, mime: "image/png", name: "local.png" }],
      reply_to_event_id: `event-${row.roomId}`,
      reply_to_snapshot: { event_id: `event-${row.roomId}`, preview: "local reply" },
      version: 0,
      updated_at: "",
      dirty: false,
      focused: false,
      lastLocalEditAt: 1,
      lastServerSyncAt: 0,
      syncBlocked: false,
      pendingRemote: { ...row.pending, room_id: row.roomId },
    }));
  }

  const drafts = await import("../../src/lib/drafts.ts");
  for (const row of cases) {
    const localText = `local ${row.roomId}`;
    assert.equal(drafts.getDraft(row.roomId), localText);
    assert.equal(drafts.getDraftAttachments(row.roomId)[0].mediaId, `media-${row.roomId}`);
    assert.equal(drafts.getDraftReply(row.roomId).event_id, `event-${row.roomId}`);
    drafts.setDraftSelection(row.roomId, 0, 0);
    const saved = JSON.parse(storage.getItem(`${prefix}${row.roomId}`));
    assert.equal(saved.text, localText);
    assert.equal(saved.version, 0);
    assert.equal(saved.pendingRemote, null);
  }
});

test("legacy dirty repair drops stale frames, acknowledges matches, and promotes R25 equal conflicts", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "dirty-legacy" }));
  const prefix = "silicon-interface:draft-v2:carbon:dirty-legacy:";
  const rows = [
    { roomId: "stale-explicit", pendingVersion: 19, blocked: true, error: "conflict" },
    { roomId: "equal-non-explicit", pendingVersion: 20, blocked: false, error: undefined },
    { roomId: "equal-matching", pendingVersion: 20, blocked: false, error: undefined, matching: true },
    { roomId: "equal-explicit", pendingVersion: 20, blocked: true, error: "conflict" },
  ];
  for (const row of rows) {
    storage.setItem(`${prefix}${row.roomId}`, JSON.stringify({
      room_id: row.roomId,
      text: `local ${row.roomId}`,
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 20,
      updated_at: "2026-07-15T00:04:00Z",
      dirty: true,
      focused: false,
      lastLocalEditAt: 1,
      lastServerSyncAt: 1,
      syncBlocked: row.blocked,
      syncError: row.error,
      nextSyncAt: Date.now() + 60_000,
      pendingRemote: {
        room_id: row.roomId,
        text: row.matching ? `local ${row.roomId}` : `remote ${row.roomId}`,
        attachments: [],
        reply_to_event_id: "",
        reply_to_snapshot: {},
        version: row.pendingVersion,
        updated_at: "2026-07-15T00:03:00Z",
        origin_device: "another-device",
      },
    }));
  }

  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  api.putDraft = () => new Promise(() => undefined);
  try {
    for (const row of rows) {
      assert.equal(drafts.getDraft(row.roomId), `local ${row.roomId}`);
      drafts.setDraftSelection(row.roomId, 0, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stale = JSON.parse(storage.getItem(`${prefix}stale-explicit`));
    assert.equal(stale.pendingRemote, null);
    assert.equal(stale.syncBlocked, false);
    assert.equal(stale.syncError, undefined);

    const equalNonExplicit = JSON.parse(storage.getItem(`${prefix}equal-non-explicit`));
    assert.equal(equalNonExplicit.pendingRemote.version, 20);
    assert.equal(equalNonExplicit.dirty, true);
    assert.equal(equalNonExplicit.syncBlocked, true);
    assert.equal(equalNonExplicit.syncError, "conflict");

    const equalMatching = JSON.parse(storage.getItem(`${prefix}equal-matching`));
    assert.equal(equalMatching.pendingRemote, null);
    assert.equal(equalMatching.dirty, false);
    assert.equal(equalMatching.syncBlocked, false);

    const equalExplicit = JSON.parse(storage.getItem(`${prefix}equal-explicit`));
    assert.equal(equalExplicit.pendingRemote.version, 20);
    assert.equal(equalExplicit.syncBlocked, true);
    assert.equal(equalExplicit.syncError, "conflict");
  } finally {
    api.putDraft = originalPut;
  }
});

test("same-version replay after Keep this device does not reopen the conflict", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "rebase-user" }));
  storage.setItem("silicon-interface:draft-v2:carbon:rebase-user:rebase-room", JSON.stringify({
    room_id: "rebase-room",
    text: "local unsent edit",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 3,
    updated_at: "",
    dirty: true,
    focused: true,
    lastLocalEditAt: 1,
    lastServerSyncAt: 0,
  }));
  const remote = {
    room_id: "rebase-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 4,
    updated_at: "2026-07-15T00:00:00Z",
    cleared_at: "2026-07-15T00:00:00Z",
    origin_device: "another-device",
  };

  const drafts = await import("../../src/lib/drafts.ts");
  const { api } = await import("../../src/lib/api.ts");
  const originalPut = api.putDraft;
  api.putDraft = () => new Promise(() => {});
  try {
    await drafts.applyServerDraft(remote);
    drafts.resolveDraftConflict("rebase-room", "local");
    await drafts.applyServerDraft(remote); // Initial-load / websocket replay of v4.

    const saved = JSON.parse(
      storage.getItem("silicon-interface:draft-v2:carbon:rebase-user:rebase-room"),
    );
    assert.equal(saved.text, "local unsent edit");
    assert.equal(saved.dirty, true);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.version, 4);

    await drafts.applyServerDraft({ ...remote, version: 5 });
    const newer = JSON.parse(
      storage.getItem("silicon-interface:draft-v2:carbon:rebase-user:rebase-room"),
    );
    assert.equal(newer.pendingRemote, null);
    assert.equal(newer.syncBlocked, false);
    await drafts.applyServerDraft({
      ...remote,
      text: "newer meaningful remote",
      version: 6,
      content_updated_at: "2026-07-15T01:00:00Z",
    });
  } finally {
    api.putDraft = originalPut;
  }
});

test("matching full snapshots acknowledge safely while stale echoes cannot downgrade", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "snapshot-user" }));
  const key = "silicon-interface:draft-v2:carbon:snapshot-user:snapshot-room";
  storage.setItem(key, JSON.stringify({
    room_id: "snapshot-room",
    text: "new local copy",
    attachments: [{ id: "local-stage-1", mediaId: "media-1", mime: "image/png", name: "one.png" }],
    reply_to_event_id: "event-1",
    reply_to_snapshot: {},
    version: 9,
    updated_at: "",
    dirty: true,
    focused: true,
    lastLocalEditAt: 1,
    lastServerSyncAt: 0,
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  const { deviceId } = await import("../../src/lib/device-id.ts");
  const thisDevice = deviceId();
  await drafts.applyServerDraft({
    room_id: "snapshot-room",
    text: "old server copy",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 8,
    updated_at: "2026-07-14T00:00:00Z",
    origin_device: thisDevice,
  });
  let saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.text, "new local copy");
  assert.equal(saved.version, 9);
  assert.equal(saved.dirty, true);
  assert.equal(saved.pendingRemote ?? null, null);

  await drafts.applyServerDraft({
    room_id: "snapshot-room",
    text: "new local copy",
    attachments: [{ media_id: "media-1", mime: "image/png", name: "one.png" }],
    reply_to_event_id: "event-1",
    reply_to_snapshot: {},
    version: 8,
    updated_at: "2026-07-14T00:00:00Z",
    origin_device: thisDevice,
  });
  saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.version, 9);
  assert.equal(saved.dirty, true);
  assert.equal(saved.pendingRemote ?? null, null);

  await drafts.applyServerDraft({
    room_id: "snapshot-room",
    text: "new local copy",
    attachments: [{ media_id: "media-1", mime: "image/png", name: "one.png" }],
    reply_to_event_id: "event-1",
    reply_to_snapshot: {},
    version: 10,
    updated_at: "2026-07-15T00:00:00Z",
    origin_device: thisDevice,
  });
  saved = JSON.parse(storage.getItem(key));
  assert.equal(saved.version, 10);
  assert.equal(saved.dirty, false);
  assert.equal(saved.pendingRemote, null);
  assert.equal(saved.attachments[0].id, "local-stage-1");
});

test("an idempotent 409 acknowledges an already-saved draft without a modal", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "lost-ack-user" }));
  const key = "silicon-interface:draft-v2:carbon:lost-ack-user:lost-ack-room";
  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  api.putDraft = async (roomId, payload) => {
    assert.equal("id" in payload.attachments[0], false);
    throw new ApiError(409, {
      current: {
        room_id: roomId,
        text: payload.text,
        attachments: payload.attachments,
        reply_to_event_id: payload.reply_to_event_id,
        reply_to_snapshot: {},
        version: 1,
        updated_at: "2026-07-15T00:00:00Z",
        origin_device: "another-tab",
      },
    }, "version conflict");
  };
  try {
    await drafts.setDraft("lost-ack-room", "already committed");
    drafts.setDraftAttachments("lost-ack-room", [{
      id: "local-only-stage-id",
      mediaId: "media-2",
      mime: "image/png",
      name: "two.png",
    }]);
    drafts.flushDraft("lost-ack-room");
    await waitFor(() => drafts.draftSyncStatus("lost-ack-room").dirty === false);
    const saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.version, 1);
    assert.equal(saved.pendingRemote ?? null, null);
    assert.equal(saved.syncBlocked ?? false, false);
  } finally {
    api.putDraft = originalPut;
  }
});

test("an already-cleared 409 completes a send clear without a conflict", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "clear-ack-user" }));
  const key = "silicon-interface:draft-v2:carbon:clear-ack-user:clear-ack-room";
  storage.setItem(key, JSON.stringify({
    room_id: "clear-ack-room",
    text: "message being sent",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 1,
    updated_at: "2026-07-15T00:00:00Z",
    dirty: false,
    focused: true,
    lastLocalEditAt: 1,
    lastServerSyncAt: 1,
  }));
  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  api.deleteDraft = async (roomId) => {
    throw new ApiError(409, {
      current: {
        room_id: roomId,
        text: "",
        attachments: [],
        reply_to_event_id: "",
        reply_to_snapshot: {},
        version: 2,
        updated_at: "2026-07-15T00:01:00Z",
        cleared_at: "2026-07-15T00:01:00Z",
        origin_device: "another-tab",
      },
    }, "version conflict");
  };
  try {
    await drafts.clearDraftAfterSend("clear-ack-room");
    await waitFor(() => JSON.parse(storage.getItem(key)).version === 2);
    const saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.text, "");
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.syncBlocked, false);
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("lost pre-send PUT response rebases one matching 409 and clears without a modal", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "lost-put-clear" }));
  const key = "silicon-interface:draft-v2:carbon:lost-put-clear:lost-put-room";
  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  const originalDelete = api.deleteDraft;
  let rejectPut;
  let committed;
  const deleteBases = [];
  api.putDraft = (roomId, payload) => new Promise((resolve, reject) => {
    committed = {
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 1,
      updated_at: "2026-07-15T00:05:00Z",
      origin_device: "this-device",
    };
    rejectPut = reject;
  });
  api.deleteDraft = async (roomId, payload) => {
    deleteBases.push(payload.base_version);
    if (deleteBases.length === 1) {
      throw new ApiError(409, { current: committed }, "lost PUT response");
    }
    return {
      room_id: roomId,
      text: "",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 2,
      updated_at: "2026-07-15T00:06:00Z",
      cleared_at: "2026-07-15T00:06:00Z",
      origin_device: "this-device",
    };
  };
  try {
    await drafts.setDraft("lost-put-room", "already sent");
    drafts.flushDraft("lost-put-room");
    await waitFor(() => typeof rejectPut === "function");
    await drafts.clearDraftAfterSend("lost-put-room");
    const tombstone = JSON.parse(storage.getItem(key));
    assert.equal(tombstone.text, "");
    assert.equal(tombstone.pendingClearAfterSend.text, "already sent");
    assert.equal(tombstone.pendingClearAfterSend.base_version, 0);

    rejectPut(new Error("response lost after commit"));
    await waitFor(() => deleteBases.length === 2 && JSON.parse(storage.getItem(key)).version === 2);
    const saved = JSON.parse(storage.getItem(key));
    assert.deepEqual(deleteBases, [0, 1]);
    assert.equal(saved.text, "");
    assert.equal(saved.pendingClearAfterSend, null);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.syncBlocked, false);
  } finally {
    api.putDraft = originalPut;
    api.deleteDraft = originalDelete;
  }
});

test("a divergent conflict arriving while clear waits for PUT prevents every DELETE attempt", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "wait-race-clear" }));
  const key = "silicon-interface:draft-v2:carbon:wait-race-clear:wait-race-room";
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  const originalDelete = api.deleteDraft;
  let releasePut;
  let deletes = 0;
  api.putDraft = (roomId, payload) => new Promise((resolve) => {
    releasePut = () => resolve({
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 1,
      updated_at: "2026-07-15T00:05:00Z",
      origin_device: "this-device",
    });
  });
  api.deleteDraft = async () => {
    deletes += 1;
    throw new Error("DELETE must remain unauthorized while conflict is pending");
  };
  try {
    await drafts.setDraft("wait-race-room", "message already sent");
    drafts.flushDraft("wait-race-room");
    await waitFor(() => typeof releasePut === "function");
    await drafts.clearDraftAfterSend("wait-race-room");

    await drafts.applyServerDraft({
      room_id: "wait-race-room",
      text: "new divergent remote draft",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 4,
      updated_at: "2026-07-15T00:06:00Z",
      origin_device: "another-device",
    });
    releasePut();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const saved = JSON.parse(storage.getItem(key));
    assert.equal(deletes, 0);
    assert.equal(saved.pendingClearAfterSend.text, "message already sent");
    assert.equal(saved.pendingRemote.text, "new divergent remote draft");
    assert.equal(saved.syncBlocked, true);
    assert.equal(saved.syncError, "conflict");
  } finally {
    api.putDraft = originalPut;
    api.deleteDraft = originalDelete;
  }
});

test("post-send clear preserves a genuinely divergent current draft as a conflict", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "divergent-clear" }));
  const key = "silicon-interface:draft-v2:carbon:divergent-clear:divergent-room";
  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  let deletes = 0;
  api.deleteDraft = async (roomId) => {
    deletes += 1;
    throw new ApiError(409, {
      current: {
        room_id: roomId,
        text: "different unsent draft",
        attachments: [],
        reply_to_event_id: "",
        reply_to_snapshot: {},
        version: 1,
        updated_at: "2026-07-15T00:06:00Z",
        origin_device: "another-device",
      },
    }, "real conflict");
  };
  try {
    await drafts.setDraft("divergent-room", "message that was sent");
    await drafts.clearDraftAfterSend("divergent-room");
    await waitFor(() => drafts.draftSyncStatus("divergent-room").blocked);
    const saved = JSON.parse(storage.getItem(key));
    assert.equal(deletes, 1);
    assert.equal(saved.text, "");
    assert.equal(saved.pendingClearAfterSend.text, "message that was sent");
    assert.equal(saved.pendingRemote.text, "different unsent draft");
    assert.equal(saved.syncError, "conflict");
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("a durable post-send tombstone resumes a lost PUT clear after reload", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "restart-clear" }));
  const key = "silicon-interface:draft-v2:carbon:restart-clear:restart-clear-room";
  storage.setItem(key, JSON.stringify({
    room_id: "restart-clear-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 0,
    updated_at: "",
    dirty: false,
    focused: false,
    lastLocalEditAt: 1,
    localClearedAt: 1,
    lastServerSyncAt: 0,
    pendingClearAfterSend: {
      text: "sent before crash",
      attachments: [],
      reply_to_event_id: "",
      base_version: 0,
    },
  }));
  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  const bases = [];
  api.deleteDraft = async (roomId, payload) => {
    bases.push(payload.base_version);
    if (bases.length === 1) {
      throw new ApiError(409, {
        current: {
          room_id: roomId,
          text: "sent before crash",
          attachments: [],
          reply_to_event_id: "",
          reply_to_snapshot: {},
          version: 1,
          updated_at: "2026-07-15T00:07:00Z",
          origin_device: "this-device",
        },
      }, "lost response");
    }
    return {
      room_id: roomId,
      text: "",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 2,
      updated_at: "2026-07-15T00:08:00Z",
      cleared_at: "2026-07-15T00:08:00Z",
      origin_device: "this-device",
    };
  };
  try {
    assert.equal(drafts.getDraft("restart-clear-room"), "");
    await waitFor(() => bases.length === 2 && JSON.parse(storage.getItem(key)).version === 2);
    const saved = JSON.parse(storage.getItem(key));
    assert.deepEqual(bases, [0, 1]);
    assert.equal(saved.text, "");
    assert.equal(saved.pendingClearAfterSend, null);
    assert.equal(saved.pendingRemote ?? null, null);
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("only a direct DELETE acknowledgement may complete base-zero recovery with empty v0", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "zero-clear" }));
  const unsolicitedKey = "silicon-interface:draft-v2:carbon:zero-clear:unsolicited-zero-room";
  storage.setItem(unsolicitedKey, JSON.stringify({
    room_id: "unsolicited-zero-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 0,
    updated_at: "",
    dirty: false,
    lastLocalEditAt: 1,
    localClearedAt: 1,
    pendingClearAfterSend: {
      text: "sent before v0 clear",
      attachments: [],
      reply_to_event_id: "",
      base_version: 0,
    },
  }));
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  let releaseUnsolicitedDelete;
  const empty = (roomId, version) => ({
    room_id: roomId,
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version,
    updated_at: "2026-07-15T00:09:00Z",
    cleared_at: "2026-07-15T00:09:00Z",
    origin_device: "this-device",
  });
  api.deleteDraft = async (roomId) => {
    if (roomId === "unsolicited-zero-room") {
      return new Promise((resolve) => {
        releaseUnsolicitedDelete = resolve;
      });
    }
    return empty(roomId, 0);
  };
  try {
    assert.equal(drafts.getDraft("unsolicited-zero-room"), "");
    await drafts.applyServerDraft(empty("unsolicited-zero-room", 0));
    let saved = JSON.parse(storage.getItem(unsolicitedKey));
    assert.equal(saved.pendingClearAfterSend.text, "sent before v0 clear");

    await drafts.setDraft("direct-zero-room", "sent directly");
    await drafts.clearDraftAfterSend("direct-zero-room");
    const directKey = "silicon-interface:draft-v2:carbon:zero-clear:direct-zero-room";
    await waitFor(() => JSON.parse(storage.getItem(directKey)).pendingClearAfterSend === null);
    saved = JSON.parse(storage.getItem(directKey));
    assert.equal(saved.text, "");
    assert.equal(saved.syncBlocked, false);

    await waitFor(() => typeof releaseUnsolicitedDelete === "function");
    releaseUnsolicitedDelete(empty("unsolicited-zero-room", 1));
    await waitFor(() => JSON.parse(storage.getItem(unsolicitedKey)).pendingClearAfterSend === null);
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("a persisted divergent clear conflict cannot be deleted by reload, flush, or retry", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "clear-conflict-reload" }));
  const key = "silicon-interface:draft-v2:carbon:clear-conflict-reload:clear-conflict-room";
  storage.setItem(key, JSON.stringify({
    room_id: "clear-conflict-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 4,
    updated_at: "2026-07-15T00:10:00Z",
    dirty: false,
    lastLocalEditAt: 1,
    localClearedAt: 1,
    pendingClearAfterSend: {
      text: "message already sent",
      attachments: [],
      reply_to_event_id: "",
      base_version: 3,
    },
    pendingRemote: {
      room_id: "clear-conflict-room",
      text: "different remote draft",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 4,
      updated_at: "2026-07-15T00:10:00Z",
      origin_device: "another-device",
    },
    syncBlocked: true,
    syncError: "conflict",
  }));
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  let deletes = 0;
  api.deleteDraft = async () => {
    deletes += 1;
    throw new Error("must not delete before explicit choice");
  };
  try {
    assert.equal(drafts.getDraft("clear-conflict-room"), "");
    drafts.flushDraft("clear-conflict-room");
    drafts.retryDraftSync("clear-conflict-room");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const saved = JSON.parse(storage.getItem(key));
    assert.equal(deletes, 0);
    assert.equal(saved.pendingClearAfterSend.text, "message already sent");
    assert.equal(saved.pendingRemote.text, "different remote draft");
    assert.equal(saved.syncBlocked, true);
    assert.equal(saved.syncError, "conflict");
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("a transient DELETE retries automatically and then saves a newer local edit", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "clear-retry" }));
  const key = "silicon-interface:draft-v2:carbon:clear-retry:clear-retry-room";
  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  const originalPut = api.putDraft;
  const originalRandom = Math.random;
  let deletes = 0;
  let puts = 0;
  Math.random = () => 0;
  api.deleteDraft = async (roomId) => {
    deletes += 1;
    if (deletes === 1) throw new ApiError(503, {}, "temporarily unavailable");
    return {
      room_id: roomId,
      text: "",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 1,
      updated_at: "2026-07-15T00:11:00Z",
      cleared_at: "2026-07-15T00:11:00Z",
      origin_device: "this-device",
    };
  };
  api.putDraft = async (roomId, payload) => {
    puts += 1;
    assert.equal(payload.text, "next local edit");
    assert.equal(payload.base_version, 1);
    return {
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 2,
      updated_at: "2026-07-15T00:12:00Z",
      origin_device: "this-device",
    };
  };
  try {
    await drafts.setDraft("clear-retry-room", "message already sent");
    const locallyCleared = drafts.clearDraftAfterSend("clear-retry-room");
    await drafts.setDraft("clear-retry-room", "next local edit");
    await locallyCleared;
    await waitFor(() => drafts.draftSyncStatus("clear-retry-room").attempts === 1);
    let saved = JSON.parse(storage.getItem(key));
    assert.ok(saved.nextSyncAt > 0);
    assert.equal(saved.pendingClearAfterSend.text, "message already sent");
    assert.equal(saved.text, "next local edit");

    await waitFor(
      () => deletes === 2 && puts === 1 && drafts.draftSyncStatus("clear-retry-room").dirty === false,
      3_500,
    );
    saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.pendingClearAfterSend, null);
    assert.equal(saved.text, "next local edit");
    assert.equal(saved.version, 2);
    assert.equal(saved.syncBlocked, false);
  } finally {
    Math.random = originalRandom;
    api.deleteDraft = originalDelete;
    api.putDraft = originalPut;
  }
});

test("recovery ignores base-context frames and clears them with the authorized version", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "base-context-clear" }));
  const key = "silicon-interface:draft-v2:carbon:base-context-clear:base-context-room";
  storage.setItem(key, JSON.stringify({
    room_id: "base-context-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 3,
    updated_at: "2026-07-15T00:12:00Z",
    dirty: false,
    lastLocalEditAt: 1,
    localClearedAt: 1,
    pendingClearAfterSend: {
      text: "new message that was sent",
      attachments: [],
      reply_to_event_id: "",
      base_version: 3,
    },
  }));
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  let releaseDelete;
  api.deleteDraft = (roomId, payload) => {
    assert.equal(payload.base_version, 3);
    return new Promise((resolve) => {
      releaseDelete = () => resolve({
        room_id: roomId,
        text: "",
        attachments: [],
        reply_to_event_id: "",
        reply_to_snapshot: {},
        version: 4,
        updated_at: "2026-07-15T00:13:00Z",
        cleared_at: "2026-07-15T00:13:00Z",
        origin_device: "this-device",
      });
    });
  };
  try {
    assert.equal(drafts.getDraft("base-context-room"), "");
    await drafts.applyServerDraft({
      room_id: "base-context-room",
      text: "older cloud draft at the send base",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 3,
      updated_at: "2026-07-15T00:12:00Z",
      origin_device: "another-device",
    });
    let saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.pendingRemote ?? null, null);
    assert.equal(saved.syncBlocked ?? false, false);
    assert.equal(saved.pendingClearAfterSend.text, "new message that was sent");

    await waitFor(() => typeof releaseDelete === "function");
    releaseDelete();
    await waitFor(() => JSON.parse(storage.getItem(key)).pendingClearAfterSend === null);
    saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.version, 4);
    assert.equal(saved.pendingRemote ?? null, null);
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("recovery rebases to a matching PUT and cannot be completed by older frames", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "monotonic-clear" }));
  const key = "silicon-interface:draft-v2:carbon:monotonic-clear:monotonic-room";
  storage.setItem(key, JSON.stringify({
    room_id: "monotonic-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 3,
    updated_at: "2026-07-15T00:13:00Z",
    dirty: false,
    lastLocalEditAt: 1,
    localClearedAt: 1,
    pendingClearAfterSend: {
      text: "sent snapshot",
      attachments: [],
      reply_to_event_id: "",
      base_version: 3,
    },
  }));
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  api.deleteDraft = () => new Promise(() => undefined);
  const frame = (text, version, cleared = false) => ({
    room_id: "monotonic-room",
    text,
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version,
    updated_at: `2026-07-15T00:${version}:00Z`,
    ...(cleared ? { cleared_at: `2026-07-15T00:${version}:00Z` } : {}),
    origin_device: "another-device",
  });
  try {
    assert.equal(drafts.getDraft("monotonic-room"), "");
    await drafts.applyServerDraft(frame("sent snapshot", 5));
    let saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.version, 5);
    assert.equal(saved.pendingClearAfterSend.base_version, 5);
    assert.equal(saved.text, "");

    await drafts.applyServerDraft(frame("", 4, true));
    await drafts.applyServerDraft(frame("older divergent frame", 4));
    saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.pendingClearAfterSend.base_version, 5);
    assert.equal(saved.pendingRemote ?? null, null);
    assert.equal(saved.syncBlocked, false);

    await drafts.applyServerDraft(frame("", 6, true));
    saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.pendingClearAfterSend, null);
    assert.equal(saved.version, 6);
  } finally {
    api.deleteDraft = originalDelete;
  }
});

test("an authoritative recovery clear supersedes an older divergent barrier and saves the next edit", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "superseded-clear-conflict" }));
  const key = "silicon-interface:draft-v2:carbon:superseded-clear-conflict:superseded-room";
  storage.setItem(key, JSON.stringify({
    room_id: "superseded-room",
    text: "new local edit",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 5,
    updated_at: "2026-07-15T00:15:00Z",
    dirty: true,
    lastLocalEditAt: 2,
    localClearedAt: 0,
    pendingClearAfterSend: {
      text: "message already sent",
      attachments: [],
      reply_to_event_id: "",
      base_version: 4,
    },
    pendingRemote: {
      room_id: "superseded-room",
      text: "older divergent draft",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 5,
      updated_at: "2026-07-15T00:15:00Z",
      origin_device: "another-device",
    },
    syncBlocked: true,
    syncError: "conflict",
  }));
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  let puts = 0;
  api.putDraft = async (roomId, payload) => {
    puts += 1;
    assert.equal(payload.text, "new local edit");
    assert.equal(payload.base_version, 6);
    return {
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 7,
      updated_at: "2026-07-15T00:17:00Z",
      origin_device: "this-device",
    };
  };
  try {
    await drafts.applyServerDraft({
      room_id: "superseded-room",
      text: "",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 6,
      updated_at: "2026-07-15T00:16:00Z",
      cleared_at: "2026-07-15T00:16:00Z",
      origin_device: "another-device",
    });
    let saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.pendingClearAfterSend, null);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.text, "new local edit");
    assert.equal(saved.dirty, true);
    assert.equal(saved.syncBlocked, false);

    drafts.flushDraft("superseded-room");
    await waitFor(() => puts === 1 && drafts.draftSyncStatus("superseded-room").dirty === false);
    saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.version, 7);
    assert.equal(saved.text, "new local edit");
  } finally {
    api.putDraft = originalPut;
  }
});

test("a late save acknowledgement cannot erase a newer remote conflict", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "late-ack-user" }));
  const key = "silicon-interface:draft-v2:carbon:late-ack-user:late-ack-room";
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  let releasePut;
  api.putDraft = (roomId, payload) => new Promise((resolve) => {
    releasePut = () => resolve({
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 4,
      updated_at: "2026-07-15T00:00:00Z",
      origin_device: "this-device",
    });
  });
  try {
    storage.setItem(key, JSON.stringify({
      room_id: "late-ack-room",
      text: "local edit",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 3,
      updated_at: "",
      dirty: true,
      focused: true,
      lastLocalEditAt: 1,
      lastServerSyncAt: 0,
    }));
    drafts.flushDraft("late-ack-room");
    await waitFor(() => typeof releasePut === "function");
    await drafts.applyServerDraft({
      room_id: "late-ack-room",
      text: "new remote edit",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 5,
      updated_at: "2026-07-15T00:01:00Z",
      origin_device: "another-device",
    });
    releasePut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.version, 5);
    assert.equal(saved.pendingRemote.version, 5);
    assert.equal(saved.syncBlocked, true);
    assert.equal(saved.syncError, "conflict");
  } finally {
    api.putDraft = originalPut;
  }
});

test("PUT websocket-before-HTTP acknowledgement rebases a newer local edit", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "put-ws-first" }));
  storage.setItem("silicon-interface:device-id", "this-device");
  const key = "silicon-interface:draft-v2:carbon:put-ws-first:put-ws-room";
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalPut = api.putDraft;
  let releaseFirst;
  let calls = 0;
  const firstAck = {
    room_id: "put-ws-room",
    text: "first edit",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 1,
    updated_at: "2026-07-15T00:09:00Z",
    origin_device: "this-device",
  };
  api.putDraft = async (roomId, payload) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve(firstAck);
      });
    }
    assert.equal(payload.text, "newer local edit");
    assert.equal(payload.base_version, 1);
    return {
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 2,
      updated_at: "2026-07-15T00:10:00Z",
      origin_device: "this-device",
    };
  };
  try {
    await drafts.setDraft("put-ws-room", "first edit");
    drafts.flushDraft("put-ws-room");
    await waitFor(() => typeof releaseFirst === "function");
    await drafts.setDraft("put-ws-room", "newer local edit");
    await drafts.applyServerDraft(firstAck);
    let saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.text, "newer local edit");
    assert.equal(saved.version, 1);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.syncBlocked, false);

    releaseFirst();
    await waitFor(() => drafts.draftSyncStatus("put-ws-room").dirty === false);
    saved = JSON.parse(storage.getItem(key));
    assert.equal(calls, 2);
    assert.equal(saved.text, "newer local edit");
    assert.equal(saved.version, 2);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.syncBlocked, false);
  } finally {
    api.putDraft = originalPut;
  }
});

test("a persisted same-device echo is repaired without reopening a conflict", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "same-device-repair" }));
  storage.setItem("silicon-interface:device-id", "this-device");
  const key = "silicon-interface:draft-v2:carbon:same-device-repair:same-device-repair-room";
  storage.setItem(key, JSON.stringify({
    room_id: "same-device-repair-room",
    text: "newer text still being typed",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 2,
    updated_at: "2026-07-15T00:00:00Z",
    origin_device: "this-device",
    dirty: true,
    focused: false,
    lastLocalEditAt: 2,
    lastServerSyncAt: 1,
    syncBlocked: true,
    syncError: "conflict",
    pendingRemote: {
      room_id: "same-device-repair-room",
      text: "older text echoed by this browser",
      attachments: [],
      reply_to_event_id: "",
      reply_to_snapshot: {},
      version: 3,
      updated_at: "2026-07-15T00:01:00Z",
      origin_device: "this-device",
    },
  }));

  const drafts = await import("../../src/lib/drafts.ts");
  assert.equal(drafts.getDraft("same-device-repair-room"), "newer text still being typed");
  const status = drafts.draftSyncStatus("same-device-repair-room");
  assert.equal(status.blocked, false);
  assert.equal(status.conflict ?? null, null);
  assert.equal(status.dirty, true);
  // End this test with its automatic sync timer cancelled so it cannot race a
  // later test's API stub.
  await drafts.applyServerDraft({
    room_id: "same-device-repair-room",
    text: "a genuine remote edit",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 4,
    updated_at: "2026-07-15T00:02:00Z",
    origin_device: "another-device",
  });
});

test("DELETE websocket-before-HTTP acknowledgement preserves and saves the next edit", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "delete-ws-first" }));
  const key = "silicon-interface:draft-v2:carbon:delete-ws-first:delete-ws-room";
  const { api } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const originalDelete = api.deleteDraft;
  const originalPut = api.putDraft;
  let releaseDelete;
  let putCalls = 0;
  const clearAck = {
    room_id: "delete-ws-room",
    text: "",
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version: 1,
    updated_at: "2026-07-15T00:11:00Z",
    cleared_at: "2026-07-15T00:11:00Z",
    origin_device: "this-device",
  };
  api.deleteDraft = () => new Promise((resolve) => {
    releaseDelete = () => resolve(clearAck);
  });
  api.putDraft = async (roomId, payload) => {
    putCalls += 1;
    assert.equal(payload.text, "next edit");
    assert.equal(payload.base_version, 1);
    return {
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 2,
      updated_at: "2026-07-15T00:12:00Z",
      origin_device: "this-device",
    };
  };
  try {
    await drafts.setDraft("delete-ws-room", "sent edit");
    await drafts.clearDraftAfterSend("delete-ws-room");
    await waitFor(() => typeof releaseDelete === "function");
    await drafts.setDraft("delete-ws-room", "next edit");
    await drafts.applyServerDraft(clearAck);
    let saved = JSON.parse(storage.getItem(key));
    assert.equal(saved.pendingClearAfterSend, null);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.dirty, true);

    releaseDelete();
    await waitFor(() => drafts.draftSyncStatus("delete-ws-room").dirty === false);
    saved = JSON.parse(storage.getItem(key));
    assert.equal(putCalls, 1);
    assert.equal(saved.text, "next edit");
    assert.equal(saved.version, 2);
    assert.equal(saved.pendingRemote, null);
    assert.equal(saved.syncBlocked, false);
  } finally {
    api.deleteDraft = originalDelete;
    api.putDraft = originalPut;
  }
});
