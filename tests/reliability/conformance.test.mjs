import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canAddSiliconToRoom,
  canSendPlaintextToRoom,
  normalizeDeliverySummary,
} from "../../src/lib/delivery-state.ts";
import { decideClientRetry } from "../../src/lib/retry-policy.ts";
import { SyncBarrierBuffer } from "../../src/lib/sync-barrier-buffer.ts";
import {
  missingMultipartParts,
  verifiedMultipartCompletionParts,
} from "../../src/lib/multipart-resume.ts";
import { resolveDraftChoice } from "../../src/lib/draft-conflict-policy.ts";
import { protocolCompatibility } from "../../src/lib/protocol-window.ts";
import {
  CLIENT_SYNC_REPAIR_CLOSE_CODE,
  heartbeatAction,
  normalizeHeartbeatPolicy,
  socketCloseAction,
} from "../../src/lib/liveness-policy.ts";
import {
  acceptedEvent,
  isAmbiguousSendFailure,
} from "../../src/lib/operation-recovery.ts";
import { ApiError } from "../../src/lib/api.ts";
import { classifySendFailure } from "../../src/lib/send-failure.ts";

async function contract() {
  return JSON.parse(
    await readFile(new URL("../fixtures/chat-reliability-v1.json", import.meta.url), "utf8"),
  );
}

test("client sync repair uses a browser-sendable application close code", () => {
  assert.ok(CLIENT_SYNC_REPAIR_CLOSE_CODE >= 3000);
  assert.ok(CLIENT_SYNC_REPAIR_CLOSE_CODE <= 4999);
  assert.equal(
    socketCloseAction({
      code: CLIENT_SYNC_REPAIR_CLOSE_CODE,
      networkAvailable: true,
      wanted: true,
    }),
    "reconnect_and_sync",
  );
});

test("web retry policy satisfies the shared chat reliability contract", async () => {
  const fixture = await contract();
  assert.equal(fixture.version, 5);
  for (const row of fixture.retry_cases) {
    const actual = decideClientRetry(row.http_status, row.attempts, row.now_ms, row.jitter);
    assert.deepEqual(
      actual,
      { state: row.expected_state, nextAttemptAt: row.expected_next_ms },
      row.id,
    );
  }
});

test("web structured send failures satisfy the shared reliability contract", async () => {
  const fixture = await contract();
  for (const row of fixture.failure_policy_cases) {
    const error = row.http_status === 0
      ? new TypeError("network unavailable")
      : new ApiError(
          row.http_status,
          row.failure ? { failure: row.failure } : {},
          "safe failure",
        );
    const actual = classifySendFailure(error, {
      attempt: row.attempts,
      now: row.now_ms,
      jitter: row.jitter,
    });
    assert.equal(actual.state, row.expected_state, `${row.id}: state`);
    assert.equal(actual.phase, row.expected_phase, `${row.id}: phase`);
    assert.equal(
      actual.failure.nextAttemptAt ?? 0,
      row.expected_next_ms,
      `${row.id}: next attempt`,
    );
    assert.equal(actual.failure.code, row.expected_code, `${row.id}: code`);
    assert.deepEqual(
      actual.failure.correctionActions,
      row.expected_actions,
      `${row.id}: actions`,
    );
  }
  for (const [code, policy] of Object.entries(fixture.failure_contract.policies)) {
    const actual = classifySendFailure(
      new ApiError(422, {
        failure: {
          domain: fixture.failure_contract.domain,
          code,
          retryable: policy.retryable,
          automatic: policy.automatic,
          correction_actions: policy.correction_actions,
        },
      }, "safe failure"),
      { attempt: 1, now: 100_000, jitter: 1 },
    );
    assert.equal(actual.failure.code, code, `${code}: registry code`);
    assert.equal(actual.failure.retryable, policy.retryable, `${code}: retryable`);
    assert.equal(actual.failure.automatic, policy.automatic, `${code}: automatic`);
    assert.deepEqual(
      actual.failure.correctionActions,
      policy.correction_actions,
      `${code}: correction actions`,
    );
  }
});

test("web operation recovery satisfies the shared reliability contract", async () => {
  for (const row of (await contract()).operation_recovery_cases) {
    const status = {
      operation_id: "operation-1",
      room_id: row.operation_room_id ?? "room-1",
      kind: "event_send",
      client_id: "client-1",
      device_id: row.operation_device_id ?? "device-1",
      state: row.operation_state,
      resource_id: row.resource_id,
      result_event_id: row.result_event_id,
      http_status: 201,
      accepted_at: "2026-01-01T00:00:00Z",
      terminal_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-02-01T00:00:00Z",
      result: {
        kind: "event",
        event: {
          event_id: row.event_id,
          room: 1,
          sender_kind: "carbon",
          sender_id: 1,
          sender_handle: "alice",
          type: "m.text",
          content: { client_id: row.event_client_id },
          reply_to_event_id: "",
          is_final: true,
          created_at: "2026-01-01T00:00:00Z",
          edited_at: null,
          redacted_at: null,
          redaction_reason: "",
        },
      },
    };
    assert.equal(isAmbiguousSendFailure(row.http_status), row.expected_ambiguous, row.id);
    assert.equal(
      acceptedEvent(status, "room-1", "client-1", "device-1") != null,
      row.expected_accept,
      row.id,
    );
    assert.equal(
      acceptedEvent(status, "room-1", "client-1", "other-device"),
      null,
      `${row.id}: device mismatch`,
    );
  }
});

