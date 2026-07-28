import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkUpdateCatalog,
  resolveCatalogBlocker,
  WORK_UPDATE_CATALOG_ORDER,
  WORK_UPDATE_CATALOG_SILICON,
} from "../../src/lib/work-update-catalog.ts";
import { parseWorkTimelineRecord } from "../../src/lib/work-update-validation.ts";

const NOW = "2026-07-28T00:00:00.000Z";

function workSpecimens(catalog) {
  return catalog.specimens.filter((specimen) => specimen.kind === "work");
}

function eventSpecimens(catalog) {
  return workSpecimens(catalog).flatMap((specimen) =>
    specimen.record.type === "m.work_event"
      ? [{ specimen, event: specimen.record.event }]
      : []
  );
}

test("the local catalog exposes every supported update in one deterministic order", () => {
  const first = buildWorkUpdateCatalog(NOW);
  const second = buildWorkUpdateCatalog(NOW);

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.specimens.map((specimen) => specimen.id),
    WORK_UPDATE_CATALOG_ORDER,
  );
  assert.equal(
    new Set(first.specimens.map((specimen) => specimen.id)).size,
    first.specimens.length,
  );
});

test("every catalog work specimen is a canonical production record", () => {
  const catalog = buildWorkUpdateCatalog(NOW);
  for (const specimen of workSpecimens(catalog)) {
    const content = specimen.record.type === "m.work_task"
      ? specimen.record.task
      : specimen.record.event;
    assert.deepEqual(
      parseWorkTimelineRecord(specimen.record.type, content),
      specimen.record,
      `${specimen.id} must pass the production work-update validator`,
    );
  }
});

test("the catalog covers every persistent event kind and every Todo state", () => {
  const catalog = buildWorkUpdateCatalog(NOW);
  const kinds = new Set(eventSpecimens(catalog).map(({ event }) => event.kind));
  assert.deepEqual(
    kinds,
    new Set([
      "milestone",
      "blocker",
      "completion",
      "failure",
      "cancellation",
      "worker_group",
      "call",
    ]),
  );
  const todoSpecimen = workSpecimens(catalog).find(
    (specimen) => specimen.id === "todo",
  );
  assert.ok(todoSpecimen?.record.type === "m.work_task");
  assert.deepEqual(
    new Set(todoSpecimen.record.task.todos.map((todo) => todo.state)),
    new Set(["yet_to_start", "in_progress", "completed", "blocked"]),
  );
});

test("manager, Silicon, inbound, failed, cancelled, and standalone calls are inspectable", () => {
  const catalog = buildWorkUpdateCatalog(NOW);
  const calls = eventSpecimens(catalog).flatMap(({ specimen, event }) =>
    event.kind === "call" ? [{ id: specimen.id, event }] : []
  );
  const manager = calls.find(({ id }) => id === "calling-manager")?.event;
  assert.equal(manager?.direction, "outbound");
  assert.equal(manager?.target_kind, "manager");
  assert.equal(manager?.task_id, null);
  assert.equal(manager?.state, "connecting");
  assert.ok(calls.some(({ event }) =>
    event.direction === "outbound" &&
    event.target_kind === "silicon" &&
    event.state === "completed"
  ));
  assert.ok(calls.some(({ event }) => event.direction === "inbound"));
  assert.ok(calls.some(({ event }) => event.state === "failed"));
  assert.ok(calls.some(({ event }) => event.state === "cancelled"));
});

test("worker, task, timer, and manager replacement states are all visible", () => {
  const catalog = buildWorkUpdateCatalog(NOW);
  const workerStates = new Set(
    eventSpecimens(catalog).flatMap(({ event }) =>
      event.kind === "worker_group"
        ? event.workers.map((worker) => worker.state)
        : []
    ),
  );
  assert.deepEqual(
    workerStates,
    new Set([
      "yet_to_start",
      "in_progress",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ]),
  );

  const tasks = new Map(
    workSpecimens(catalog).flatMap((specimen) =>
      specimen.record.type === "m.work_task"
        ? [[specimen.id, specimen.record.task]]
        : []
    ),
  );
  assert.equal(tasks.get("queued-task")?.state, "queued");
  assert.equal(tasks.get("queued-task")?.timer_state, "running");
  assert.equal(tasks.get("waiting-on-silicon")?.timer_state, "running");
  assert.equal(tasks.get("rate-limited-pause")?.timer_pause_reason, "rate_limited");
  assert.equal(tasks.get("offline-pause")?.timer_pause_reason, "offline");
  assert.equal(tasks.get("infrastructure-pause")?.timer_pause_reason, "infrastructure");
  assert.equal(tasks.get("failed-task")?.state, "failed");
  assert.equal(tasks.get("failed-task")?.timer_state, "stopped");
  assert.equal(tasks.get("cancelled-task")?.state, "cancelled");
  assert.equal(tasks.get("cancelled-task")?.timer_state, "stopped");

  const managerFinal = catalog.specimens.find(
    (specimen) => specimen.id === "manager-final-history",
  );
  assert.equal(managerFinal?.kind, "message");
  assert.equal(managerFinal?.managerActivity?.display, "history");
  assert.equal(
    managerFinal?.managerActivity?.replaced_by_event_id,
    "catalog-message-manager-final-history",
  );
});

test("multiple blockers stay independently anchored and rich blocker content is complete", () => {
  const catalog = buildWorkUpdateCatalog(NOW);
  const blockers = eventSpecimens(catalog).flatMap(({ specimen, event }) =>
    event.kind === "blocker" ? [{ specimen, event }] : []
  );
  assert.equal(blockers.length, 2);
  assert.equal(new Set(blockers.map(({ event }) => event.blocker_id)).size, 2);
  assert.ok(blockers.every(({ event }) => event.state === "open"));

  const rich = blockers.find(
    ({ specimen }) => specimen.id === "blocker-primary-color",
  )?.event;
  assert.ok(rich);
  assert.deepEqual(
    new Set(rich.blocks.map((block) => block.type)),
    new Set(["text", "image", "file", "remote_browser"]),
  );

  const firstIndex = catalog.specimens.findIndex(
    (specimen) => specimen.id === "blocker-primary-color",
  );
  const secondIndex = catalog.specimens.findIndex(
    (specimen) => specimen.id === "blocker-reminders",
  );
  const firstRecord = catalog.specimens[firstIndex].record;
  const secondRecord = catalog.specimens[secondIndex].record;
  const resolved = resolveCatalogBlocker(
    firstRecord,
    "Use electric blue.",
    NOW,
  );

  assert.equal(resolved.type, "m.work_event");
  assert.equal(resolved.event.kind, "blocker");
  assert.equal(resolved.event.state, "resolved");
  assert.equal(resolved.event.revision, firstRecord.event.revision + 1);
  assert.equal(secondRecord.event.kind, "blocker");
  assert.equal(secondRecord.event.state, "open");
  assert.equal(catalog.specimens[firstIndex].id, "blocker-primary-color");
  assert.equal(catalog.specimens[secondIndex].id, "blocker-reminders");
});

test("the responsible Silicon identity is shared by every Silicon-authored specimen", () => {
  const catalog = buildWorkUpdateCatalog(NOW);
  assert.deepEqual(WORK_UPDATE_CATALOG_SILICON, {
    id: "fitness-builder",
    name: "Fitness Builder",
    family: "silicon",
  });
  assert.ok(catalog.specimens.every((specimen) =>
    specimen.kind !== "message" || specimen.sender !== "silicon" ||
    WORK_UPDATE_CATALOG_SILICON.id === "fitness-builder"
  ));
});
