import assert from "node:assert/strict";
import test from "node:test";

import {
  DELAY_NEW_SILICON_TEXT_SENDS,
  LEGACY_SILICON_TEXT_HOLD_SECONDS,
  SILICON_TEXT_HOLD_MS,
  SILICON_TEXT_HOLD_SECONDS,
  recoveredSiliconHoldSeconds,
  siliconHoldReleaseAt,
} from "../../src/lib/silicon-hold.ts";
import {
  heldSendScheduleDelayMs,
  heldSendScheduleSignature,
} from "../../src/lib/held-send-state.ts";

test("new Silicon text sends do not enter the legacy hold path", () => {
  assert.equal(DELAY_NEW_SILICON_TEXT_SENDS, false);
});

test("legacy Silicon hold timing remains available for recovery", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  assert.equal(SILICON_TEXT_HOLD_MS, 5_000);
  assert.equal(SILICON_TEXT_HOLD_SECONDS, 5);
  assert.equal(
    siliconHoldReleaseAt(now),
    "2026-07-13T12:00:05.000Z",
  );
});

test("restart recovery preserves recorded legacy deadlines without extending them", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");
  assert.equal(LEGACY_SILICON_TEXT_HOLD_SECONDS, 10);
  assert.equal(
    recoveredSiliconHoldSeconds("2026-07-13T12:00:05.000Z", now),
    5,
  );
  assert.equal(
    recoveredSiliconHoldSeconds("2026-07-13T12:00:10.000Z", now),
    10,
  );
  assert.equal(
    recoveredSiliconHoldSeconds("2026-07-13T12:00:00.000Z", now),
    1,
  );
  assert.equal(recoveredSiliconHoldSeconds("not-a-date", now), 1);
});

function held(overrides = {}) {
  return {
    held_send_id: "held-1",
    room_id: "room-1",
    client_id: "client-1",
    device_id: "device-1",
    type: "m.text",
    content: { body: "hello", client_id: "client-1" },
    reply_to_event_id: "",
    state: "pending",
    phase: "held",
    release_at: "2026-07-13T12:00:05.000Z",
    sent_event_id: "",
    version: 1,
    error: "",
    created_at: "2026-07-13T12:00:00.000Z",
    updated_at: "2026-07-13T12:00:00.000Z",
    terminal_at: "",
    ...overrides,
  };
}

test("client fallback honors five-second and extended holds without early release", () => {
  assert.equal(heldSendScheduleDelayMs(held()), 5_100);
  assert.equal(
    heldSendScheduleDelayMs(
      held({ release_at: "2026-07-13T12:01:05.000Z", version: 2 }),
    ),
    65_100,
  );
  assert.equal(
    heldSendScheduleDelayMs(
      held({ release_at: "2026-07-13T13:00:00.000Z", version: 3 }),
    ),
    300_100,
  );
  assert.equal(heldSendScheduleDelayMs(held({ state: "releasing" })), 5_100);
});

test("only authoritative held-send changes replace a running fallback timer", () => {
  const first = held();
  assert.equal(heldSendScheduleSignature(first), heldSendScheduleSignature({ ...first }));
  assert.notEqual(
    heldSendScheduleSignature(first),
    heldSendScheduleSignature(
      held({ version: 2, release_at: "2026-07-13T12:01:05.000Z" }),
    ),
  );
});
