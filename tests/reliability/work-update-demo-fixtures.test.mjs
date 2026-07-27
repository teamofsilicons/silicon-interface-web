import assert from "node:assert/strict";
import test from "node:test";

import { workUpdateDemoAvailable } from "../../src/lib/work-update-demo-access.ts";
import {
  FITNESS_DEMO_ESTIMATE_SECONDS,
  FITNESS_DEMO_REALISTIC_SECONDS,
  FITNESS_DEMO_STAGES,
  buildFitnessDemoScene,
  fitnessDemoStage,
  nextFitnessDemoStage,
  previousFitnessDemoStage,
} from "../../src/lib/work-update-demo-fixtures.ts";
import { addWorkEstimateBuffer } from "../../src/lib/work-update-time.ts";
import { parseWorkTimelineRecord } from "../../src/lib/work-update-validation.ts";

const NOW = "2026-07-23T12:30:00.000Z";

function workRecords(scene) {
  return scene.timeline
    .filter((item) => item.kind === "work")
    .map((item) => item.record);
}

function workTask(scene) {
  return workRecords(scene).find((record) => record.type === "m.work_task")?.task;
}

function workEvents(scene) {
  return workRecords(scene)
    .filter((record) => record.type === "m.work_event")
    .map((record) => record.event);
}

function eventKind(scene, kind) {
  return workEvents(scene).find((event) => event.kind === kind);
}

function historyKeys(entries) {
  return entries.map((entry) => `${entry.history_id}:${entry.revision}`);
}

function assertPrefix(previous, current, message) {
  assert.deepEqual(
    current.slice(0, previous.length),
    previous,
    message,
  );
}

test("work-update demo access is development-only", () => {
  assert.equal(workUpdateDemoAvailable("development"), true);
  assert.equal(workUpdateDemoAvailable("production"), false);
  assert.equal(workUpdateDemoAvailable("test"), false);
  assert.equal(workUpdateDemoAvailable(undefined), false);
});

test("work-update demo stage parsing and navigation are deterministic", () => {
  assert.equal(fitnessDemoStage("blocked"), "blocked");
  assert.equal(fitnessDemoStage("not-a-stage"), "kickoff");
  assert.equal(fitnessDemoStage(null), "kickoff");
  assert.equal(previousFitnessDemoStage("kickoff"), null);
  assert.equal(nextFitnessDemoStage("kickoff"), "parallel-work");
  assert.equal(previousFitnessDemoStage("completed"), "resumed");
  assert.equal(nextFitnessDemoStage("completed"), null);
});

test("every staged work card round-trips through the canonical validator", () => {
  for (const stage of FITNESS_DEMO_STAGES) {
    const scene = buildFitnessDemoScene(stage, NOW);
    for (const record of workRecords(scene)) {
      const content = record.type === "m.work_task" ? record.task : record.event;
      assert.deepEqual(
        parseWorkTimelineRecord(record.type, content),
        record,
        `${stage} ${record.type} fixture must stay canonical`,
      );
    }
  }
});

test("the fake run covers the complete successful Build a Fitness App story", () => {
  const scenes = Object.fromEntries(
    FITNESS_DEMO_STAGES.map((stage) => [stage, buildFitnessDemoScene(stage, NOW)]),
  );

  const kickoffMessages = scenes.kickoff.timeline.filter((item) => item.kind === "message");
  assert.equal(kickoffMessages[0].mine, true);
  assert.match(kickoffMessages[0].event.content.body, /fitness app/i);
  assert.equal(kickoffMessages[1].event.is_final, false);
  assert.equal(kickoffMessages[1].event.content.work_continues, true);
  assert.equal(
    scenes.kickoff.timeline.some((item) => item.kind === "manager" && item.group.display === "active"),
    true,
  );

  const allTodoStates = new Set(
    FITNESS_DEMO_STAGES.flatMap((stage) =>
      workTask(scenes[stage]).todos.map((todo) => todo.state)),
  );
  assert.deepEqual(
    [...allTodoStates].sort(),
    ["blocked", "completed", "in_progress", "yet_to_start"].sort(),
  );

  const workerGroup = eventKind(scenes["parallel-work"], "worker_group");
  assert.equal(workerGroup.workers.length, 3);
  assert.equal(workerGroup.workers.some((worker) => worker.state === "in_progress"), true);
  assert.equal(workerGroup.workers.some((worker) => worker.state === "yet_to_start"), true);

  const outbound = workEvents(scenes["parallel-work"])
    .find((event) => event.kind === "call" && event.direction === "outbound");
  assert.equal(outbound.state, "connecting");
  const completedOutbound = workEvents(scenes.milestone)
    .find((event) => event.kind === "call" && event.direction === "outbound");
  assert.equal(completedOutbound.state, "completed");
  assert.equal(completedOutbound.transcript.length, 3);

  assert.ok(eventKind(scenes.milestone, "milestone"));
  const inbound = workEvents(scenes.milestone)
    .find((event) => event.kind === "call" && event.direction === "inbound");
  assert.equal(inbound.state, "in_progress");
  assert.equal(inbound.transcript.length, 2);

  const blockedTask = workTask(scenes.blocked);
  const openBlocker = eventKind(scenes.blocked, "blocker");
  assert.equal(blockedTask.state, "blocked");
  assert.equal(blockedTask.timer_state, "paused");
  assert.equal(blockedTask.timer_pause_reason, "blocker");
  assert.equal(openBlocker.state, "open");
  assert.equal(openBlocker.timing.timer_state, "paused");
  assert.equal(openBlocker.blocks.some((block) => block.type === "remote_browser"), true);
  assert.equal(
    openBlocker.blocks.find((block) => block.type === "remote_browser")?.ttl_minutes,
    30,
  );
  assert.equal(
    scenes.blocked.timeline.some((item) => item.kind === "manager" && item.group.display === "history"),
    true,
  );

  const resumedTask = workTask(scenes.resumed);
  const resolvedBlocker = eventKind(scenes.resumed, "blocker");
  assert.equal(resumedTask.state, "running");
  assert.equal(resumedTask.timer_state, "running");
  assert.equal(resolvedBlocker.state, "resolved");
  assert.equal(
    scenes.resumed.timeline.some((item) =>
      item.kind === "message" && item.mine && item.event.reply_to_event_id === openBlocker.work_event_id),
    true,
  );

  const completedTask = workTask(scenes.completed);
  const completion = eventKind(scenes.completed, "completion");
  assert.equal(completedTask.state, "completed");
  assert.equal(completedTask.timer_state, "stopped");
  assert.equal(completedTask.todos.every((todo) => todo.state === "completed"), true);
  assert.equal(completion.timing.timer_state, "stopped");
  assert.equal(scenes.completed.timeline.some((item) => item.kind === "manager"), false);
  const finalItem = scenes.completed.timeline.at(-1);
  assert.equal(finalItem.kind, "message");
  assert.equal(finalItem.managerActivity, undefined);
  assert.equal(finalItem.event.sender_kind, "silicon");
  assert.equal(finalItem.event.is_final, true);
  assert.equal(finalItem.event.content.work_continues, undefined);
});

