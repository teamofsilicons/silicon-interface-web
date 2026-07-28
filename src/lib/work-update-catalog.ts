import type {
  ManagerActivityGroup,
  WorkCallEvent,
  WorkHistoryEntry,
  WorkPersistentEvent,
  WorkTaskSnapshot,
  WorkTerminalEvent,
  WorkTimelineRecord,
  WorkWorkerGroupEvent,
} from "./work-update-types";
import { buildFitnessDemoScene } from "./work-update-demo-fixtures";

export const WORK_UPDATE_CATALOG_ORDER = [
  "intent-message",
  "manager-activity",
  "manager-final-history",
  "todo",
  "queued-task",
  "waiting-on-silicon",
  "rate-limited-pause",
  "offline-pause",
  "infrastructure-pause",
  "workers",
  "workers-terminal",
  "calling-manager",
  "called-silicon",
  "received-call",
  "failed-call",
  "cancelled-call",
  "major-update",
  "blocker-primary-color",
  "blocker-reminders",
  "failed-task",
  "failure",
  "failure-message",
  "cancelled-task",
  "cancellation",
  "cancellation-message",
  "completion",
  "final-message",
] as const;

export type WorkUpdateCatalogId = (typeof WORK_UPDATE_CATALOG_ORDER)[number];

export const WORK_UPDATE_CATALOG_SILICON = {
  id: "fitness-builder",
  name: "Fitness Builder",
  family: "silicon" as const,
} as const;

export const WORK_UPDATE_CATALOG_MEDIA = {
  image: "catalog-media-fitness-reference",
  file: "catalog-media-accessibility-notes",
} as const;

export type WorkUpdateCatalogSpecimen =
  | {
      id: WorkUpdateCatalogId;
      label: string;
      kind: "message";
      sender: "carbon" | "silicon";
      body: string;
      time: string;
      managerActivity?: ManagerActivityGroup;
    }
  | {
      id: WorkUpdateCatalogId;
      label: string;
      kind: "manager";
      group: ManagerActivityGroup;
    }
  | {
      id: WorkUpdateCatalogId;
      label: string;
      kind: "work";
      record: WorkTimelineRecord;
      task?: WorkTaskSnapshot;
    };

export interface WorkUpdateCatalog {
  task: WorkTaskSnapshot;
  specimens: WorkUpdateCatalogSpecimen[];
}

export function resolveCatalogBlocker(
  record: WorkTimelineRecord,
  answer: string | undefined,
  nowIso: string,
): WorkTimelineRecord {
  if (
    !answer ||
    record.type !== "m.work_event" ||
    record.event.kind !== "blocker"
  ) {
    return record;
  }
  const event = record.event;
  return {
    type: "m.work_event",
    event: {
      ...event,
      state: "resolved",
      resolved_at: nowIso,
      blocks: event.blocks.map((block) =>
        block.type === "remote_browser"
          ? { ...block, closed: true }
          : block
      ),
      history: [
        ...event.history,
        {
          history_id: `catalog-resolved-${event.blocker_id}`,
          kind: "blocker_resolved",
          summary: "Carbon answered the blocker",
          body: answer,
          entity_id: event.blocker_id,
          state: "completed",
          actor_kind: "carbon",
          actor_id: "alex",
          actor_name: "Alex",
          sequence: event.history.length,
          revision: 0,
          created_at: nowIso,
        },
      ],
      revision: event.revision + 1,
      updated_at: nowIso,
    },
  };
}

function taskFrom(records: WorkTimelineRecord[]): WorkTaskSnapshot {
  const record = records.find((candidate) => candidate.type === "m.work_task");
  if (!record || record.type !== "m.work_task") {
    throw new Error("The work-update catalog requires a root task fixture.");
  }
  return record.task;
}

function eventFrom<T extends WorkPersistentEvent["kind"]>(
  records: WorkTimelineRecord[],
  kind: T,
): Extract<WorkPersistentEvent, { kind: T }> {
  const record = records.find(
    (candidate) =>
      candidate.type === "m.work_event" &&
      candidate.event.kind === kind,
  );
  if (!record || record.type !== "m.work_event" || record.event.kind !== kind) {
    throw new Error(`The work-update catalog requires a ${kind} fixture.`);
  }
  return record.event as Extract<WorkPersistentEvent, { kind: T }>;
}

