import assert from "node:assert/strict";
import test from "node:test";

import {
  isResolvedWorkBlocker,
  parsedWorkRecord,
  workEventCountsAsUnread,
  workEventPreview,
  workNotificationTier,
  workRecordSearchText,
} from "../../src/lib/work-update-presentation.ts";
import { isUnreadEligibleEvent } from "../../src/lib/unread-boundary.ts";

const NOW = "2026-07-23T08:00:00.000Z";

function timing(overrides = {}) {
  return {
    estimate_seconds: 3_600,
    active_elapsed_seconds: 120,
    timer_state: "running",
    timer_updated_at: NOW,
    ...overrides,
  };
}

function event(type, content) {
  return {
    event_id: `event-${content.work_event_id ?? content.task_id}`,
    room: 1,
    sender_kind: "silicon",
    sender_id: 2,
    sender_handle: "builder",
    type,
    content,
    reply_to_event_id: "",
    is_final: true,
    created_at: NOW,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

function task(overrides = {}) {
  return event("m.work_task", {
    schema_version: 1,
    task_id: "task-1",
    room_id: "room-1",
    title: "Build Fitness App",
    description: "Ship the app",
    state: "running",
    todos: [],
    history: [],
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    ...timing(),
    ...overrides,
  });
}

function work(kind, overrides = {}) {
  return event("m.work_event", {
    schema_version: 1,
    work_event_id: `${kind}-1`,
    task_id: "task-1",
    room_id: "room-1",
    task_title: "Build Fitness App",
    kind,
    body: "UI and UX are complete",
    blocks: [],
    timing: timing(),
    history: [],
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

test("root tasks and in-chat operational cards persist without creating unread noise", () => {
  const root = task();
  const workers = work("worker_group", { group_id: "group-1", workers: [] });
  assert.equal(workEventPreview(root), "Started · Build Fitness App");
  assert.equal(workEventCountsAsUnread(root), false);
  assert.equal(workNotificationTier(workers), "none");
  assert.equal(isUnreadEligibleEvent(workers), false);
});

test("major updates, blockers, and terminal cards follow their notification tiers", () => {
  const milestone = work("milestone");
  const blocker = work("blocker", {
    blocker_id: "blocker-1",
    state: "open",
    resolved_at: null,
    body: "Should the primary color be red or blue?",
    timing: timing({ timer_state: "paused", timer_pause_reason: "blocker" }),
  });
  const resolved = work("blocker", {
    blocker_id: "blocker-1",
    state: "resolved",
    resolved_at: NOW,
    timing: timing({ timer_state: "paused", timer_pause_reason: "blocker" }),
  });
  const complete = work("completion", {
    timing: timing({ timer_state: "stopped" }),
  });

  assert.equal(workNotificationTier(milestone), "in_app");
  assert.equal(workNotificationTier(blocker), "prominent_push");
  assert.equal(workNotificationTier(resolved), "none");
  assert.equal(isResolvedWorkBlocker(blocker), false);
  assert.equal(isResolvedWorkBlocker(resolved), true);
  assert.equal(workNotificationTier(complete), "push");
  assert.equal(workEventPreview(blocker), "Blocker · Build Fitness App: Should the primary color be red or blue?");
  assert.equal(isUnreadEligibleEvent(blocker), true);
  assert.equal(isUnreadEligibleEvent(resolved), false);
});

test("rich call transcript content participates in local search", () => {
  const call = work("call", {
    call_id: "call-1",
    direction: "inbound",
    target_kind: "silicon",
    target_id: "cos",
    target_name: "COS Silicon",
    state: "completed",
    transcript: [{
      transcript_id: "line-1",
      speaker_kind: "silicon",
      speaker_id: "cos",
      speaker_name: "COS Silicon",
      body: "Use the blue accessibility palette",
      blocks: [{ type: "text", body: "Contrast has been verified", format: "plain" }],
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    }],
  });
  const record = parsedWorkRecord(call);
  assert.ok(record);
  assert.match(workRecordSearchText(record), /blue accessibility palette/);
  assert.match(workRecordSearchText(record), /Contrast has been verified/);
  assert.equal(workEventPreview(call), "Received call from COS Silicon");
});

test("standalone calls keep call previews and search without a task heading", () => {
  const call = work("call", {
    task_id: null,
    task_title: null,
    timing: null,
    call_id: "call-standalone",
    direction: "outbound",
    target_kind: "manager",
    target_id: "architecture-manager",
    target_name: "Architecture manager",
    state: "in_progress",
    transcript: [{
      transcript_id: "line-standalone",
      speaker_kind: "manager",
      speaker_id: "local-manager",
      speaker_name: "My manager",
      body: "Please review the system design",
      blocks: [],
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    }],
  });
  const record = parsedWorkRecord(call);
  assert.ok(record);
  assert.equal(record.event.kind, "call");
  assert.equal(record.event.task_id, null);
  assert.equal(workEventPreview(call), "Calling Architecture manager");
  assert.match(workRecordSearchText(record), /review the system design/);
});

test("invalid work payloads fail closed", () => {
  const invalid = event("m.work_event", { kind: "blocker", body: "missing identity" });
  assert.equal(parsedWorkRecord(invalid), null);
  assert.equal(workEventPreview(invalid), null);
  assert.equal(workEventCountsAsUnread(invalid), false);
  assert.equal(workNotificationTier(invalid), "none");
});
