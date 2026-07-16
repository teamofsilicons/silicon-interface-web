import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedHeldSend,
  eventForSentHeld,
  heldSendRequiringAttention,
} from "../../src/lib/operation-recovery.ts";
import {
  heldSendDeadline,
  heldChallengeUsableOnDevice,
  heldSendBelongsToDevice,
  heldSendMaySchedule,
  heldSendProjectionKey,
  heldSendUiState,
} from "../../src/lib/held-send-state.ts";
import { sendFailureFromHeld } from "../../src/lib/send-failure.ts";

function status(overrides = {}) {
  return {
    operation_id: "operation-1",
    room_id: "room-1",
    kind: "held_send",
    client_id: "client-1",
    device_id: "device-1",
    state: "pending",
    resource_id: "held-1",
    result_event_id: "",
    http_status: 201,
    accepted_at: "2026-01-01T00:00:00Z",
    terminal_at: "",
    expires_at: "2026-02-01T00:00:00Z",
    result: {
      kind: "held_send",
      held_send: {
        held_send_id: "held-1",
        room_id: "room-1",
        client_id: "client-1",
        device_id: "device-1",
        type: "m.text",
        content: { body: "still private" },
        reply_to_event_id: "",
        state: "pending",
        release_at: "2026-01-01T00:00:05Z",
        sent_event_id: "",
        version: 1,
        error: "",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        terminal_at: "",
      },
    },
    ...overrides,
  };
}

test("held recovery only acknowledges matching authoritative state and identity", () => {
  assert.equal(acceptedHeldSend(status(), "room-1", "client-1", "device-1")?.held_send_id, "held-1");
  assert.equal(acceptedHeldSend(status(), "room-1", "client-1", "device-other"), null);
  assert.equal(acceptedHeldSend(status({ state: "succeeded" }), "room-1", "client-1"), null);
  assert.equal(acceptedHeldSend(status({ resource_id: "held-other" }), "room-1", "client-1"), null);

  const sent = status({
    state: "succeeded",
    result_event_id: "event-1",
    result: {
      ...status().result,
      held_send: {
        ...status().result.held_send,
        state: "sent",
        content: {},
        sent_event_id: "event-1",
      },
    },
  });
  assert.equal(acceptedHeldSend(sent, "room-1", "client-1")?.sent_event_id, "event-1");
  assert.equal(acceptedHeldSend({ ...sent, result_event_id: "event-other" }, "room-1", "client-1"), null);
});

test("malformed held retry metadata fails closed and device-scoped projections cannot collide", () => {
  const base = status().result.held_send;
  const validFailure = {
    domain: "chat.operation",
    code: "server_unavailable",
    retryable: true,
    automatic: true,
    correction_actions: [],
  };
  const malformed = [
    {
      ...base,
      phase: "held",
      failure_code: "server_unavailable",
      failure: validFailure,
    },
    {
      ...base,
      phase: "blocked",
      failure_code: "server_unavailable",
      failure: validFailure,
    },
    {
      ...base,
      phase: "retry_wait",
      failure_code: "server_unavailable",
      failure_at: "2026-01-01T00:00:05Z",
      next_attempt_at: "not-a-time",
      failure: validFailure,
    },
    {
      ...base,
      phase: "retry_wait",
      failure_code: "server_unavailable",
      failure_at: "2026-01-01T00:00:05Z",
      next_attempt_at: "2026-01-03T00:00:05Z",
      failure: validFailure,
    },
    {
      ...base,
      phase: "retry_wait",
      failure_code: "server_unavailable",
      failure_at: "2026-01-01T00:00:05Z",
      next_attempt_at: "2026-01-01T00:00:12Z",
      failure: { ...validFailure, retryable: false },
    },
  ];
  for (const held of malformed) {
    assert.equal(heldSendMaySchedule(held), false);
    assert.equal(heldSendUiState(held), "failed");
  }

  const challenge = {
    ...base,
    held_send_id: "held-other-device",
    device_id: "device-other",
    state: "challenge",
    phase: "challenge",
  };
  assert.equal(heldSendBelongsToDevice(challenge, "device-1"), false);
  assert.equal(heldChallengeUsableOnDevice(challenge, "device-1"), false);
  assert.notEqual(
    heldSendProjectionKey(challenge, "device-1"),
    challenge.client_id,
    "a foreign-device client ID cannot claim this installation's optimistic row",
  );
  assert.equal(
    heldSendProjectionKey({ ...challenge, device_id: "device-1" }, "device-1"),
    challenge.client_id,
  );
});

test("sent held recovery projects only exact sent_event_id across device collisions", () => {
  const sent = {
    ...status().result.held_send,
    state: "sent",
    sent_event_id: "event-exact",
  };
  const collision = {
    event_id: "event-other-device",
    content: { client_id: "client-1", body: "other device" },
  };
  const exact = {
    event_id: "event-exact",
    content: { client_id: "client-1", body: "this held send" },
  };
  assert.equal(eventForSentHeld(sent, [collision]), null);
  assert.equal(eventForSentHeld(sent, [collision, exact]), exact);
  assert.equal(
    eventForSentHeld({ ...sent, state: "pending" }, [exact]),
    null,
    "a pending hold cannot be projected by an event-send lookup or POST",
  );
});

test("server-held retry and attention states retain content without becoming generic due work", () => {
  const base = status().result.held_send;
  const retrying = {
    ...base,
    phase: "retry_wait",
    release_attempts: 1,
    failure_code: "server_unavailable",
    failure_at: "2026-01-01T00:00:05Z",
    next_attempt_at: "2026-01-01T00:00:12Z",
    failure: {
      domain: "chat.operation",
      code: "server_unavailable",
      retryable: true,
      automatic: true,
      correction_actions: [],
      retry_after_seconds: 7,
    },
    content: { body: "retry safely", client_id: "client-1" },
  };
  const retryStatus = {
    ...status(),
    result: { kind: "held_send", held_send: retrying },
  };
  assert.equal(heldSendUiState(retrying), "retry_wait");
  assert.equal(heldSendMaySchedule(retrying), true);
  assert.equal(heldSendDeadline(retrying), retrying.next_attempt_at);
  assert.equal(sendFailureFromHeld(retrying).nextAttemptAt, Date.parse(retrying.next_attempt_at));
  assert.equal(acceptedHeldSend(retryStatus, "room-1", "client-1")?.content.body, "retry safely");

  for (const state of ["blocked", "challenge"]) {
    const held = {
      ...base,
      state,
      phase: state,
      failure_code: state === "challenge" ? "challenge_required" : "access_revoked",
      failure: state === "challenge"
        ? {
            domain: "chat.operation",
            code: "challenge_required",
            retryable: true,
            automatic: false,
            correction_actions: ["solve_challenge"],
          }
        : {
            domain: "chat.operation",
            code: "access_revoked",
            retryable: false,
            automatic: false,
            correction_actions: ["request_access", "copy_to_composer", "discard_local"],
          },
      content: { body: `${state} stays private`, client_id: "client-1" },
    };
    const operation = {
      ...status(),
      result: { kind: "held_send", held_send: held },
    };
    assert.equal(heldSendMaySchedule(held), false, state);
    assert.equal(heldSendUiState(held), state === "challenge" ? "challenge" : "failed", state);
    assert.equal(acceptedHeldSend(operation, "room-1", "client-1"), null, state);
    assert.equal(
      heldSendRequiringAttention(operation, "room-1", "client-1")?.content.body,
      `${state} stays private`,
      state,
    );
  }
});