function workRecords(
  stage: "kickoff" | "parallel-work" | "milestone" | "blocked" | "completed",
  nowIso: string,
): WorkTimelineRecord[] {
  return buildFitnessDemoScene(stage, nowIso).timeline.flatMap((item) =>
    item.kind === "work" ? [item.record] : []
  );
}

function managerGroup(nowIso: string): ManagerActivityGroup {
  const manager = buildFitnessDemoScene("kickoff", nowIso).timeline.find(
    (item) => item.kind === "manager",
  );
  if (!manager || manager.kind !== "manager") {
    throw new Error("The work-update catalog requires manager activity.");
  }
  return manager.group;
}

function managerFinalGroup(
  source: ManagerActivityGroup,
  nowIso: string,
): ManagerActivityGroup {
  const seed = source.current ?? source.history.at(-1);
  const finalFrame = seed ? {
    ...seed,
    frame_id: "catalog-manager-writing-final",
    kind: "writing" as const,
    note: "Writing the final delivery summary",
    progress_pct: 100,
    revision: 0,
    occurred_at: nowIso,
  } : null;
  return {
    ...source,
    current: null,
    history: finalFrame ? [...source.history, finalFrame] : source.history,
    display: "history",
    replaced_by_event_id: "catalog-message-manager-final-history",
    updated_at: nowIso,
  };
}

function history(
  historyId: string,
  kind: WorkHistoryEntry["kind"],
  summary: string,
  createdAt: string,
  state: string,
): WorkHistoryEntry {
  return {
    history_id: historyId,
    kind,
    summary,
    entity_id: historyId,
    state,
    actor_kind: "manager",
    actor_id: "fitness-builder-manager",
    actor_name: "Fitness Builder",
    sequence: 99,
    revision: 0,
    created_at: createdAt,
  };
}

function catalogTask(source: WorkTaskSnapshot, nowIso: string): WorkTaskSnapshot {
  const states = [
    {
      state: "completed" as const,
      summary: "Product direction approved",
      kind: "todo_updated" as const,
    },
    {
      state: "in_progress" as const,
      summary: "Designing the responsive workout journey",
      kind: "todo_updated" as const,
    },
    {
      state: "blocked" as const,
      summary: "Waiting for the primary color decision",
      kind: "todo_updated" as const,
    },
    {
      state: "yet_to_start" as const,
      summary: "Validation will begin after implementation",
      kind: "todo_updated" as const,
    },
  ];

  return {
    ...source,
    state: "blocked",
    todos: source.todos.map((todo, index) => {
      const catalogState = states[index] ?? states.at(-1)!;
      return {
        ...todo,
        state: catalogState.state,
        history: [
          ...todo.history,
          history(
            `catalog-todo-${todo.todo_id}`,
            catalogState.kind,
            catalogState.summary,
            nowIso,
            catalogState.state,
          ),
        ],
        revision: todo.revision + 1,
        updated_at: nowIso,
      };
    }),
    history: [
      ...source.history,
      history(
        "catalog-task-all-todo-states",
        "task_updated",
        "Showing every Todo state",
        nowIso,
        "blocked",
      ),
      history(
        "catalog-task-estimate-revised",
        "timer_updated",
        "Estimate updated from ~3h 10m to ~2h 48m after the accuracy review",
        nowIso,
        "blocked",
      ),
    ],
    active_elapsed_seconds: 6_120,
    timer_state: "paused",
    timer_updated_at: nowIso,
    timer_pause_reason: "blocker",
    revision: source.revision + 1,
    updated_at: nowIso,
  };
}

