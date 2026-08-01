import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const roomView = await readFile(
  new URL("../../src/components/chat/room-view.tsx", import.meta.url),
  "utf8",
);
const composer = await readFile(
  new URL("../../src/components/chat/composer.tsx", import.meta.url),
  "utf8",
);

function functionSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("unsend redacts in place without copying the deleted message into the composer", () => {
  const unsend = functionSlice(roomView, "const onSelfDelete", "const onReact");

  assert.doesNotMatch(
    unsend,
    /copyEventToComposer|setComposerCopy|setDraft\(|copyDraft|requestBottomStick/,
  );
  assert.match(unsend, /projectRedactedWindow/);
  assert.match(unsend, /settleTimelineAfterUnsend/);
});

test("waiting sends expose a durable cancel path instead of a fake unsend", () => {
  const unsend = functionSlice(roomView, "const onSelfDelete", "const onReact");

  assert.match(unsend, /cancelPendingSendControl\(owner, clientId\)/);
  assert.match(unsend, /withOutboxClientLock\(owner, clientId/);
  assert.match(unsend, /cancelPendingMediaSend\(owner, current\)/);
  assert.match(unsend, /cancelPendingOutbox\(owner, clientId\)/);
  assert.match(composer, /retainSourceUntilEventAck: true/);
  assert.match(composer, /stageMediaSendIntent\(\{/);
});

test("group chats use the Carbon-to-Carbon unsend window", () => {
  const gate = functionSlice(roomView, "const roomIncludesSilicon", "const canEditMessage");

  assert.match(
    gate,
    /const directRoomIncludesSilicon = room\.kind === "direct" && roomIncludesSilicon/,
  );
  assert.match(gate, /if \(directRoomIncludesSilicon\) return false/);
  assert.match(gate, /if \(typeof ev\.can_unsend === "boolean"\) return ev\.can_unsend/);
  assert.doesNotMatch(gate, /if \(roomIncludesSilicon\) return false/);
});

test("copying content into the composer remains an explicit recovery action", () => {
  const correction = functionSlice(roomView, "const onCorrection", "const confirmTextCorrection");
  const copyCalls = [...correction.matchAll(/copyEventToComposer\(event\)/g)];

  assert.equal(copyCalls.length, 2);
  assert.match(correction, /action === "copy_to_composer"/);
  assert.match(composer, /Only the explicit recovery action “copy to composer” enters here/);
  assert.doesNotMatch(composer, /restoreDraft|ComposerRestoreDraft/);
});
