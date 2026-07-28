import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createManagerActivityState,
  eventReplacesManagerActivity,
  getManagerActivityGroup,
  MANAGER_ACTIVITY_STALE_MS,
  managerActivityLabel,
  managerActivityGroupKey,
  managerActivityReplacementEvent,
  normalizeManagerActivityFrame,
  placeManagerActivityGroups,
  presentedManagerActivityGroups,
  publicManagerActivityNote,
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
import { WorkManagerActivityHistory } from "../../src/components/chat/work-event-card.tsx";

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

function replyEvent(event_id, progress_group_id, overrides = {}) {
  const { content = {}, ...eventOverrides } = overrides;
  return {
    event_id,
    room_id: "room-1",
    sender_kind: "silicon",
    sender_handle: "cto",
    type: "m.text",
    content: {
      body: "Here is the reply.",
      progress_group_id,
      ...content,
    },
    created_at: T1,
    edited_at: null,
    redacted_at: null,
    is_final: true,
    ...eventOverrides,
  };
}

test("active manager activity is collapsed by default", () => {
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
  assert.doesNotMatch(markup, /aria-label="Manager activity history"/);
  assert.doesNotMatch(markup, /STEPS?/);

  const identityFreeMarkup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityList,
    { activities },
  ));
  assert.doesNotMatch(identityFreeMarkup, /<img/);
});

test("settled manager activity is collapsed by default", () => {
  const activity = frame("thinking", "Thinking", T0);
  let state = reduceManagerActivityFrame(createManagerActivityState(), activity);
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T1,
    reason: "done",
  });
  const markup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityHistory,
    { group: getManagerActivityGroup(state, "room-1", "run-1") },
  ));

  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /aria-label="Manager activity history"/);
});

test("settled history uses its latest meaningful activity instead of the terminal shell", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("reading", "Reading requirements", T0),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "Paused until the decision arrives", T1),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", T2),
  );
  const markup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityHistory,
    {
      group: getManagerActivityGroup(state, "room-1", "run-1"),
      initiallyExpanded: true,
    },
  ));

  assert.match(markup, /Paused until the decision arrives/);
  assert.doesNotMatch(markup, /manager finished/i);
  const headerMarkup = markup.slice(0, markup.indexOf("<ol"));
  assert.match(headerMarkup, /Paused until the decision arrives/);
});

test("a terminal-shell-only manager group is omitted", () => {
  const state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("done", "manager finished", T1),
  );
  const markup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityHistory,
    { group: getManagerActivityGroup(state, "room-1", "run-1") },
  ));

  assert.equal(markup, "");
  assert.deepEqual(presentedManagerActivityGroups(state, "room-1"), []);
});

test("a final normal message retains collapsed manager history above its reply", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("reading", "Reading requirements", T0),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", T1),
  );
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T2,
    reason: "final_message",
    final_message_event_id: "message-final",
  });

  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "replaced");
  assert.deepEqual(visibleManagerActivityGroups(state, "room-1"), []);
  const groups = presentedManagerActivityGroups(state, "room-1");
  const placement = placeManagerActivityGroups(
    groups,
    [replyEvent("message-final", "run-1")],
  );
  assert.deepEqual(
    placement.attachedToEvent.get("message-final")?.map(
      (group) => group.progress_group_id,
    ),
    ["run-1"],
  );
  assert.deepEqual(placement.trailing, []);
});

test("settled runs sharing one final reply merge into one deduplicated history", () => {
  let state = createManagerActivityState();
  for (const [runId, at] of [["run-1", T0], ["run-2", T1]]) {
    state = reduceManagerActivityFrame(
      state,
      frame("calling", "called tool: message_manager -> architecture-silicon", at, {
        progress_group_id: runId,
      }),
    );
    state = reduceManagerActivityFrame(
      state,
      frame("done", "manager finished", at, {
        progress_group_id: runId,
        frame_id: `${runId}-done`,
      }),
    );
    state = settleManagerActivity(state, "room-1", runId, {
      occurred_at: T2,
      reason: "final_message",
      final_message_event_id: "message-final",
    });
  }

  const groups = presentedManagerActivityGroups(state, "room-1");
  const placement = placeManagerActivityGroups(
    groups,
    [replyEvent("message-final", "run-2")],
  );
  const attached = placement.attachedToEvent.get("message-final");
  assert.equal(attached?.length, 1);
  assert.equal(attached?.[0].display, "replaced");
  assert.equal(
    attached?.[0].history.filter((entry) => entry.kind === "calling").length,
    1,
  );
  const markup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityHistory,
    { group: attached?.[0], initiallyExpanded: true },
  ));
  assert.doesNotMatch(markup, /called tool|manager finished/i);
  assert.match(markup, /Calling/);
});

