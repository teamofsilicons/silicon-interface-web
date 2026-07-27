import assert from "node:assert/strict";
import test from "node:test";

import {
  activeWorkTasks,
  createWorkUpdateState,
  mergeWorkPersistentEvent,
  mergeWorkTaskSnapshot,
  openWorkBlockers,
  reduceWorkTimelineRecord,
  reduceWorkTimelineRecords,
  workEventsForTask,
} from "../../src/lib/work-update-state.ts";
import {
  parseWorkPersistentEvent,
  parseWorkTaskSnapshot,
  parseWorkTimingSnapshot,
  parseWorkTimelineRecord,
} from "../../src/lib/work-update-validation.ts";

const T0 = "2026-07-23T08:00:00.000Z";
const T1 = "2026-07-23T08:01:00.000Z";
const T2 = "2026-07-23T08:02:00.000Z";

function history(history_id, summary, revision = 0, created_at = T0, kind = "note") {
  return { history_id, kind, summary, revision, created_at };
}

function timing(overrides = {}) {
  return {
    estimate_seconds: 21_600,
    active_elapsed_seconds: 120,
    timer_state: "running",
    timer_updated_at: T0,
    ...overrides,
  };
}

function todo(overrides = {}) {
  return {
    todo_id: "todo-ui",
    title: "Build UI",
    description: "Build the task card",
    state: "in_progress",
    revision: 0,
    history: [history("todo-started", "Started UI", 0, T0, "todo_updated")],
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    schema_version: 1,
    task_id: "task-fitness",
    room_id: "room-1",
    title: "Build Fitness App",
    description: "Setting the project in motion",
    state: "running",
    ...timing(),
    todos: [todo()],
    history: [history("task-created", "Task created", 0, T0, "task_created")],
    revision: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function eventBase(kind, work_event_id, overrides = {}) {
  return {
    schema_version: 1,
    work_event_id,
    task_id: "task-fitness",
    room_id: "room-1",
    task_title: "Build Fitness App",
    kind,
    body: "Work is moving",
    blocks: [],
    timing: timing(),
    history: [history(`${work_event_id}-created`, "Card created", 0, T0)],
    revision: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function blocker(id, overrides = {}) {
  return eventBase("blocker", `event-${id}`, {
    blocker_id: id,
    state: "open",
    resolved_at: null,
    body: `Need an answer for ${id}`,
    timing: timing({ timer_state: "paused", timer_pause_reason: "blocker" }),
    ...overrides,
  });
}

function standaloneCall(overrides = {}) {
  return eventBase("call", "event-standalone-call", {
    task_id: null,
    task_title: null,
    timing: null,
    body: "Calling Architecture Silicon",
    call_id: "call-standalone",
    direction: "outbound",
    target_kind: "silicon",
    target_id: "architecture",
    target_name: "Architecture Silicon",
    state: "connecting",
    transcript: [],
    ...overrides,
  });
}

test("wire validators accept the complete rich task/event contract", () => {
  const parsedTask = parseWorkTaskSnapshot(task());
  assert.equal(parsedTask?.task_id, "task-fitness");
  assert.equal(parsedTask?.todos[0].state, "in_progress");

  const parsed = parseWorkPersistentEvent(blocker("primary-colour", {
    blocks: [
      { type: "text", body: "Should it be red or blue?", format: "markdown" },
      { type: "image", media_id: "media-1", mime: "image/png", width: 1200, height: 800 },
      { type: "file", media_id: "media-2", filename: "brief.pdf", size_bytes: 42 },
      { type: "voice", media_id: "media-3", duration_ms: 3_000 },
      { type: "remote_browser", url: "https://browser.silicon.test/session/1", ttl_minutes: 30, closed: false },
    ],
  }));
  assert.equal(parsed?.kind, "blocker");
  assert.equal(parsed?.blocks.length, 5);
  assert.equal(parsed?.blocks[4]?.ttl_minutes, 30);
  assert.deepEqual(parseWorkTimelineRecord("m.work_event", parsed), {
    type: "m.work_event",
    event: parsed,
  });
});

test("standalone calls validate without fabricated task context or timing", () => {
  const parsed = parseWorkPersistentEvent(standaloneCall());
  assert.equal(parsed?.kind, "call");
  assert.equal(parsed?.task_id, null);
  assert.equal(parsed?.task_title, null);
  assert.equal(parsed?.timing, null);

  assert.equal(parseWorkPersistentEvent(standaloneCall({ task_id: "task-fitness" })), null);
  assert.equal(parseWorkPersistentEvent(standaloneCall({
    task_id: "task-fitness",
    task_title: "Build Fitness App",
  })), null);
  assert.equal(parseWorkPersistentEvent(standaloneCall({ timing: timing() })), null);
});

test("wire validators reject ambiguous identities, unsafe blocks, and invalid blocker states", () => {
  assert.equal(parseWorkTaskSnapshot(task({ schema_version: 2 })), null);
  assert.equal(parseWorkTaskSnapshot(task({ todos: [todo(), todo()] })), null);
  assert.equal(parseWorkTaskSnapshot(task({ revision: 1.5 })), null);
  assert.equal(parseWorkPersistentEvent(blocker("unsafe", {
    blocks: [{ type: "remote_browser", url: "javascript:alert(1)" }],
  })), null);
  assert.equal(parseWorkPersistentEvent(blocker("invalid-browser-ttl", {
    blocks: [{ type: "remote_browser", url: "https://browser.silicon.test/session/1", ttl_minutes: 0 }],
  })), null);
  assert.equal(parseWorkPersistentEvent(blocker("open-with-date", {
    resolved_at: T1,
  })), null);
  assert.equal(parseWorkPersistentEvent(blocker("resolved-without-date", {
    state: "resolved",
    resolved_at: null,
  })), null);
  const duplicateTranscript = {
    transcript_id: "line-1",
    speaker_kind: "manager",
    speaker_id: "manager-1",
    speaker_name: "Manager",
    body: "Checking in",
    blocks: [],
    revision: 0,
    created_at: T0,
    updated_at: T0,
  };
  assert.equal(parseWorkPersistentEvent(eventBase("call", "event-call-duplicates", {
    call_id: "call-duplicates",
    direction: "outbound",
    target_kind: "silicon",
    target_id: "social",
    target_name: "Social Silicon",
    state: "in_progress",
    transcript: [duplicateTranscript, { ...duplicateTranscript, body: "Duplicate" }],
  })), null);
  assert.equal(parseWorkTimelineRecord("m.text", task()), null);
});

test("wire validators enforce terminal and open-blocker timer invariants", () => {
  for (const state of ["completed", "failed", "cancelled"]) {
    assert.equal(parseWorkTaskSnapshot(task({ state })), null);
    assert.equal(
      parseWorkTaskSnapshot(task({ state, timer_state: "stopped" }))?.state,
      state,
    );
  }

  assert.equal(parseWorkTaskSnapshot(task({ state: "blocked" })), null);
  assert.equal(parseWorkTaskSnapshot(task({
    state: "blocked",
    timer_state: "paused",
    timer_pause_reason: "blocker",
  }))?.state, "blocked");

  for (const state of ["queued", "running"]) {
    assert.equal(parseWorkTaskSnapshot(task({ state, timer_state: "stopped" })), null);
    assert.equal(parseWorkTaskSnapshot(task({
      state,
      timer_state: "paused",
      timer_pause_reason: "blocker",
    })), null);
    for (const timer_pause_reason of ["rate_limited", "offline", "infrastructure"]) {
      assert.equal(parseWorkTaskSnapshot(task({
        state,
        timer_state: "paused",
        timer_pause_reason,
      }))?.state, state);
    }
    assert.equal(parseWorkTaskSnapshot(task({ state }))?.timer_state, "running");
  }

  for (const kind of ["completion", "failure", "cancellation"]) {
    assert.equal(parseWorkPersistentEvent(eventBase(kind, `event-${kind}`)), null);
    assert.equal(
      parseWorkPersistentEvent(eventBase(kind, `event-${kind}`, {
        timing: timing({ timer_state: "stopped" }),
      }))?.kind,
      kind,
    );
  }

  assert.equal(parseWorkPersistentEvent(blocker("running", {
    timing: timing(),
  })), null);
  assert.equal(parseWorkPersistentEvent(blocker("wrong-pause-reason", {
    timing: timing({ timer_state: "paused", timer_pause_reason: "offline" }),
  })), null);

  assert.equal(parseWorkTimingSnapshot(timing({ timer_state: "paused" })), null);
  assert.equal(parseWorkPersistentEvent(eventBase("milestone", "event-reasonless-pause", {
    timing: timing({ timer_state: "paused" }),
  })), null);
  assert.equal(parseWorkPersistentEvent(eventBase("milestone", "event-offline-pause", {
    timing: timing({ timer_state: "paused", timer_pause_reason: "offline" }),
  }))?.timing.timer_pause_reason, "offline");
});

test("root snapshots update in place while all history revisions survive", () => {
  const original = task();
  const current = task({
    title: "Build Fitness App v2",
    description: "UI is done; implementing code",
    revision: 2,
    updated_at: T2,
    todos: [todo({
      state: "completed",
      revision: 2,
      updated_at: T2,
      history: [history("todo-started", "UI finished", 1, T2, "todo_updated")],
    })],
    history: [history("task-created", "Task definition corrected", 1, T2, "task_updated")],
  });

  const merged = mergeWorkTaskSnapshot(current, original);
  assert.equal(merged.revision, 2);
  assert.equal(merged.title, "Build Fitness App v2");
  assert.equal(merged.todos[0].state, "completed");
  assert.deepEqual(
    merged.history.map((entry) => [entry.history_id, entry.revision, entry.summary]),
    [
      ["task-created", 0, "Task created"],
      ["task-created", 1, "Task definition corrected"],
    ],
  );
  assert.deepEqual(
    merged.todos[0].history.map((entry) => entry.summary),
    ["Started UI", "UI finished"],
  );
});

test("a malformed revision cannot erase previous task and todo details", () => {
  const original = task();
  const incoming = task({
    title: "Build Fitness App — launch",
    description: "Shipping the final build",
    state: "running",
    revision: 3,
    updated_at: T2,
    history: original.history,
    todos: [todo({
      title: "Ship the app",
      description: "Publish production artifacts",
      state: "in_progress",
      revision: 3,
      updated_at: T2,
      history: original.todos[0].history,
    })],
  });

  const merged = mergeWorkTaskSnapshot(original, incoming);
  assert.match(
    merged.history.find((entry) => entry.actor_name === "Silicon Interface")?.body ?? "",
    /Build Fitness App/,
  );
  assert.match(
    merged.todos[0].history.find((entry) => entry.actor_name === "Silicon Interface")?.body ?? "",
    /Build UI/,
  );
});

test("snapshot reconciliation is replay-idempotent and order-independent", () => {
  const v1 = task();
  const v2 = task({
    revision: 1,
    updated_at: T1,
    description: "First milestone reached",
    history: [history("milestone", "UI done", 0, T1, "milestone")],
  });
  const forward = reduceWorkTimelineRecords([
    { type: "m.work_task", task: v1 },
    { type: "m.work_task", task: v2 },
    { type: "m.work_task", task: v2 },
  ]);
  const reverse = reduceWorkTimelineRecords([
    { type: "m.work_task", task: v2 },
    { type: "m.work_task", task: v1 },
  ]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.tasks["task-fitness"].history.length, 2);
  assert.deepEqual(forward.task_order, ["task-fitness"]);
});

test("multiple blockers coexist and resolving one revises only its card", () => {
  let state = createWorkUpdateState();
  state = reduceWorkTimelineRecord(state, {
    type: "m.work_event",
    event: blocker("primary-colour"),
  });
  state = reduceWorkTimelineRecord(state, {
    type: "m.work_event",
    event: blocker("logo-choice", { created_at: T1, updated_at: T1 }),
  });
  assert.deepEqual(
    openWorkBlockers(state, "task-fitness").map((item) => item.blocker_id),
    ["primary-colour", "logo-choice"],
  );

  state = reduceWorkTimelineRecord(state, {
    type: "m.work_event",
    event: blocker("primary-colour", {
      state: "resolved",
      resolved_at: T2,
      revision: 1,
      updated_at: T2,
      history: [history("blocker-resolved", "Carbon chose blue", 0, T2, "blocker_resolved")],
    }),
  });
  assert.deepEqual(
    openWorkBlockers(state, "task-fitness").map((item) => item.blocker_id),
    ["logo-choice"],
  );
  assert.equal(state.events["event-primary-colour"].history.length, 2);
});

test("worker invocation and call transcript revisions cannot be undone by stale cards", () => {
  const workerV1 = eventBase("worker_group", "event-workers", {
    group_id: "group-1",
    workers: [{
      worker_id: "worker-a",
      invocation_id: "invoke-a",
      name: "Build UI",
      description: "Implement the cards",
      state: "in_progress",
      revision: 0,
      history: [history("worker-a-start", "Worker started", 0, T0, "worker_updated")],
      created_at: T0,
      updated_at: T0,
    }],
  });
  const workerV2 = {
    ...workerV1,
    revision: 1,
    updated_at: T2,
    workers: [
      { ...workerV1.workers[0], state: "completed", revision: 1, updated_at: T2 },
      {
        worker_id: "worker-b",
        invocation_id: "invoke-b",
        name: "Write tests",
        description: "Cover replay",
        state: "in_progress",
        revision: 0,
        history: [],
        created_at: T1,
        updated_at: T1,
      },
    ],
  };
  const workers = mergeWorkPersistentEvent(workerV2, workerV1);
  assert.equal(workers.kind, "worker_group");
  assert.deepEqual(workers.workers.map((worker) => worker.state), ["completed", "in_progress"]);

  const firstLine = {
    transcript_id: "line-1",
    speaker_kind: "manager",
    speaker_id: "manager-local",
    speaker_name: "My manager",
    body: "Can you help?",
    blocks: [],
    revision: 0,
    created_at: T0,
    updated_at: T0,
  };
  const callV1 = eventBase("call", "event-call", {
    call_id: "call-1",
    direction: "outbound",
    target_kind: "silicon",
    target_id: "social",
    target_name: "Social Silicon",
    state: "in_progress",
    transcript: [firstLine],
  });
  const callV2 = {
    ...callV1,
    state: "completed",
    revision: 1,
    updated_at: T2,
    transcript: [
      firstLine,
      {
        ...firstLine,
        transcript_id: "line-2",
        speaker_kind: "silicon",
        speaker_id: "social",
        speaker_name: "Social Silicon",
        body: "Here is the answer",
        created_at: T1,
        updated_at: T1,
      },
    ],
  };
  const call = mergeWorkPersistentEvent(callV2, callV1);
  assert.equal(call.kind, "call");
  assert.equal(call.state, "completed");
  assert.deepEqual(call.transcript.map((line) => line.body), ["Can you help?", "Here is the answer"]);
});

test("standalone call revisions persist without entering a task index", () => {
  const started = standaloneCall();
  const answered = standaloneCall({
    state: "completed",
    revision: 1,
    updated_at: T2,
    transcript: [{
      transcript_id: "line-standalone-1",
      speaker_kind: "silicon",
      speaker_id: "architecture",
      speaker_name: "Architecture Silicon",
      body: "Here is the architecture",
      blocks: [],
      revision: 0,
      created_at: T1,
      updated_at: T1,
    }],
  });
  const state = reduceWorkTimelineRecords([
    { type: "m.work_event", event: started },
    { type: "m.work_event", event: answered },
    { type: "m.work_task", task: task() },
  ]);

  assert.deepEqual(state.event_order, ["event-standalone-call"]);
  assert.deepEqual(state.task_event_ids, {});
  assert.equal(state.events["event-standalone-call"].kind, "call");
  assert.equal(state.events["event-standalone-call"].state, "completed");
  assert.deepEqual(
    state.events["event-standalone-call"].transcript.map((entry) => entry.body),
    ["Here is the architecture"],
  );
  assert.deepEqual(workEventsForTask(state, "task-fitness"), []);

  assert.throws(
    () => mergeWorkPersistentEvent(started, {
      ...answered,
      task_id: "task-fitness",
      task_title: "Build Fitness App",
      timing: timing(),
    }),
    /immutable identity/,
  );
});

test("cards for concurrent tasks remain independently addressable", () => {
  const second = task({
    task_id: "task-report",
    title: "Prepare report",
    created_at: T1,
    updated_at: T1,
    state: "queued",
  });
  const done = task({
    task_id: "task-done",
    title: "Finished task",
    created_at: T2,
    updated_at: T2,
    state: "completed",
    timer_state: "stopped",
  });
  const state = reduceWorkTimelineRecords([
    { type: "m.work_task", task: task() },
    { type: "m.work_task", task: second },
    { type: "m.work_task", task: done },
    { type: "m.work_event", event: eventBase("completion", "event-complete", {
      task_id: "task-done",
      task_title: "Finished task",
      created_at: T2,
      updated_at: T2,
      timing: timing({ timer_state: "stopped", timer_updated_at: T2 }),
    }) },
  ]);
  assert.deepEqual(activeWorkTasks(state).map((item) => item.task_id), [
    "task-fitness",
    "task-report",
  ]);
  assert.equal(workEventsForTask(state, "task-done")[0].kind, "completion");
});

test("stable resource ids cannot be silently rebound", () => {
  assert.throws(
    () => mergeWorkTaskSnapshot(task(), task({ room_id: "room-2" })),
    /immutable identity/,
  );
  assert.throws(
    () => mergeWorkPersistentEvent(blocker("one"), {
      ...blocker("one"),
      blocker_id: "different",
    }),
    /blocker_id/,
  );
});

test("root tasks and child cards cannot be linked across rooms", () => {
  const root = task();
  const foreignEvent = eventBase("milestone", "event-foreign", {
    room_id: "room-foreign",
  });

  assert.throws(
    () => reduceWorkTimelineRecords([
      { type: "m.work_task", task: root },
      { type: "m.work_event", event: foreignEvent },
    ]),
    /room identities disagree/,
  );
  assert.throws(
    () => reduceWorkTimelineRecords([
      { type: "m.work_event", event: foreignEvent },
      { type: "m.work_task", task: root },
    ]),
    /room identities disagree/,
  );
});