test("demo revisions retain task, todo, worker, event, and transcript history", () => {
  let previousTask = null;
  const previousEvents = new Map();

  for (const stage of FITNESS_DEMO_STAGES) {
    const scene = buildFitnessDemoScene(stage, NOW);
    const task = workTask(scene);
    if (previousTask) {
      assert.equal(task.task_id, previousTask.task_id);
      assert.ok(task.revision > previousTask.revision);
      assertPrefix(
        historyKeys(previousTask.history),
        historyKeys(task.history),
        `${stage} task history must retain every earlier fact`,
      );
      for (const currentTodo of task.todos) {
        const previousTodo = previousTask.todos.find((todo) => todo.todo_id === currentTodo.todo_id);
        assert.ok(previousTodo);
        assert.ok(currentTodo.revision >= previousTodo.revision);
        assertPrefix(
          historyKeys(previousTodo.history),
          historyKeys(currentTodo.history),
          `${stage} ${currentTodo.todo_id} history must remain append-only`,
        );
      }
    }
    previousTask = task;

    for (const event of workEvents(scene)) {
      const previous = previousEvents.get(event.work_event_id);
      if (previous) {
        assert.equal(event.kind, previous.kind);
        assert.equal(event.created_at, previous.created_at);
        assert.ok(event.revision >= previous.revision);
        assertPrefix(
          historyKeys(previous.history),
          historyKeys(event.history),
          `${stage} ${event.work_event_id} history must remain append-only`,
        );
        if (event.kind === "worker_group") {
          for (const currentWorker of event.workers) {
            const previousWorker = previous.workers.find(
              (worker) => worker.invocation_id === currentWorker.invocation_id,
            );
            assert.ok(previousWorker);
            assertPrefix(
              historyKeys(previousWorker.history),
              historyKeys(currentWorker.history),
              `${stage} ${currentWorker.invocation_id} history must remain append-only`,
            );
          }
        }
        if (event.kind === "call") {
          assertPrefix(
            previous.transcript.map((entry) => entry.transcript_id),
            event.transcript.map((entry) => entry.transcript_id),
            `${stage} ${event.call_id} transcript must retain earlier messages`,
          );
        }
      }
      previousEvents.set(event.work_event_id, event);
    }
  }
});

test("the demo estimate uses the required realistic parallel estimate plus five percent", () => {
  assert.equal(
    FITNESS_DEMO_ESTIMATE_SECONDS,
    addWorkEstimateBuffer(FITNESS_DEMO_REALISTIC_SECONDS),
  );
  for (const stage of FITNESS_DEMO_STAGES) {
    assert.equal(
      workTask(buildFitnessDemoScene(stage, NOW)).estimate_seconds,
      FITNESS_DEMO_ESTIMATE_SECONDS,
    );
  }
});

test("a local blocker answer becomes the resumed Carbon reply without any transport", () => {
  const answer = "Electric blue, with strong contrast for accessibility.";
  const scene = buildFitnessDemoScene("resumed", NOW, answer);
  const reply = scene.timeline.find((item) =>
    item.kind === "message" && item.event.event_id === "demo-message-blocker-reply");
  assert.equal(reply.event.content.body, answer);
  assert.equal(reply.event.reply_to_event_id, "work-event-brand-blocker");
});
