import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser } from "./helpers.mjs";

test("event pages and both signed cursors commit in one IndexedDB transaction", async () => {
  const storage = installBrowser();
  const cursors = await import("../../src/lib/sync-cursors.ts");
  const chatStore = await import("../../src/lib/chat-store.ts");
  const owner = `carbon:cursor-${Date.now()}`;

  // A legacy localStorage token is ignored: its IndexedDB timeline may have
  // been evicted independently, so the caller must take a fresh snapshot.
  storage.setItem(
    `silicon-interface:sync-cursors-v1:${encodeURIComponent(owner)}`,
    JSON.stringify({ event: "legacy-event", account: "legacy-account" }),
  );
  assert.equal(await cursors.getSyncCursors(owner), null);

  await chatStore.storeEvents(
    owner,
    [{ roomId: "room-1", event: {
      event_id: "event-1", room: 1, sender_kind: "carbon", sender_id: 1,
      sender_handle: "alice", type: "m.text", content: { body: "durable" },
      reply_to_event_id: "", is_final: true, created_at: "2026-01-01T00:00:00Z",
      edited_at: null, redacted_at: null, redaction_reason: "",
    } }],
    {
      event: "signed-event-1",
      account: "signed-account-1",
      eventPosition: 11,
      accountPosition: 7,
    },
  );
  assert.deepEqual(await cursors.getSyncCursors(owner), {
    event: "signed-event-1",
    account: "signed-account-1",
  });
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), {
    event: "signed-event-1",
    account: "signed-account-1",
    eventPosition: 11,
    accountPosition: 7,
  });
  assert.equal((await chatStore.loadStoredRoomEvents(owner, "room-1"))[0].event_id, "event-1");

  await assert.rejects(
    chatStore.storeEvents(
      owner,
      [{ roomId: "room-1", event: {
        event_id: "event-should-rollback", room: 1, sender_kind: "carbon", sender_id: 1,
        sender_handle: "alice", type: "m.text", content: { body: "not committed" },
        reply_to_event_id: "", is_final: true, created_at: "2026-01-01T00:00:01Z",
        edited_at: null, redacted_at: null, redaction_reason: "",
      } }],
      {
        event: "",
        account: "signed-account-2",
        eventPosition: 12,
        accountPosition: 8,
      },
    ),
    /Both signed sync cursors are required/,
  );
  await assert.rejects(
    chatStore.storeEvents(owner, [], {
      event: " \n ",
      account: "signed-account-2",
      eventPosition: 12,
      accountPosition: 8,
    }),
    /Both signed sync cursors are required/,
  );
  assert.deepEqual(
    (await chatStore.loadStoredRoomEvents(owner, "room-1")).map((row) => row.event_id),
    ["event-1"],
  );
  assert.deepEqual(await cursors.getSyncCursors(owner), {
    event: "signed-event-1",
    account: "signed-account-1",
  });
  assert.equal((await cursors.getSyncCheckpoint(owner)).eventPosition, 11);

  await cursors.setSyncCheckpoint(owner, {
    event: "signed-event-2",
    account: "signed-account-2",
    eventPosition: 20,
    accountPosition: 12,
  });
  assert.equal(storage.length, 0);
  assert.deepEqual(await cursors.getSyncCursors(owner), {
    event: "signed-event-2",
    account: "signed-account-2",
  });
  assert.deepEqual(await cursors.getSyncCheckpoint(owner), {
    event: "signed-event-2",
    account: "signed-account-2",
    eventPosition: 20,
    accountPosition: 12,
  });

  await cursors.clearSyncCursors(owner);
  assert.equal(await cursors.getSyncCursors(owner), null);
});