function catalogWorkers(
  source: WorkWorkerGroupEvent,
  nowIso: string,
): WorkWorkerGroupEvent {
  const states = [
    {
      state: "completed" as const,
      summary: "Experience map delivered",
    },
    {
      state: "in_progress" as const,
      summary: "Building workout logging and progress charts",
    },
    {
      state: "blocked" as const,
      summary: "Waiting for the accessibility test environment",
    },
    {
      state: "yet_to_start" as const,
      summary: "Queued until the application build is ready",
    },
  ];
  const finalWorker = source.workers.at(-1);
  const workers = finalWorker
    ? [
        ...source.workers,
        {
          ...finalWorker,
          worker_id: "catalog-worker-release-notes",
          invocation_id: "catalog-worker-release-notes-invocation",
          name: "Release Writer",
          description: "Prepare the final release notes and delivery summary.",
          revision: 0,
          history: [],
          created_at: nowIso,
          updated_at: nowIso,
        },
      ]
    : source.workers;
  return {
    ...source,
    body: "Four focused workers are moving design, implementation, quality, and release preparation forward in parallel.",
    workers: workers.map((worker, index) => {
      const catalogState = states[index] ?? states.at(-1)!;
      return {
        ...worker,
        state: catalogState.state,
        history: [
          ...worker.history,
          history(
            `catalog-worker-${worker.invocation_id}`,
            "worker_updated",
            catalogState.summary,
            nowIso,
            catalogState.state,
          ),
        ],
        revision: worker.revision + 1,
        updated_at: nowIso,
      };
    }),
    history: [
      ...source.history.map((entry, index) => index === 0
        ? { ...entry, summary: "Started four parallel workers" }
        : entry),
      history(
        "catalog-workers-all-states",
        "worker_updated",
        "Worker states updated independently",
        nowIso,
        "in_progress",
      ),
    ],
    revision: source.revision + 1,
    updated_at: nowIso,
  };
}

