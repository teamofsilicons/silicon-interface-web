import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createManagerActivityState,
  eventReplacesManagerActivity,
  getManagerActivityGroup,
  managerActivityLabel,
  managerActivityGroupKey,
  normalizeManagerActivityFrame,
  reduceManagerActivityFrame,
  resolveManagerActivityForSettlement,
  settleManagerActivity,
  visibleManagerActivityGroups,
} from "../../src/lib/work-manager-activity.ts";
import {
  addWorkEstimateBuffer,
  formatWorkElapsed,
  formatWorkEstimate,
  shouldPauseWorkTimer,
  transitionWorkTimer,
  workElapsedSecondsAt,
  workTimingViewAt,
} from "../../src/lib/work-update-time.ts";
import { WorkManagerActivityList } from "../../src/components/chat/work-manager-activity.tsx";

const T0 = "2026-07-23T08:00:00.000Z";
const T1 = "2026-07-23T08:01:00.000Z";
const T2 = "2026-07-23T08:02:00.000Z";

function frame(state, note, occurred_at, overrides = {}) {
  return normalizeManagerActivityFrame({
    room_id: "room-1",
    progress_group_id: "run-1",
    state,
    note,
    occurred_at,
    ...overrides,
  }, { occurred_at });
}

test("manager activity renders as an expandable Silicon text row", () => {
  const activities = [{
    id: "activity-1",
    kind: "thinking",
    label: "Thinking",
    state: "active",
  }];
  const markup = renderToStaticMarkup(React.createElement(WorkManagerActivityList, {
    avatarSeed: "fitness-builder",
    avatarSrc: "/fitness-builder.png",
    avatarFamily: "silicon",
    activities,
  }));

  assert.match(markup, /src="\/fitness-builder\.png"/);
  assert.doesNotMatch(markup, /src="\/logo\.svg"/);
  assert.match(markup, /manager-activity-shimmer/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /STEPS?/);

  const identityFreeMarkup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityList,
    { activities },
  ));
  assert.doesNotMatch(identityFreeMarkup, /<img/);
});

test("legacy progress states normalize to the limited manager activity vocabulary", () => {
  const reading = frame("reading_file", "Pulling the docs", T0);
  const writing = frame("writing_file", "Writing the response", T1);
  assert.equal(reading?.kind, "reading");
  assert.equal(writing?.kind, "writing");
  assert.equal(managerActivityLabel(reading), "Pulling the docs");
  assert.equal(normalizeManagerActivityFrame({
    room_id: "room-1",
    progress_group_id: "run-1",
    kind: "typing",
  }, { occurred_at: T0 }), null);
  assert.equal(normalizeManagerActivityFrame({
    room_id: "room-1",
    state: "thinking",
  }, { occurred_at: T0 }), null, "a run identity is required for safe accumulation");
});

test("only a committed replacing Silicon message ends manager activity", () => {
  const message = {
    sender_kind: "silicon",
    type: "m.text",
    content: { body: "Done" },
    is_final: true,
  };
  assert.equal(eventReplacesManagerActivity(message), true);
  assert.equal(eventReplacesManagerActivity({ ...message, is_final: false }), false);
  assert.equal(eventReplacesManagerActivity({
    ...message,
    content: { body: "Quick note", work_continues: true },
  }), false);
  assert.equal(eventReplacesManagerActivity({ ...message, type: "m.work_event" }), false);
  assert.equal(eventReplacesManagerActivity({ ...message, sender_kind: "carbon" }), false);
});

test("activity history accumulates idempotently and stale frames do not replace current work", () => {
  const reading = frame("reading_file", "Reading docs", T0);
  const writing = frame("writing_file", "Writing code", T2);
  const stale = frame("thinking", "Thinking", T1);
  let state = createManagerActivityState();
  state = reduceManagerActivityFrame(state, reading);
  state = reduceManagerActivityFrame(state, writing);
  state = reduceManagerActivityFrame(state, stale);
  state = reduceManagerActivityFrame(state, writing);
  const group = getManagerActivityGroup(state, "room-1", "run-1");
  assert.equal(group.current.note, "Writing code");
  assert.deepEqual(group.history.map((entry) => entry.note), [
    "Reading docs",
    "Thinking",
    "Writing code",
  ]);
  assert.equal(group.display, "active");
});

test("done without a final message leaves history, while a final message replaces the row", () => {
  const reading = frame("reading_file", "Reading docs", T0);
  const done = frame("done", "", T1);
  let state = reduceManagerActivityFrame(createManagerActivityState(), reading);
  state = reduceManagerActivityFrame(state, done);
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").current, null);
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "history");
  assert.equal(visibleManagerActivityGroups(state, "room-1").length, 1);

  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T2,
    reason: "final_message",
    final_message_event_id: "message-final",
  });
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "replaced");
  assert.equal(
    getManagerActivityGroup(state, "room-1", "run-1").replaced_by_event_id,
    "message-final",
  );
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").history.length, 2);
  assert.deepEqual(visibleManagerActivityGroups(state, "room-1"), []);

  state = reduceManagerActivityFrame(state, frame("writing", "Late frame", T2));
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "replaced");
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").current, null);
});