test("active manager activity moves above an associated in-progress reply", () => {
  const state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("thinking", "Thinking", T0),
  );
  const placement = placeManagerActivityGroups(
    presentedManagerActivityGroups(state, "room-1"),
    [replyEvent("message-live", "run-1", {
      content: { work_continues: true },
    })],
  );

  assert.deepEqual(
    placement.attachedToEvent.get("message-live")?.map(
      (group) => [group.progress_group_id, group.display],
    ),
    [["run-1", "active"]],
  );
  assert.deepEqual(placement.trailing, []);
});

test("a later final reply suppresses an unmatched obsolete active group", () => {
  const state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("thinking", "Thinking", T0),
  );
  const placement = placeManagerActivityGroups(
    presentedManagerActivityGroups(state, "room-1"),
    [replyEvent("message-final", "another-run")],
  );

  assert.equal(placement.attachedToEvent.size, 0);
  assert.deepEqual(placement.trailing, []);
});

test("unmatched manager activity remains live when no later reply supersedes it", () => {
  const state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("thinking", "Thinking", T2),
  );
  const placement = placeManagerActivityGroups(
    presentedManagerActivityGroups(state, "room-1"),
    [replyEvent("older-message", "another-run")],
  );

  assert.deepEqual(
    placement.trailing.map((group) => group.progress_group_id),
    ["run-1"],
  );
});

test("active manager activity disappears after the missed-terminal safety bound", () => {
  const state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("thinking", "Thinking", T0),
  );

  assert.equal(
    presentedManagerActivityGroups(state, "room-1", {
      asOfMs: Date.parse(T0) + MANAGER_ACTIVITY_STALE_MS - 1,
    }).length,
    1,
  );
  assert.deepEqual(
    presentedManagerActivityGroups(state, "room-1", {
      asOfMs: Date.parse(T0) + MANAGER_ACTIVITY_STALE_MS,
    }),
    [],
  );
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

test("public activity notes hide mechanics and retain useful context", () => {
  assert.equal(
    publicManagerActivityNote(
      "called tool: message_manager -> architecture-silicon",
      "calling",
    ),
    null,
  );
  assert.equal(publicManagerActivityNote("Thinking", "thinking"), null);
  assert.equal(publicManagerActivityNote("manager finished", "done"), null);
  assert.equal(
    publicManagerActivityNote("reading /srv/silicon/product/requirements.md", "reading"),
    "Reading requirements.md",
  );
  assert.equal(
    publicManagerActivityNote("executing: npm test", "executing"),
    "Executing command",
  );
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

test("done retains history only until a final message replaces the run", () => {
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
  assert.equal(visibleManagerActivityGroups(state, "room-1").length, 0);

  state = reduceManagerActivityFrame(state, frame("writing", "Late frame", T2));
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "replaced");
  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").current, null);
});

test("duplicate terminal delivery leaves one deterministic done frame", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("reading", "Reading docs", T0),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", T1, {
      frame_id: "done-first",
      revision: 1,
    }),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", T2, {
      frame_id: "done-retry",
      revision: 2,
    }),
  );

  const group = getManagerActivityGroup(state, "room-1", "run-1");
  assert.deepEqual(
    group.history.map((entry) => [entry.note, entry.frame_id]),
    [
      ["Reading docs", frame("reading", "Reading docs", T0).frame_id],
      ["manager finished", "done-retry"],
    ],
  );
});

test("a replaced run cannot duplicate the next active handoff", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("searching_web", "Searching the web", T0),
  );
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T1,
    reason: "final_message",
    final_message_event_id: "message-final",
  });
  state = reduceManagerActivityFrame(state, frame("writing", "Another run", T2, {
    progress_group_id: "run-2",
  }));

  const groups = presentedManagerActivityGroups(state, "room-1");
  const placement = placeManagerActivityGroups(
    groups,
    [replyEvent("message-final", "run-1")],
  );

  assert.deepEqual(
    placement.attachedToEvent.get("message-final")?.map(
      (group) => group.progress_group_id,
    ),
    ["run-1"],
  );
  assert.deepEqual(
    placement.trailing.map((group) => group.progress_group_id),
    ["run-2"],
  );
});

