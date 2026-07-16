import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("cloud draft retry metadata is durable and manual retry preserves intent", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "retry-user" }));

  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const original = api.putDraft;
  let calls = 0;
  api.putDraft = async (roomId, payload) => {
    calls += 1;
    if (calls === 1) throw new ApiError(503, {}, "temporarily unavailable");
    return {
      room_id: roomId,
      text: payload.text,
      attachments: payload.attachments,
      reply_to_event_id: payload.reply_to_event_id,
      reply_to_snapshot: {},
      version: 1,
      updated_at: "2026-07-11T00:00:00Z",
      origin_device: "",
    };
  };

  try {
    drafts.setDraft("retry-room", "never lose this");
    drafts.flushDraft("retry-room");
    await waitFor(() => drafts.draftSyncStatus("retry-room").attempts === 1);

    const failed = drafts.draftSyncStatus("retry-room");
    assert.equal(failed.dirty, true);
    assert.equal(failed.blocked, false);
    assert.ok(failed.nextAttemptAt > Date.now());
    assert.equal(drafts.getDraft("retry-room"), "never lose this");
    const persisted = JSON.parse(
      storage.getItem("silicon-interface:draft-v2:carbon:retry-user:retry-room"),
    );
    assert.equal(persisted.syncAttempts, 1);
    assert.ok(persisted.nextSyncAt > 0);

    await new Promise((resolve) => setTimeout(resolve, 0));
    drafts.retryDraftSync("retry-room");
    await waitFor(() => drafts.draftSyncStatus("retry-room").dirty === false);
    assert.equal(calls, 2);
    assert.equal(drafts.getDraft("retry-room"), "never lose this");
  } finally {
    api.putDraft = original;
  }
});

test("terminal cloud draft failures stay actionable without deleting the draft", async () => {
  const storage = new MemoryStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "blocked-user" }));

  const { api, ApiError } = await import("../../src/lib/api.ts");
  const drafts = await import("../../src/lib/drafts.ts");
  const original = api.putDraft;
  api.putDraft = async () => {
    throw new ApiError(422, { detail: "invalid" }, "draft needs attention");
  };
  try {
    drafts.setDraft("blocked-room", "still here");
    drafts.flushDraft("blocked-room");
    await waitFor(() => drafts.draftSyncStatus("blocked-room").blocked);
    assert.equal(drafts.draftSyncStatus("blocked-room").nextAttemptAt, 0);
    assert.equal(drafts.getDraft("blocked-room"), "still here");
  } finally {
    api.putDraft = original;
  }
});

test("draft remains in memory and exposes a blocking warning when both local stores fail", async () => {
  class QuotaStorage extends MemoryStorage {
    setItem(key, value) {
      if (String(key).startsWith("silicon-interface:draft-v2:")) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      super.setItem(key, value);
    }

    removeItem(key) {
      if (String(key).startsWith("silicon-interface:draft-v2:")) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      super.removeItem(key);
    }
  }

  const storage = new QuotaStorage();
  installBrowser(storage);
  storage.setItem("silicon-interface:carbon", JSON.stringify({ carbon_id: "quota-user" }));
  // Simulate privacy mode or a damaged browser profile where the independent
  // IndexedDB journal is unavailable at the same time as localStorage.
  window.indexedDB = undefined;

  const drafts = await import("../../src/lib/drafts.ts");
  drafts.setDraft("quota-room", "do not lose this text");

  await waitFor(
    () => drafts.draftSyncStatus("quota-room").localDurabilityError !== null,
  );
  assert.equal(drafts.getDraft("quota-room"), "do not lose this text");
  assert.match(
    drafts.draftSyncStatus("quota-room").localDurabilityError,
    /could not save it/i,
  );
  assert.equal(
    storage.getItem("silicon-interface:draft-v2:carbon:quota-user:quota-room"),
    null,
  );
});