test("settling without a message preserves an expandable history row", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("thinking", "Thinking", T0),
  );
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T1,
    reason: "done",
  });
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "history");
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").current, null);
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").history[0].note, "Thinking");
});

test("an older final message replay cannot replace newer live activity", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("writing", "Writing the answer", T2),
  );
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T1,
    reason: "final_message",
    final_message_event_id: "older-message",
  });
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "active");
  assert.equal(
    getManagerActivityGroup(state, "room-1", "run-1").current.note,
    "Writing the answer",
  );
});

test("a message id alone cannot replace activity without final-message semantics", () => {
  const state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("writing", "Writing the answer", T0),
  );
  const unchanged = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T1,
    final_message_event_id: "streaming-message",
  });
  assert.equal(unchanged, state);
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "active");
});

test("the same progress group id is isolated per room", () => {
  let state = createManagerActivityState();
  state = reduceManagerActivityFrame(state, frame("thinking", "Room one", T0));
  state = reduceManagerActivityFrame(state, frame("writing", "Room two", T1, {
    room_id: "room-2",
  }));

  assert.equal(Object.keys(state.groups).length, 2);
  assert.equal(
    state.groups[managerActivityGroupKey("room-1", "run-1")].current.note,
    "Room one",
  );
  assert.equal(
    state.groups[managerActivityGroupKey("room-2", "run-1")].current.note,
    "Room two",
  );

  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T2,
    reason: "final_message",
    final_message_event_id: "room-one-final",
  });
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "replaced");
  assert.equal(getManagerActivityGroup(state, "room-2", "run-1").display, "active");
});

test("receipt timestamps do not change a synthesized frame identity", () => {
  const wireFrame = {
    room_id: "room-1",
    progress_group_id: "run-1",
    state: "reading_file",
    note: "Reading docs",
  };
  const first = normalizeManagerActivityFrame(wireFrame, { occurred_at: T0 });
  const duplicate = normalizeManagerActivityFrame(wireFrame, { occurred_at: T1 });
  assert.equal(first.frame_id, duplicate.frame_id);

  let state = reduceManagerActivityFrame(createManagerActivityState(), first);
  state = reduceManagerActivityFrame(state, duplicate);
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").history.length, 1);
});

test("implicit settlement refuses an ambiguous room", () => {
  let state = createManagerActivityState();
  state = reduceManagerActivityFrame(state, frame("thinking", "First run", T0));
  state = reduceManagerActivityFrame(state, frame("writing", "Second run", T1, {
    progress_group_id: "run-2",
  }));

  assert.equal(resolveManagerActivityForSettlement(state, "room-1"), null);
  assert.equal(
    resolveManagerActivityForSettlement(state, "room-1", "run-1")?.progress_group_id,
    "run-1",
  );
  assert.equal(resolveManagerActivityForSettlement(state, "room-2", "run-1"), null);
});

test("elapsed time advances only while running and checkpoints across transitions", () => {
  const base = {
    estimate_seconds: 100,
    active_elapsed_seconds: 5,
    timer_state: "running",
    timer_updated_at: T0,
  };
  assert.equal(workElapsedSecondsAt(base, Date.parse(T0) + 10_900), 15);
  const paused = transitionWorkTimer(base, {
    state: "paused",
    at: "2026-07-23T08:00:10.000Z",
    pause_reason: "offline",
  });
  assert.equal(paused.active_elapsed_seconds, 15);
  assert.equal(workElapsedSecondsAt(paused, Date.parse(T1)), 15);
  const resumed = transitionWorkTimer(paused, {
    state: "running",
    at: T1,
  });
  assert.equal(workElapsedSecondsAt(resumed, Date.parse(T1) + 5_000), 20);
  const stopped = transitionWorkTimer(resumed, {
    state: "stopped",
    at: "2026-07-23T08:01:05.000Z",
  });
  assert.equal(stopped.active_elapsed_seconds, 20);
  assert.equal(stopped.timer_pause_reason, null);
  assert.throws(
    () => transitionWorkTimer(base, { state: "paused", at: T1 }),
    /pause reason/,
  );
});

test("estimates add the 5 percent safety margin and timing formatters are stable", () => {
  assert.equal(addWorkEstimateBuffer(100), 105);
  assert.equal(addWorkEstimateBuffer(21_600), 22_680);
  assert.equal(formatWorkElapsed(4_967), "01:22:47");
  assert.equal(formatWorkEstimate(21_600), "6h");
  assert.equal(formatWorkEstimate(5_460), "1h 31m");
  assert.equal(shouldPauseWorkTimer("queued"), false);
  assert.equal(shouldPauseWorkTimer("awaiting_silicon"), false);
  assert.equal(shouldPauseWorkTimer("blocker"), true);
  assert.equal(shouldPauseWorkTimer("rate_limited"), true);
  assert.equal(shouldPauseWorkTimer("offline"), true);

  const view = workTimingViewAt({
    estimate_seconds: 10,
    active_elapsed_seconds: 12,
    timer_state: "stopped",
    timer_updated_at: T0,
  }, Date.parse(T2));
  assert.equal(view.overdue, true);
  assert.equal(view.remaining_seconds, 0);
  assert.equal(view.progress, 1);
});
