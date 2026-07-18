import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isGenuinelyNewLiveEvent,
  shouldPlayReceivedSound,
} from "../../src/lib/live-event-notification.ts";

test("replays and later revisions of one message can never sound new", () => {
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: true,
    cachedEventIdentity: false,
    patchesProjectedLastEvent: false,
    edited: false,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
    cachedEventIdentity: true,
    patchesProjectedLastEvent: false,
    edited: false,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
    cachedEventIdentity: false,
    patchesProjectedLastEvent: true,
    edited: false,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
    cachedEventIdentity: false,
    patchesProjectedLastEvent: false,
    edited: true,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
    cachedEventIdentity: false,
    patchesProjectedLastEvent: false,
    edited: false,
  }), true);
});

test("received sound requires one genuinely new countable remote event", () => {
  const eligible = {
    quiet: false,
    notificationAllowed: true,
    soundAllowed: true,
    mine: false,
    countable: true,
    genuinelyNew: true,
    observed: false,
  };
  assert.equal(shouldPlayReceivedSound(eligible), true);
  for (const key of ["notificationAllowed", "soundAllowed", "countable", "genuinelyNew"]) {
    assert.equal(shouldPlayReceivedSound({ ...eligible, [key]: false }), false);
  }
  assert.equal(shouldPlayReceivedSound({ ...eligible, quiet: true }), false);
  assert.equal(shouldPlayReceivedSound({ ...eligible, mine: true }), false);
  assert.equal(
    shouldPlayReceivedSound({ ...eligible, observed: true }),
    false,
    "read-only observed conversations are always silent",
  );
});

test("outgoing sends and acknowledgements never use notification audio", async () => {
  const source = await readFile(
    new URL("../../src/components/chat/room-view.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /playSent|playAckTick/);
});

test("a suspended audio context never releases a stale message sound later", async () => {
  const source = await readFile(new URL("../../src/lib/sounds.ts", import.meta.url), "utf8");
  const suspended = source.slice(
    source.indexOf('if (ac.state === "suspended")'),
    source.indexOf("function emit("),
  );
  assert.match(suspended, /void ac\.resume\(\)\.catch/);
  assert.match(suspended, /return;/);
  assert.doesNotMatch(suspended, /\.then\([^)]*emit/);
});