test("reconstructed unanchored runs render as one meaningful history row", () => {
  let state = createManagerActivityState();
  state = reduceManagerActivityFrame(
    state,
    frame("reading", "Reading requirements", T0),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", T1),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("calling", "Called architecture silicon", T2, {
      progress_group_id: "run-2",
    }),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", "2026-07-23T08:03:00.000Z", {
      progress_group_id: "run-2",
    }),
  );

  assert.equal(visibleManagerActivityGroups(state, "room-1").length, 2);
  const presented = presentedManagerActivityGroups(state, "room-1");
  assert.equal(presented.length, 1);
  assert.equal(presented[0].display, "history");
  assert.deepEqual(
    presented[0].history.map((entry) => entry.note),
    [
      "Reading requirements",
      "Called architecture silicon",
    ],
  );

  const markup = renderToStaticMarkup(React.createElement(
    WorkManagerActivityHistory,
    { group: presented[0], initiallyExpanded: true },
  ));
  const headerMarkup = markup.slice(0, markup.indexOf("<ol"));
  assert.match(headerMarkup, /Called architecture silicon/i);
  assert.doesNotMatch(markup, /manager finished/i);
  assert.equal((markup.match(/Reading requirements/g) ?? []).length, 1);
  assert.equal((markup.match(/Called architecture silicon/g) ?? []).length, 2);

  state = reduceManagerActivityFrame(
    state,
    frame("writing", "Preparing the next response", "2026-07-23T08:04:00.000Z", {
      progress_group_id: "run-3",
    }),
  );
  assert.deepEqual(
    presentedManagerActivityGroups(state, "room-1").map((group) => [
      group.display,
      group.progress_group_id,
    ]),
    [
      ["history", "manager-history:room-1"],
      ["active", "run-3"],
    ],
  );
});

test("a late shell-only done frame back-links internally without rendering a row", () => {
  const finalMessage = {
    event_id: "message-final",
    room_id: "room-1",
    sender_kind: "silicon",
    sender_handle: "cto",
    type: "m.text",
    content: {
      body: "Here is the final answer.",
      progress_group_id: "run-1",
    },
    created_at: T1,
    edited_at: null,
    redacted_at: null,
    is_final: true,
  };

  // This is the actual Stemcell order: reply first, durable done frame second.
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("done", "manager finished", T2),
  );
  const replacement = managerActivityReplacementEvent([finalMessage], "run-1");
  assert.equal(replacement?.event_id, "message-final");
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T2,
    reason: "final_message",
    final_message_event_id: replacement.event_id,
  });

  const placement = placeManagerActivityGroups(
    presentedManagerActivityGroups(state, "room-1"),
    [finalMessage],
  );
  const settled = getManagerActivityGroup(state, "room-1", "run-1");
  assert.equal(settled.display, "replaced");
  assert.equal(settled.replaced_by_event_id, "message-final");
  assert.equal(
    placement.attachedToEvent.get("message-final"),
    undefined,
  );
  assert.deepEqual(placement.trailing, []);
});

test("explicit dismissal also hides activity without claiming a final message", () => {
  let state = reduceManagerActivityFrame(
    createManagerActivityState(),
    frame("thinking", "Thinking", T0),
  );
  state = settleManagerActivity(state, "room-1", "run-1", {
    occurred_at: T1,
    reason: "dismissed",
  });

  assert.equal(getManagerActivityGroup(state, "room-1", "run-1").display, "replaced");
  assert.deepEqual(visibleManagerActivityGroups(state, "room-1"), []);
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
  assert.equal(
    getManagerActivityGroup(state, "room-1", "run-1").replaced_by_event_id,
    "room-one-final",
  );
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

test("implicit final settlement selects the newest retained history after reconstruction", () => {
  let state = createManagerActivityState();
  state = reduceManagerActivityFrame(
    state,
    frame("thinking", "First run", T0),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", T1),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("writing", "Second run", T2, { progress_group_id: "run-2" }),
  );
  state = reduceManagerActivityFrame(
    state,
    frame("done", "manager finished", "2026-07-23T08:03:00.000Z", {
      progress_group_id: "run-2",
    }),
  );

  assert.equal(
    resolveManagerActivityForSettlement(state, "room-1")?.progress_group_id,
    "run-2",
  );
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
