import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}

function serverDraft(roomId, text, version, clearedAt = null) {
  return {
    room_id: roomId,
    text,
    attachments: [],
    reply_to_event_id: "",
    reply_to_snapshot: {},
    version,
    updated_at: new Date().toISOString(),
    cleared_at: clearedAt,
    origin_device: "test-device",
  };
}

test("composer journal preserves exact whitespace, selection, and formatting mode", async () => {
  const storage = installBrowser(new MemoryStorage());
  storage.setItem(
    "silicon-interface:carbon",
    JSON.stringify({ carbon_id: "composer-exact-user" }),
  );
  const drafts = await import("../../src/lib/drafts.ts");
  const text = " \n  keep every byte \t";

  assert.equal(
    await drafts.setDraft("composer-exact-room", text, {
      start: 2,
      end: 10_000,
      direction: "backward",
    }),
    true,
  );

  assert.equal(drafts.getDraft("composer-exact-room"), text);
  assert.deepEqual(drafts.getDraftComposerState("composer-exact-room"), {
    text,
    selectionStart: 2,
    selectionEnd: text.length,
    selectionDirection: "backward",
    formattingMode: "markdown",
  });
  const mirror = JSON.parse(
    storage.getItem(
      "silicon-interface:draft-v2:carbon:composer-exact-user:composer-exact-room",
    ),
  );
  assert.equal(mirror.text, text);
  assert.equal(mirror.selection_start, 2);
  assert.equal(mirror.selection_end, text.length);
  assert.equal(mirror.selection_direction, "backward");
  assert.equal(mirror.formatting_mode, "markdown");
});

test("a sent draft becomes a durable tombstone instead of exposing an old journal copy", async () => {
  const storage = installBrowser(new MemoryStorage());
  storage.setItem(
    "silicon-interface:carbon",
    JSON.stringify({ carbon_id: "composer-clear-user" }),
  );
  const drafts = await import("../../src/lib/drafts.ts");
  const journal = await import("../../src/lib/draft-journal.ts");
  const roomId = "composer-clear-room";

  await drafts.setDraft(roomId, "already queued", {
    start: 3,
    end: 7,
    direction: "forward",
  });
  assert.equal(await drafts.clearDraftAfterSend(roomId), true);

  const key =
    "silicon-interface:draft-v2:carbon:composer-clear-user:composer-clear-room";
  const mirror = JSON.parse(storage.getItem(key));
  const durable = await journal.readDraftJournal(
    "carbon:composer-clear-user",
    roomId,
  );
  for (const snapshot of [mirror, durable]) {
    assert.equal(snapshot.text, "");
    assert.equal(snapshot.selection_start, 0);
    assert.equal(snapshot.selection_end, 0);
    assert.ok(snapshot.localClearedAt > 0);
    assert.ok(snapshot.lastJournalAt >= snapshot.localClearedAt);
  }
});

test("IndexedDB completion releases the navigation guard when localStorage is full", async () => {
  class QuotaStorage extends MemoryStorage {
    setItem(key, value) {
      if (String(key).startsWith("silicon-interface:draft-v2:")) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      super.setItem(key, value);
    }
  }

  const storage = installBrowser(new QuotaStorage());
  storage.setItem(
    "silicon-interface:carbon",
    JSON.stringify({ carbon_id: "composer-idb-user" }),
  );
  const drafts = await import("../../src/lib/drafts.ts");
  const roomId = "composer-idb-room";
  const committed = drafts.setDraft(roomId, "safe in the independent journal");

  assert.equal(drafts.draftSyncStatus(roomId).localDurabilityPending, true);
  assert.equal(drafts.hasUncommittedLocalDraft(roomId), true);
  assert.equal(await committed, true);
  assert.equal(drafts.draftSyncStatus(roomId).localDurabilityPending, false);
  assert.equal(drafts.draftSyncStatus(roomId).localDurabilityError, null);
  assert.equal(drafts.hasUncommittedLocalDraft(roomId), false);
});

test("send clear is serialized after an in-flight cloud save and before the next edit", async () => {
  const storage = installBrowser(new MemoryStorage());
  storage.setItem(
    "silicon-interface:carbon",
    JSON.stringify({ carbon_id: "composer-order-user" }),
  );
  const drafts = await import("../../src/lib/drafts.ts");
  const { api } = await import("../../src/lib/api.ts");
  const roomId = "composer-order-room";
  const calls = [];
  let releaseFirstPut;
  const firstPutGate = new Promise((resolve) => {
    releaseFirstPut = resolve;
  });
  const originalPut = api.putDraft;
  const originalDelete = api.deleteDraft;
  let putCount = 0;
  api.putDraft = async (targetRoomId, payload) => {
    if (targetRoomId !== roomId) {
      return serverDraft(targetRoomId, payload.text, 1);
    }
    putCount += 1;
    calls.push(`put:${payload.text}`);
    if (putCount === 1) await firstPutGate;
    return serverDraft(roomId, payload.text, putCount === 1 ? 1 : 3);
  };
  api.deleteDraft = async (targetRoomId, payload) => {
    if (targetRoomId !== roomId) {
      return serverDraft(targetRoomId, "", 2, new Date().toISOString());
    }
    calls.push(`delete:${payload.base_version}`);
    return serverDraft(roomId, "", 2, new Date().toISOString());
  };

  try {
    await drafts.setDraft(roomId, "already sent");
    drafts.flushDraft(roomId);
    await waitFor(() => calls.length === 1);

    await drafts.clearDraftAfterSend(roomId);
    await drafts.setDraft(roomId, "new unsent edit");
    assert.deepEqual(calls, ["put:already sent"]);

    releaseFirstPut();
    await waitFor(() => calls.includes("delete:1"));
    await waitFor(() => calls.includes("put:new unsent edit"));
    assert.deepEqual(calls, [
      "put:already sent",
      "delete:1",
      "put:new unsent edit",
    ]);
    assert.equal(drafts.getDraft(roomId), "new unsent edit");
  } finally {
    api.putDraft = originalPut;
    api.deleteDraft = originalDelete;
  }
});