test("web receipt aggregation satisfies the shared reliability contract", async () => {
  const fixture = await contract();
  for (const row of fixture.delivery_summary_cases) {
    assert.deepEqual(
      normalizeDeliverySummary(row.recipient_count, row.delivered_count, row.read_count),
      {
        state: row.expected_state,
        recipient_count: row.expected_recipient_count,
        delivered_count: row.expected_delivered_count,
        read_count: row.expected_read_count,
      },
      row.id,
    );
  }
});

test("web room security capabilities fail closed", async () => {
  const fixture = await contract();
  for (const row of fixture.room_security_cases) {
    assert.equal(canSendPlaintextToRoom(row.mode), row.expected_plaintext_send, row.id);
    assert.equal(canAddSiliconToRoom(row.mode), row.expected_silicon_member, row.id);
  }
});

test("web reconnect barrier satisfies the shared reliability contract", async () => {
  for (const row of (await contract()).barrier_cases) {
    const barrier = new SyncBarrierBuffer(row.capacity);
    const released = [];
    const passthrough = [];
    let overflow = false;
    for (const operation of row.operations) {
      const [kind, value] = operation.split(":", 2);
      if (kind === "start") barrier.start();
      else if (kind === "reset") barrier.reset();
      else if (kind === "release") released.push(...barrier.release());
      else {
        const result = barrier.offer(value, kind === "control");
        if (result === "passthrough") passthrough.push(value);
        if (result === "overflow") overflow = true;
      }
    }
    assert.deepEqual(released, row.expected_release, row.id);
    assert.deepEqual(passthrough, row.expected_passthrough ?? [], row.id);
    assert.equal(overflow, row.expected_overflow, row.id);
  }
});

test("a restored browser page rechecks socket liveness and authoritative sync", async () => {
  const source = await readFile(new URL("../../src/lib/ws.ts", import.meta.url), "utf8");
  assert.match(source, /window\.addEventListener\("pageshow", classifyWake\)/);
  assert.match(source, /window\.removeEventListener\("pageshow", classifyWake\)/);
});

test("web multipart resume satisfies the shared reliability contract", async () => {
  for (const row of (await contract()).media_resume_cases) {
    assert.deepEqual(
      missingMultipartParts(row.part_count, row.uploaded_parts),
      row.expected_missing,
      row.id,
    );
  }
});

test("multipart completion adopts a newer provider ETag only for the same retained bytes", () => {
  const checksums = new Map([[1, "same-bytes"], [2, "same-tail"]]);
  assert.deepEqual(
    verifiedMultipartCompletionParts(
      2,
      [
        { part_number: 1, etag: '"new-etag"', checksum_sha256: "same-bytes" },
        { part_number: 2, etag: '"tail-etag"', checksum_sha256: "same-tail" },
      ],
      checksums,
    ),
    [
      { part_number: 1, etag: '"new-etag"', checksum_sha256: "same-bytes" },
      { part_number: 2, etag: '"tail-etag"', checksum_sha256: "same-tail" },
    ],
  );
  assert.throws(
    () => verifiedMultipartCompletionParts(
      1,
      [{ part_number: 1, etag: '"foreign-etag"', checksum_sha256: "other-bytes" }],
      new Map([[1, "our-bytes"]]),
    ),
    /checksum did not match/,
  );
});

test("web draft conflict choices satisfy the shared reliability contract", async () => {
  for (const row of (await contract()).draft_conflict_cases) {
    assert.deepEqual(
      resolveDraftChoice(
        row.local_text,
        row.local_version,
        row.remote_text,
        row.remote_version,
        row.choice,
      ),
      {
        text: row.expected_text,
        version: row.expected_version,
        needsSync: row.expected_needs_sync,
      },
      row.id,
    );
  }
});

test("web protocol windows satisfy the shared reliability contract", async () => {
  for (const row of (await contract()).protocol_window_cases) {
    assert.equal(
      protocolCompatibility(row.client_version, row.server_min, row.server_max),
      row.expected,
      row.id,
    );
  }
});

test("web heartbeat policy satisfies the shared reliability contract", async () => {
  const fixture = await contract();
  for (const row of fixture.heartbeat_policy_cases) {
    assert.deepEqual(
      normalizeHeartbeatPolicy(row.interval_ms, row.timeout_ms),
      {
        intervalMs: row.expected_interval_ms,
        timeoutMs: row.expected_timeout_ms,
      },
      row.id,
    );
  }
  for (const row of fixture.heartbeat_action_cases) {
    assert.equal(
      heartbeatAction({
        networkAvailable: row.network_available,
        socketOpen: row.socket_open,
        waking: row.waking,
        elapsedMs: row.elapsed_ms,
        policy: { intervalMs: row.interval_ms, timeoutMs: row.timeout_ms },
      }),
      row.expected,
      row.id,
    );
  }
});

test("web backpressure close recovery satisfies the shared reliability contract", async () => {
  for (const row of (await contract()).backpressure_close_cases) {
    assert.equal(
      socketCloseAction({
        code: row.code,
        networkAvailable: row.network_available,
        wanted: row.wanted,
      }),
      row.expected,
      row.id,
    );
  }
});

test("web retry policy honors Retry-After without making terminal failures retryable", () => {
  assert.deepEqual(decideClientRetry(429, 1, 1_000, 1, 60_000), {
    state: "queued",
    nextAttemptAt: 61_000,
  });
  assert.deepEqual(decideClientRetry(403, 1, 1_000, 1, 60_000), {
    state: "blocked",
    nextAttemptAt: 0,
  });
});
