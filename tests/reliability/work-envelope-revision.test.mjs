import assert from "node:assert/strict";
import test from "node:test";

import { event, installBrowser } from "./helpers.mjs";
import { loadStoredRoomEvents, storeEvents } from "../../src/lib/chat-store.ts";
import {
  eventReplayRevisionKey,
  mergeEventRevision,
} from "../../src/lib/event-revision.ts";
import {
  appendRoomEventSnippet,
  readRoomEventSnippet,
  saveRoomEventSnippet,
} from "../../src/lib/room-snippet.ts";
import { reconcileTimelineEvents } from "../../src/lib/timeline-identity.ts";

const T0 = "2026-07-28T08:00:00.000Z";
const T1 = "2026-07-28T08:01:00.000Z";

function history(historyId, kind, summary, createdAt) {
  return {
    history_id: historyId,
    kind,
    summary,
    revision: 0,
    created_at: createdAt,
  };
}

function timing(updatedAt = T0) {
  return {
    estimate_seconds: 3_600,
    active_elapsed_seconds: 120,
    timer_state: "running",
    timer_updated_at: updatedAt,
  };
}

function workTask(revision, description, updatedAt, taskHistory) {
  return {
    schema_version: 1,
    task_id: "task-fitness",
    room_id: "room-work-revision",
    title: "Build Fitness App",
    description,
    state: "running",
    ...timing(updatedAt),
    todos: [],
    history: taskHistory,
    revision,
    created_at: T0,
    updated_at: updatedAt,
  };
}

function workMilestone(revision, body, updatedAt, eventHistory) {
  return {
    schema_version: 1,
    work_event_id: "milestone-ui",
    task_id: "task-fitness",
    room_id: "room-work-revision",
    task_title: "Build Fitness App",
    kind: "milestone",
    body,
    blocks: [],
    timing: timing(updatedAt),
    history: eventHistory,
    revision,
    created_at: T0,
    updated_at: updatedAt,
  };
}

function envelope(type, content, streamPosition) {
  return {
    ...event("01K00000000000000000000001", T0, ""),
    sender_kind: "silicon",
    sender_handle: "product-silicon",
    type,
    content,
    accepted_at: T0,
    stream_position: streamPosition,
  };
}

test("same-envelope work task revisions cannot regress and retain append-only history", () => {
  const created = history("task-created", "task_created", "Task created", T0);
  const updated = history("task-updated", "task_updated", "UI complete", T1);
  const stale = envelope(
    "m.work_task",
    workTask(1, "Planning UI", T0, [created]),
    10,
  );
  const current = envelope(
    "m.work_task",
    workTask(2, "Implementing code", T1, [updated]),
    11,
  );

  const merged = mergeEventRevision(current, stale);
  assert.equal(merged.content.revision, 2);
  assert.equal(merged.content.description, "Implementing code");
  assert.equal(merged.stream_position, 11);
  assert.deepEqual(
    merged.content.history.map((entry) => entry.history_id),
    ["task-created", "task-updated"],
  );

  const reverse = mergeEventRevision(stale, current);
  assert.equal(reverse.content.revision, 2);
  assert.deepEqual(reverse.content, merged.content);
});

test("same-envelope persistent work events cannot regress", () => {
  const opened = history("milestone-opened", "milestone", "Milestone opened", T0);
  const advanced = history("milestone-advanced", "milestone", "UI complete", T1);
  const stale = envelope(
    "m.work_event",
    workMilestone(3, "UI in progress", T0, [opened]),
    20,
  );
  const current = envelope(
    "m.work_event",
    workMilestone(4, "UI complete", T1, [advanced]),
    21,
  );

  const merged = mergeEventRevision(current, stale);
  assert.equal(merged.content.revision, 4);
  assert.equal(merged.content.body, "UI complete");
  assert.deepEqual(
    merged.content.history.map((entry) => entry.history_id),
    ["milestone-opened", "milestone-advanced"],
  );
});

test("stale work snapshots cannot regress room snippet or IndexedDB persistence", async () => {
  installBrowser();
  const stale = envelope(
    "m.work_task",
    workTask(5, "Planning UI", T0, []),
    50,
  );
  const current = envelope(
    "m.work_task",
    workTask(6, "Implementing code", T1, []),
    51,
  );

  saveRoomEventSnippet("room-work-revision", [current]);
  appendRoomEventSnippet("room-work-revision", stale);
  assert.equal(
    readRoomEventSnippet("room-work-revision")[0].content.revision,
    6,
  );

  const owner = "work-envelope-revision-owner";
  await storeEvents(owner, [{ roomId: "room-work-revision", event: current }]);
  await storeEvents(owner, [{ roomId: "room-work-revision", event: stale }]);
  const stored = await loadStoredRoomEvents(owner, "room-work-revision", 10);
  assert.equal(stored[0].content.revision, 6);
});

test("WebSocket replay identity includes an inner work revision", () => {
  const first = envelope(
    "m.work_task",
    workTask(1, "Planning UI", T0, []),
    30,
  );
  const revised = envelope(
    "m.work_task",
    workTask(2, "Implementing code", T1, []),
    30,
  );

  assert.notEqual(
    eventReplayRevisionKey(first),
    eventReplayRevisionKey(revised),
  );
});

test("equal accepted timestamps use commit position before event id", () => {
  const committedFirst = {
    ...event("01K00000000000000000000002", T0, "first"),
    accepted_at: T0,
    stream_position: 40,
  };
  const committedSecond = {
    ...event("01K00000000000000000000001", T0, "second"),
    accepted_at: T0,
    stream_position: 41,
  };

  const rows = reconcileTimelineEvents(
    [],
    [committedSecond, committedFirst],
    { ownerId: "equal-accepted-at-owner", currentDevice: null },
  );
  assert.deepEqual(rows.map((row) => row.content.body), ["first", "second"]);
});
