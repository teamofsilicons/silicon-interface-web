import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeWorkTimelineEnvelopes,
  workTimelineResourceKey,
} from "../../src/lib/work-timeline-dedupe.ts";

const T0 = "2026-07-23T10:00:00.000Z";

function timing() {
  return {
    estimate_seconds: 3_780,
    active_elapsed_seconds: 120,
    timer_state: "running",
    timer_updated_at: T0,
  };
}

function taskEnvelope(eventId, revision, taskId = "task-fitness") {
  return {
    event_id: eventId,
    type: "m.work_task",
    content: {
      schema_version: 1,
      task_id: taskId,
      room_id: "room-demo",
      title: "Build Fitness App",
      description: "A focused fitness planner.",
      state: "running",
      todos: [],
      history: [],
      revision,
      created_at: T0,
      updated_at: T0,
      ...timing(),
    },
  };
}

test("work timeline resource identity is independent of the outer envelope id", () => {
  const first = taskEnvelope("outer-one", 0);
  const revision = taskEnvelope("outer-two", 1);
  assert.equal(workTimelineResourceKey(first), workTimelineResourceKey(revision));
});

test("a revised work card keeps one timeline anchor while unrelated rows survive", () => {
  const first = taskEnvelope("outer-one", 0);
  const normal = {
    event_id: "normal-message",
    type: "m.text",
    content: { body: "Still working on it." },
  };
  const revision = taskEnvelope("outer-two", 1);
  const otherTask = taskEnvelope("outer-three", 0, "task-nutrition");

  assert.deepEqual(
    dedupeWorkTimelineEnvelopes([first, normal, revision, otherTask]).map(
      (event) => event.event_id,
    ),
    ["outer-one", "normal-message", "outer-three"],
  );
});
