import assert from "node:assert/strict";
import test from "node:test";

import {
  isGenuinelyNewLiveEvent,
  shouldPlayReceivedSound,
} from "../../src/lib/live-event-notification.ts";

test("replays and later revisions of one message can never sound new", () => {
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: true,
    patchesProjectedLastEvent: false,
    edited: false,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
    patchesProjectedLastEvent: true,
    edited: false,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
    patchesProjectedLastEvent: false,
    edited: true,
  }), false);
  assert.equal(isGenuinelyNewLiveEvent({
    seenEventIdentity: false,
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
