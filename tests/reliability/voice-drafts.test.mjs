import assert from "node:assert/strict";
import test from "node:test";

import { deleteDatabase, installBrowser } from "./helpers.mjs";

test("an interrupted live voice recording is rebuilt from durable slices", async () => {
  await deleteDatabase("silicon-interface-voice-drafts");
  installBrowser();
  const drafts = await import("../../src/lib/voice-drafts.ts");

  await drafts.beginLiveVoiceDraft("voice-room");
  await drafts.appendLiveVoiceChunk({
    roomId: "voice-room",
    clientId: "voice-client",
    sequence: 0,
    startedAt: 1_000,
    durationMs: 200,
    mime: "audio/webm",
    blob: new Blob(["first"], { type: "audio/webm" }),
  });

  assert.equal(drafts.getVoiceDraftListPreview("voice-room").active, true);
  await drafts.appendLiveVoiceChunk({
    roomId: "voice-room",
    clientId: "voice-client",
    sequence: 1,
    startedAt: 1_000,
    durationMs: 400,
    mime: "audio/webm",
    blob: new Blob(["second"], { type: "audio/webm" }),
  });

  const restored = await drafts.getVoiceDraft("voice-room");
  assert.ok(restored);
  assert.equal(restored.clientId, "voice-client");
  assert.equal(restored.durationMs, 400);
  assert.equal(await restored.blob.text(), "firstsecond");

  await drafts.clearVoiceDraft("voice-room");
  assert.equal(await drafts.getVoiceDraft("voice-room"), null);
  assert.deepEqual(drafts.getVoiceDraftListPreview("voice-room"), {
    active: false,
    updatedAt: "",
  });
});