function managerCall(source: WorkCallEvent, nowIso: string): WorkCallEvent {
  return {
    ...source,
    work_event_id: "catalog-call-sakets-manager",
    task_id: null,
    task_title: null,
    timing: null,
    call_id: "catalog-call-sakets-manager",
    target_kind: "manager",
    target_id: "saket-manager",
    target_name: "Saket's Manager",
    state: "connecting",
    body: "Sharing the current delivery plan and asking for the latest product constraints.",
    transcript: [{
      transcript_id: "catalog-call-manager-opening",
      speaker_kind: "manager",
      speaker_id: "fitness-builder-manager",
      speaker_name: "Fitness Builder",
      body: "I’m checking the latest product constraints before implementation continues.",
      blocks: [],
      revision: 0,
      created_at: nowIso,
      updated_at: nowIso,
    }],
    history: [history(
      "catalog-manager-call-started",
      "call_updated",
      "Calling Saket's Manager",
      nowIso,
      "in_progress",
    )],
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function secondBlocker(
  source: Extract<WorkPersistentEvent, { kind: "blocker" }>,
  nowIso: string,
): Extract<WorkPersistentEvent, { kind: "blocker" }> {
  return {
    ...source,
    work_event_id: "catalog-blocker-reminders",
    blocker_id: "catalog-blocker-reminders",
    body: "Should workout reminders be opt-in during onboarding or enabled by default?",
    blocks: [{
      type: "text",
      format: "markdown",
      body: "This decision affects **notification permission timing, onboarding copy, and the first-week retention flow**.",
    }],
    state: "open",
    resolved_at: null,
    history: [history(
      "catalog-reminder-blocker-opened",
      "blocker_opened",
      "Requested the reminder-default decision",
      nowIso,
      "blocked",
    )],
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function singleTodoTask(
  source: WorkTaskSnapshot,
  nowIso: string,
  options: {
    taskId: string;
    title: string;
    description: string;
    taskState: "queued" | "running";
    todoTitle: string;
    todoState: "yet_to_start" | "in_progress";
    summary: string;
    timerState: "running" | "paused";
    pauseReason: "rate_limited" | "offline" | "infrastructure" | null;
    estimateSeconds: number;
    activeElapsedSeconds: number;
  },
): WorkTaskSnapshot {
  const baseTodo = source.todos[0];
  return {
    ...source,
    task_id: options.taskId,
    title: options.title,
    description: options.description,
    state: options.taskState,
    todos: baseTodo ? [{
      ...baseTodo,
      todo_id: `${options.taskId}-todo`,
      title: options.todoTitle,
      description: options.description,
      state: options.todoState,
      history: [history(
        `${options.taskId}-todo-history`,
        "todo_updated",
        options.summary,
        nowIso,
        options.todoState,
      )],
      revision: 0,
      created_at: nowIso,
      updated_at: nowIso,
    }] : [],
    history: [history(
      `${options.taskId}-history`,
      options.timerState === "paused" ? "timer_updated" : "task_updated",
      options.summary,
      nowIso,
      options.taskState,
    )],
    estimate_seconds: options.estimateSeconds,
    active_elapsed_seconds: options.activeElapsedSeconds,
    timer_state: options.timerState,
    timer_updated_at: nowIso,
    timer_pause_reason: options.pauseReason,
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function terminalTask(
  source: WorkTaskSnapshot,
  kind: "failed" | "cancelled",
  nowIso: string,
): WorkTaskSnapshot {
  const failed = kind === "failed";
  const taskId = failed
    ? "catalog-task-production-build"
    : "catalog-task-launch-campaign";
  return {
    ...source,
    task_id: taskId,
    title: failed
      ? "Publish the production build"
      : "Prepare the launch campaign",
    description: failed
      ? "Package, sign, and publish the verified release."
      : "Prepare the launch narrative, channel plan, and campaign assets.",
    state: kind,
    todos: source.todos.slice(0, 3).map((todo, index) => ({
      ...todo,
      todo_id: `${taskId}-todo-${index + 1}`,
      title: failed
        ? [
            "Build the release package",
            "Sign the production artifact",
            "Publish the verified build",
          ][index] ?? todo.title
        : [
            "Research the launch audience",
            "Draft the campaign narrative",
            "Prepare channel assets",
          ][index] ?? todo.title,
      state: index === 0 ? "completed" : index === 1 ? "blocked" : "yet_to_start",
      history: [history(
        `${taskId}-todo-history-${index + 1}`,
        "todo_updated",
        index === 0
          ? "Completed before the terminal state"
          : failed
            ? "Stopped after the packaging failure"
            : "Stopped after the scope was cancelled",
        nowIso,
        index === 0 ? "completed" : index === 1 ? "blocked" : "yet_to_start",
      )],
      revision: 0,
      created_at: nowIso,
      updated_at: nowIso,
    })),
    history: [history(
      `${taskId}-terminal-history`,
      failed ? "failed" : "cancelled",
      failed ? "Production release failed" : "Launch campaign cancelled",
      nowIso,
      kind,
    )],
    estimate_seconds: failed ? 4_200 : 5_400,
    active_elapsed_seconds: failed ? 2_840 : 1_920,
    timer_state: "stopped",
    timer_updated_at: nowIso,
    timer_pause_reason: null,
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function terminalCall(
  source: WorkCallEvent,
  kind: "failed" | "cancelled",
  nowIso: string,
): WorkCallEvent {
  const failed = kind === "failed";
  const callId = failed
    ? "catalog-call-failed"
    : "catalog-call-cancelled";
  return {
    ...source,
    work_event_id: callId,
    task_id: null,
    task_title: null,
    timing: null,
    call_id: callId,
    direction: "outbound",
    target_kind: "silicon",
    target_id: failed ? "research-silicon" : "launch-silicon",
    target_name: failed ? "Research Silicon" : "Launch Silicon",
    state: kind,
    body: failed
      ? "Research Silicon could not be reached because its Interface endpoint is offline."
      : "The launch coordination call was cancelled after the campaign scope changed.",
    transcript: source.transcript.slice(0, 1).map((entry) => ({
      ...entry,
      transcript_id: `${callId}-transcript`,
      body: failed
        ? "I’m checking the exercise evidence before final validation."
        : "I’m cancelling this coordination call because the launch scope changed.",
      revision: 0,
      created_at: nowIso,
      updated_at: nowIso,
    })),
    history: [history(
      `${callId}-history`,
      "call_updated",
      failed ? "Call failed while the peer was offline" : "Call cancelled",
      nowIso,
      kind,
    )],
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function terminalWorkers(
  source: WorkWorkerGroupEvent,
  nowIso: string,
): WorkWorkerGroupEvent {
  const base = source.workers.slice(0, 2);
  return {
    ...source,
    work_event_id: "catalog-worker-terminal-group",
    group_id: "catalog-worker-terminal-group",
    body: "Two worker invocations ended without completing their assigned work.",
    workers: base.map((worker, index) => ({
      ...worker,
      worker_id: `catalog-terminal-worker-${index + 1}`,
      invocation_id: `catalog-terminal-invocation-${index + 1}`,
      name: index === 0 ? "Dependency Auditor" : "Campaign Drafter",
      description: index === 0
        ? "Verify the unavailable exercise-data dependency."
        : "Draft a campaign that was removed from scope.",
      state: index === 0 ? "failed" : "cancelled",
      history: [history(
        `catalog-terminal-worker-history-${index + 1}`,
        "worker_updated",
        index === 0
          ? "Worker failed when the dependency stayed offline"
          : "Worker cancelled after the campaign left scope",
        nowIso,
        index === 0 ? "failed" : "cancelled",
      )],
      revision: 0,
      created_at: nowIso,
      updated_at: nowIso,
    })),
    history: [history(
      "catalog-worker-terminal-group-history",
      "worker_updated",
      "Terminal worker states retained",
      nowIso,
      "failed",
    )],
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function terminalEvent(
  source: WorkTerminalEvent,
  kind: "failure" | "cancellation",
  nowIso: string,
): WorkTerminalEvent {
  const failed = kind === "failure";
  const taskTitle = failed
    ? "Publish the production build"
    : "Prepare the launch campaign";
  const eventId = failed
    ? "catalog-event-production-failure"
    : "catalog-event-campaign-cancelled";
  return {
    ...source,
    work_event_id: eventId,
    task_id: failed
      ? "catalog-task-production-build"
      : "catalog-task-launch-campaign",
    task_title: taskTitle,
    kind,
    body: failed
      ? "The production build failed during release packaging. The verified local build and diagnostics are retained for retry."
      : "The launch campaign was cancelled after the scope changed. Completed research and draft assets remain available.",
    blocks: [{
      type: "text",
      format: "markdown",
      body: failed
        ? "**Next:** inspect the packaging log, correct the signing configuration, and retry from the retained checkpoint."
        : "**Retained:** audience research, launch narrative, channel plan, and all completed draft assets.",
    }],
    timing: {
      ...source.timing,
      active_elapsed_seconds: failed ? 2_840 : 1_920,
      timer_state: "stopped",
      timer_updated_at: nowIso,
      timer_pause_reason: null,
    },
    history: [history(
      `${eventId}-history`,
      failed ? "failed" : "cancelled",
      failed ? "Production packaging failed" : "Launch campaign cancelled",
      nowIso,
      failed ? "failed" : "cancelled",
    )],
    revision: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export function buildWorkUpdateCatalog(nowIso: string): WorkUpdateCatalog {
  const blockedRecords = workRecords("blocked", nowIso);
  const parallelRecords = workRecords("parallel-work", nowIso);
  const milestoneRecords = workRecords("milestone", nowIso);
  const completedRecords = workRecords("completed", nowIso);

  const task = catalogTask(taskFrom(blockedRecords), nowIso);
  const completedTask = taskFrom(completedRecords);
  const manager = managerGroup(nowIso);
  const queuedTask = singleTodoTask(task, nowIso, {
    taskId: "catalog-task-queued",
    title: "Prepare the regional workout variants",
    description: "This task is queued behind the active application build.",
    taskState: "queued",
    todoTitle: "Prepare regional workout variants",
    todoState: "yet_to_start",
    summary: "Queued behind active work; elapsed time continues",
    timerState: "running",
    pauseReason: null,
    estimateSeconds: 1_800,
    activeElapsedSeconds: 160,
  });
  const waitingTask = singleTodoTask(task, nowIso, {
    taskId: "catalog-task-waiting-silicon",
    title: "Review the motion system",
    description: "Motion Silicon is reviewing the active-workout feedback pattern.",
    taskState: "running",
    todoTitle: "Incorporate Motion Silicon's review",
    todoState: "in_progress",
    summary: "Waiting on Motion Silicon; elapsed time continues",
    timerState: "running",
    pauseReason: null,
    estimateSeconds: 1_200,
    activeElapsedSeconds: 540,
  });
  const rateLimited = singleTodoTask(task, nowIso, {
    taskId: "catalog-task-rate-limited",
    title: "Sync the exercise reference library",
    description: "Refresh the external exercise catalog before final validation.",
    taskState: "running",
    todoTitle: "Refresh the exercise catalog",
    todoState: "in_progress",
    summary: "Paused while the provider rate limit resets",
    timerState: "paused",
    pauseReason: "rate_limited",
    estimateSeconds: 1_260,
    activeElapsedSeconds: 420,
  });
  const offline = singleTodoTask(task, nowIso, {
    taskId: "catalog-task-offline",
    title: "Validate the wearable connection",
    description: "The paired wearable is offline, so the hardware validation cannot proceed.",
    taskState: "running",
    todoTitle: "Run the wearable sync validation",
    todoState: "in_progress",
    summary: "Paused because the wearable is offline",
    timerState: "paused",
    pauseReason: "offline",
    estimateSeconds: 1_500,
    activeElapsedSeconds: 610,
  });
  const infrastructure = singleTodoTask(task, nowIso, {
    taskId: "catalog-task-infrastructure",
    title: "Run the device test matrix",
    description: "The remote device lab is unavailable during its infrastructure recovery.",
    taskState: "running",
    todoTitle: "Test the supported device matrix",
    todoState: "in_progress",
    summary: "Paused while the device lab recovers",
    timerState: "paused",
    pauseReason: "infrastructure",
    estimateSeconds: 2_100,
    activeElapsedSeconds: 780,
  });
  const workers = catalogWorkers(
    eventFrom(parallelRecords, "worker_group"),
    nowIso,
  );
  const workersTerminal = terminalWorkers(workers, nowIso);
  const activeSiliconCall = eventFrom(parallelRecords, "call");
  const completedSiliconCall = eventFrom(milestoneRecords, "call");
  const inboundCallRecord = milestoneRecords
    .filter((record) => record.type === "m.work_event")
    .map((record) => record.event)
    .find((event) => event.kind === "call" && event.direction === "inbound");
  if (!inboundCallRecord || inboundCallRecord.kind !== "call") {
    throw new Error("The work-update catalog requires an inbound call fixture.");
  }
  const milestone = eventFrom(milestoneRecords, "milestone");
  const sourceBlocker = eventFrom(blockedRecords, "blocker");
  const blocker = {
    ...sourceBlocker,
    blocks: [
      sourceBlocker.blocks[0],
      {
        type: "image" as const,
        media_id: WORK_UPDATE_CATALOG_MEDIA.image,
        filename: "fitness-reference.svg",
        mime: "image/svg+xml",
        caption: "Current visual direction",
        alt: "Silicon fitness visual reference",
        width: 640,
        height: 360,
      },
      {
        type: "file" as const,
        media_id: WORK_UPDATE_CATALOG_MEDIA.file,
        filename: "fitness-accessibility-notes.txt",
        mime: "text/plain",
        caption: "Accessibility and brand constraints",
        size_bytes: 384,
      },
      ...sourceBlocker.blocks.slice(1),
    ],
  };
  const completion = eventFrom(completedRecords, "completion");
  const failedTask = terminalTask(task, "failed", nowIso);
  const cancelledTask = terminalTask(task, "cancelled", nowIso);
  const failure = terminalEvent(completion, "failure", nowIso);
  const cancellation = terminalEvent(completion, "cancellation", nowIso);

  const specimens: WorkUpdateCatalogSpecimen[] = [
    {
      id: "intent-message",
      label: "Intent message",
      kind: "message",
      sender: "silicon",
      body: "One sec. I’m pulling the product, accessibility, and workout-flow references now.",
      time: "3:01 PM",
    },
    {
      id: "manager-activity",
      label: "Manager activity",
      kind: "manager",
      group: manager,
    },
    {
      id: "manager-final-history",
      label: "Final message · retained manager history",
      kind: "message",
      sender: "silicon",
      body: "The short review is complete. I’ve incorporated the findings into the delivery plan.",
      time: "3:04 PM",
      managerActivity: managerFinalGroup(manager, nowIso),
    },
    {
      id: "todo",
      label: "Todo · all four states",
      kind: "work",
      record: { type: "m.work_task", task },
      task,
    },
    {
      id: "queued-task",
      label: "Queued · timer still running",
      kind: "work",
      record: { type: "m.work_task", task: queuedTask },
    },
    {
      id: "waiting-on-silicon",
      label: "Waiting on a Silicon · timer still running",
      kind: "work",
      record: { type: "m.work_task", task: waitingTask },
    },
    {
      id: "rate-limited-pause",
      label: "Paused · rate limited",
      kind: "work",
      record: { type: "m.work_task", task: rateLimited },
    },
    {
      id: "offline-pause",
      label: "Paused · offline",
      kind: "work",
      record: { type: "m.work_task", task: offline },
    },
    {
      id: "infrastructure-pause",
      label: "Paused · infrastructure",
      kind: "work",
      record: { type: "m.work_task", task: infrastructure },
    },
    {
      id: "workers",
      label: "Workers · active states",
      kind: "work",
      record: { type: "m.work_event", event: workers },
      task,
    },
    {
      id: "workers-terminal",
      label: "Workers · failed and cancelled",
      kind: "work",
      record: { type: "m.work_event", event: workersTerminal },
      task,
    },
    {
      id: "calling-manager",
      label: "Calling another Carbon's manager",
      kind: "work",
      record: {
        type: "m.work_event",
        event: managerCall(activeSiliconCall, nowIso),
      },
    },
    {
      id: "called-silicon",
      label: "Called another Silicon",
      kind: "work",
      record: { type: "m.work_event", event: completedSiliconCall },
      task,
    },
    {
      id: "received-call",
      label: "Received a Silicon call",
      kind: "work",
      record: { type: "m.work_event", event: inboundCallRecord },
      task,
    },
    {
      id: "failed-call",
      label: "Call · failed",
      kind: "work",
      record: {
        type: "m.work_event",
        event: terminalCall(activeSiliconCall, "failed", nowIso),
      },
    },
    {
      id: "cancelled-call",
      label: "Call · cancelled",
      kind: "work",
      record: {
        type: "m.work_event",
        event: terminalCall(activeSiliconCall, "cancelled", nowIso),
      },
    },
    {
      id: "major-update",
      label: "Major update",
      kind: "work",
      record: { type: "m.work_event", event: milestone },
      task,
    },
    {
      id: "blocker-primary-color",
      label: "Blocker · rich content",
      kind: "work",
      record: { type: "m.work_event", event: blocker },
      task,
    },
    {
      id: "blocker-reminders",
      label: "Second blocker · same task",
      kind: "work",
      record: {
        type: "m.work_event",
        event: secondBlocker(blocker, nowIso),
      },
      task,
    },
    {
      id: "failed-task",
      label: "Failed task · stopped timer",
      kind: "work",
      record: {
        type: "m.work_task",
        task: failedTask,
      },
    },
    {
      id: "failure",
      label: "Persistent failure card",
      kind: "work",
      record: {
        type: "m.work_event",
        event: failure,
      },
      task: failedTask,
    },
    {
      id: "failure-message",
      label: "Failure · final normal message",
      kind: "message",
      sender: "silicon",
      body: "The production package failed during signing. I retained the verified build and diagnostics, so the next attempt can resume from that checkpoint.",
      time: "5:15 PM",
    },
    {
      id: "cancelled-task",
      label: "Cancelled task · stopped timer",
      kind: "work",
      record: {
        type: "m.work_task",
        task: cancelledTask,
      },
    },
    {
      id: "cancellation",
      label: "Persistent cancellation card",
      kind: "work",
      record: {
        type: "m.work_event",
        event: cancellation,
      },
      task: cancelledTask,
    },
    {
      id: "cancellation-message",
      label: "Cancellation · final normal message",
      kind: "message",
      sender: "silicon",
      body: "The launch campaign was cancelled after the scope changed. I retained the completed research and drafts in case the work resumes.",
      time: "5:28 PM",
    },
    {
      id: "completion",
      label: "Completion",
      kind: "work",
      record: { type: "m.work_event", event: completion },
      task: completedTask,
    },
    {
      id: "final-message",
      label: "Final normal message",
      kind: "message",
      sender: "silicon",
      body: "Done — the fitness app is complete. The daily plan, workout logger, progress dashboard, responsive behavior, and accessibility pass are all in place.",
      time: "5:47 PM",
    },
  ];

  return { task, specimens };
}
