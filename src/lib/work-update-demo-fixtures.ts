import type {
  Event,
  Room,
} from "./types";
import type {
  ManagerActivityFrame,
  ManagerActivityGroup,
  WorkBlockerEvent,
  WorkCallEvent,
  WorkCallTranscriptEntry,
  WorkContentBlock,
  WorkHistoryEntry,
  WorkPersistentEvent,
  WorkTaskSnapshot,
  WorkTimingSnapshot,
  WorkTimelineRecord,
  WorkTodo,
  WorkTodoState,
  WorkWorkerGroupEvent,
  WorkWorkerInvocation,
} from "./work-update-types";
import { addWorkEstimateBuffer } from "./work-update-time";

export const FITNESS_DEMO_ROOM_ID = "demo:work-updates:fitness-app";
export const FITNESS_DEMO_TASK_ID = "demo-task-build-fitness-app";
export const FITNESS_DEMO_REALISTIC_SECONDS = 9_600;
export const FITNESS_DEMO_ESTIMATE_SECONDS = addWorkEstimateBuffer(
  FITNESS_DEMO_REALISTIC_SECONDS,
);

export const FITNESS_DEMO_STAGES = [
  "kickoff",
  "parallel-work",
  "milestone",
  "blocked",
  "resumed",
  "completed",
] as const;

export type FitnessDemoStage = (typeof FITNESS_DEMO_STAGES)[number];

export function fitnessDemoStage(value: unknown): FitnessDemoStage {
  return typeof value === "string" &&
    (FITNESS_DEMO_STAGES as readonly string[]).includes(value)
    ? value as FitnessDemoStage
    : "kickoff";
}

export function nextFitnessDemoStage(
  stage: FitnessDemoStage,
): FitnessDemoStage | null {
  const index = FITNESS_DEMO_STAGES.indexOf(stage);
  return FITNESS_DEMO_STAGES[index + 1] ?? null;
}

export function previousFitnessDemoStage(
  stage: FitnessDemoStage,
): FitnessDemoStage | null {
  const index = FITNESS_DEMO_STAGES.indexOf(stage);
  return index > 0 ? FITNESS_DEMO_STAGES[index - 1] : null;
}

export type FitnessDemoTimelineItem =
  | {
      id: string;
      kind: "message";
      event: Event;
      mine: boolean;
      managerActivity?: ManagerActivityGroup;
    }
  | {
      id: string;
      kind: "manager";
      group: ManagerActivityGroup;
      initiallyExpanded?: boolean;
    }
  | {
      id: string;
      kind: "work";
      record: WorkTimelineRecord;
    };

export interface FitnessDemoScene {
  stage: FitnessDemoStage;
  stageIndex: number;
  stageLabel: string;
  stageDescription: string;
  roomStatus: string;
  room: Room;
  working: boolean;
  workingNote: string;
  timeline: FitnessDemoTimelineItem[];
}

const BASE_TIME = Date.parse("2026-07-23T09:30:00.000Z");

function at(minutes: number, seconds = 0): string {
  return new Date(BASE_TIME + minutes * 60_000 + seconds * 1_000).toISOString();
}

function stageIndex(stage: FitnessDemoStage): number {
  return FITNESS_DEMO_STAGES.indexOf(stage);
}

function throughStage<T>(stage: FitnessDemoStage, values: readonly T[]): T[] {
  return values.slice(0, stageIndex(stage) + 1);
}

function history(
  historyId: string,
  kind: WorkHistoryEntry["kind"],
  summary: string,
  createdAt: string,
  options: Partial<Pick<
    WorkHistoryEntry,
    "body" | "entity_id" | "state" | "actor_kind" | "actor_id" | "actor_name" | "sequence"
  >> = {},
): WorkHistoryEntry {
  return {
    history_id: historyId,
    kind,
    summary,
    revision: 0,
    created_at: createdAt,
    actor_kind: "manager",
    actor_id: "fitness-builder-manager",
    actor_name: "Fitness Builder",
    ...options,
  };
}

const taskHistory: readonly WorkHistoryEntry[] = [
  history(
    "task-history-created",
    "task_created",
    "Created the fitness app delivery plan",
    at(2),
    {
      body: "Set up a four-part plan covering product direction, experience design, implementation, and release checks.",
      entity_id: FITNESS_DEMO_TASK_ID,
      state: "running",
      sequence: 0,
    },
  ),
  history(
    "task-history-plan",
    "task_updated",
    "Product direction locked",
    at(12),
    {
      body: "Prioritized workout planning, activity tracking, streaks, and a lightweight progress dashboard.",
      entity_id: FITNESS_DEMO_TASK_ID,
      state: "running",
      sequence: 1,
    },
  ),
  history(
    "task-history-design",
    "milestone",
    "UI/UX flow completed",
    at(68),
    {
      body: "Navigation, onboarding, workout logging, and progress states are ready for implementation.",
      entity_id: FITNESS_DEMO_TASK_ID,
      state: "running",
      sequence: 2,
    },
  ),
  history(
    "task-history-blocked",
    "blocker_opened",
    "Paused for a brand-color decision",
    at(103),
    {
      body: "The primary color affects the shared tokens and final visual QA pass.",
      entity_id: FITNESS_DEMO_TASK_ID,
      state: "blocked",
      sequence: 3,
    },
  ),
  history(
    "task-history-resumed",
    "blocker_resolved",
    "Electric blue selected; work resumed",
    at(109),
    {
      body: "Applied the decision to the app shell, charts, controls, and accessibility states.",
      entity_id: FITNESS_DEMO_TASK_ID,
      state: "running",
      sequence: 4,
    },
  ),
  history(
    "task-history-completed",
    "completed",
    "Fitness app completed",
    at(166),
    {
      body: "The responsive app, workout flow, progress dashboard, and validation pass are complete.",
      entity_id: FITNESS_DEMO_TASK_ID,
      state: "completed",
      sequence: 5,
    },
  ),
];

function todoHistory(
  todoId: string,
  entries: readonly [string, string, WorkTodoState, string][],
): WorkHistoryEntry[] {
  return entries.map(([suffix, summary, state, createdAt], sequence) =>
    history(
      `${todoId}-history-${suffix}`,
      sequence === 0 ? "todo_created" : "todo_updated",
      summary,
      createdAt,
      {
        entity_id: todoId,
        state,
        sequence,
      },
    ));
}

const productHistory = todoHistory("todo-product-plan", [
  ["created", "Product planning started", "in_progress", at(3)],
  ["complete", "Product direction and scope approved", "completed", at(12)],
]);

const designHistory = todoHistory("todo-experience-design", [
  ["created", "Experience design queued", "yet_to_start", at(3)],
  ["started", "Designing the core workout journey", "in_progress", at(14)],
  ["complete", "Responsive UI/UX flow completed", "completed", at(68)],
]);

const buildHistory = todoHistory("todo-implementation", [
  ["created", "Implementation queued", "yet_to_start", at(3)],
  ["started", "Building the app shell and workout flow", "in_progress", at(15)],
  ["integrating", "Integrating workout logging and progress charts", "in_progress", at(72)],
  ["blocked", "Waiting for the primary color decision", "blocked", at(103)],
  ["resumed", "Applying the electric-blue system", "in_progress", at(109)],
  ["complete", "Application implementation completed", "completed", at(154)],
]);

const qaHistory = todoHistory("todo-quality", [
  ["created", "Quality pass queued", "yet_to_start", at(3)],
  ["started", "Running responsive and accessibility checks", "in_progress", at(74)],
  ["complete", "Quality and release checks passed", "completed", at(164)],
]);

function todo(
  todoId: string,
  title: string,
  description: string,
  state: WorkTodoState,
  revision: number,
  entries: WorkHistoryEntry[],
): WorkTodo {
  return {
    todo_id: todoId,
    title,
    description,
    state,
    revision,
    history: entries,
  };
}

function taskTodos(stage: FitnessDemoStage): WorkTodo[] {
  const index = stageIndex(stage);
  const productState: WorkTodoState = index === 0 ? "in_progress" : "completed";
  const designState: WorkTodoState = index === 0
    ? "yet_to_start"
    : index === 1
      ? "in_progress"
      : "completed";
  const buildState: WorkTodoState = index === 0
    ? "yet_to_start"
    : index === 3
      ? "blocked"
      : index === 5
        ? "completed"
        : "in_progress";
  const qaState: WorkTodoState = index < 4
    ? "yet_to_start"
    : index === 4
      ? "in_progress"
      : "completed";

  const productHistoryCount = index === 0 ? 1 : 2;
  const designHistoryCount = index === 0 ? 1 : index === 1 ? 2 : 3;
  const buildHistoryCount = [1, 2, 3, 4, 5, 6][index];
  const qaHistoryCount = index < 4 ? 1 : index === 4 ? 2 : 3;

  return [
    todo(
      "todo-product-plan",
      "Plan the fitness experience",
      "Define the audience, the first release scope, and the product's core success loop.",
      productState,
      Math.max(0, productHistoryCount - 1),
      productHistory.slice(0, productHistoryCount),
    ),
    todo(
      "todo-experience-design",
      "Design the responsive UI/UX",
      "Create onboarding, daily plan, workout logging, streak, and progress dashboard flows.",
      designState,
      Math.max(0, designHistoryCount - 1),
      designHistory.slice(0, designHistoryCount),
    ),
    todo(
      "todo-implementation",
      "Build the application",
      "Implement the responsive shell, workout flow, progress model, and polished interaction states.",
      buildState,
      Math.max(0, buildHistoryCount - 1),
      buildHistory.slice(0, buildHistoryCount),
    ),
    todo(
      "todo-quality",
      "Validate and prepare delivery",
      "Check responsiveness, keyboard access, empty/error states, and the final product handoff.",
      qaState,
      Math.max(0, qaHistoryCount - 1),
      qaHistory.slice(0, qaHistoryCount),
    ),
  ];
}

function timing(stage: FitnessDemoStage, nowIso: string): WorkTimingSnapshot {
  const elapsed = [180, 1_220, 4_260, 6_120, 6_360, 9_806][stageIndex(stage)];
  if (stage === "blocked") {
    return {
      estimate_seconds: FITNESS_DEMO_ESTIMATE_SECONDS,
      active_elapsed_seconds: elapsed,
      timer_state: "paused",
      timer_updated_at: at(103),
      timer_pause_reason: "blocker",
    };
  }
  if (stage === "completed") {
    return {
      estimate_seconds: FITNESS_DEMO_ESTIMATE_SECONDS,
      active_elapsed_seconds: elapsed,
      timer_state: "stopped",
      timer_updated_at: at(166),
      timer_pause_reason: null,
    };
  }
  return {
    estimate_seconds: FITNESS_DEMO_ESTIMATE_SECONDS,
    active_elapsed_seconds: elapsed,
    timer_state: "running",
    timer_updated_at: nowIso,
    timer_pause_reason: null,
  };
}

function taskSnapshot(stage: FitnessDemoStage, nowIso: string): WorkTaskSnapshot {
  const index = stageIndex(stage);
  return {
    schema_version: 1,
    task_id: FITNESS_DEMO_TASK_ID,
    room_id: FITNESS_DEMO_ROOM_ID,
    title: "Build a Fitness App",
    description:
      "Design and build a responsive fitness app that turns a daily plan into a clear workout, tracking, and progress loop.",
    state: stage === "blocked"
      ? "blocked"
      : stage === "completed"
        ? "completed"
        : "running",
    ...timing(stage, nowIso),
    todos: taskTodos(stage),
    history: throughStage(stage, taskHistory),
    revision: index,
    created_at: at(2),
    updated_at: stage === "kickoff" ? at(2) : stage === "completed" ? at(166) : nowIso,
  };
}

function eventBase(
  stage: FitnessDemoStage,
  nowIso: string,
  values: {
    id: string;
    kind: WorkPersistentEvent["kind"];
    body: string;
    blocks?: WorkContentBlock[];
    createdAt: string;
    history: WorkHistoryEntry[];
    revision: number;
  },
) {
  return {
    schema_version: 1 as const,
    work_event_id: values.id,
    task_id: FITNESS_DEMO_TASK_ID,
    room_id: FITNESS_DEMO_ROOM_ID,
    task_title: "Build a Fitness App",
    kind: values.kind,
    body: values.body,
    blocks: values.blocks ?? [],
    timing: timing(stage, nowIso),
    history: values.history,
    revision: values.revision,
    created_at: values.createdAt,
    updated_at: stage === "completed" ? at(166) : nowIso,
  };
}

function workerHistory(
  invocationId: string,
  updates: readonly [string, string, WorkWorkerInvocation["state"]][],
): WorkHistoryEntry[] {
  return updates.map(([createdAt, summary, state], sequence) =>
    history(
      `${invocationId}-history-${sequence}`,
      "worker_updated",
      summary,
      createdAt,
      {
        entity_id: invocationId,
        state,
        sequence,
      },
    ));
}

const designWorkerHistory = workerHistory("worker-design-invocation", [
  [at(14), "Mapping the responsive workout journey", "in_progress"],
  [at(68), "Responsive UI/UX flow delivered", "completed"],
]);

const buildWorkerHistory = workerHistory("worker-build-invocation", [
  [at(15), "Building the application shell", "in_progress"],
  [at(72), "Integrating workout logging and charts", "in_progress"],
  [at(103), "Paused on the shared color system", "blocked"],
  [at(109), "Applying the electric-blue tokens", "in_progress"],
  [at(154), "Application build completed", "completed"],
]);

const qaWorkerHistory = workerHistory("worker-quality-invocation", [
  [at(16), "Waiting for a testable build", "yet_to_start"],
  [at(74), "Testing responsive and keyboard behavior", "in_progress"],
  [at(100), "First quality pass completed", "completed"],
]);

function worker(
  workerId: string,
  invocationId: string,
  name: string,
  description: string,
  state: WorkWorkerInvocation["state"],
  revision: number,
  entries: WorkHistoryEntry[],
): WorkWorkerInvocation {
  return {
    worker_id: workerId,
    invocation_id: invocationId,
    name,
    description,
    state,
    revision,
    history: entries,
    created_at: at(14),
    updated_at: entries.at(-1)?.created_at ?? at(14),
  };
}

function workerGroup(stage: FitnessDemoStage, nowIso: string): WorkWorkerGroupEvent {
  const index = stageIndex(stage);
  const workerStage = index - 1;
  const designComplete = index >= 2;
  const buildState: WorkWorkerInvocation["state"] = index === 3
    ? "blocked"
    : index === 5
      ? "completed"
      : "in_progress";
  const buildHistoryCount = index === 1 ? 1 : index === 2 ? 2 : index === 3 ? 3 : index === 4 ? 4 : 5;
  const qaState: WorkWorkerInvocation["state"] = index === 1
    ? "yet_to_start"
    : index < 3
      ? "in_progress"
      : "completed";
  const qaHistoryCount = index === 1 ? 1 : index < 3 ? 2 : 3;

  return {
    ...eventBase(stage, nowIso, {
      id: "work-event-workers",
      kind: "worker_group",
      body: "Three focused workers are moving design, implementation, and quality forward in parallel.",
      createdAt: at(14),
      revision: workerStage,
      history: [
        history(
          "worker-group-created",
          "worker_updated",
          "Started three parallel workers",
          at(14),
          { entity_id: "fitness-workers", state: "in_progress", sequence: 0 },
        ),
        ...(index >= 2 ? [history(
          "worker-group-design-complete",
          "worker_updated",
          "Experience design worker completed",
          at(68),
          { entity_id: "fitness-workers", state: "in_progress", sequence: 1 },
        )] : []),
        ...(index >= 5 ? [history(
          "worker-group-complete",
          "worker_updated",
          "All workers completed",
          at(164),
          { entity_id: "fitness-workers", state: "completed", sequence: 2 },
        )] : []),
      ],
    }),
    kind: "worker_group",
    group_id: "fitness-workers",
    workers: [
      worker(
        "experience-designer",
        "worker-design-invocation",
        "Experience Mapper",
        "Design the responsive onboarding, workout, streak, and progress flows.",
        designComplete ? "completed" : "in_progress",
        designComplete ? 1 : 0,
        designWorkerHistory.slice(0, designComplete ? 2 : 1),
      ),
      worker(
        "application-builder",
        "worker-build-invocation",
        "Application Builder",
        "Build the app shell, workout logger, progress model, and interaction states.",
        buildState,
        buildHistoryCount - 1,
        buildWorkerHistory.slice(0, buildHistoryCount),
      ),
      worker(
        "quality-reviewer",
        "worker-quality-invocation",
        "Quality Reviewer",
        "Validate responsive behavior, keyboard access, and release readiness.",
        qaState,
        qaHistoryCount - 1,
        qaWorkerHistory.slice(0, qaHistoryCount),
      ),
    ],
  };
}

function transcript(
  id: string,
  speakerKind: WorkCallTranscriptEntry["speaker_kind"],
  speakerId: string,
  speakerName: string,
  body: string,
  createdAt: string,
): WorkCallTranscriptEntry {
  return {
    transcript_id: id,
    speaker_kind: speakerKind,
    speaker_id: speakerId,
    speaker_name: speakerName,
    body,
    blocks: [],
    revision: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function outboundCall(stage: FitnessDemoStage, nowIso: string): WorkCallEvent {
  const complete = stageIndex(stage) >= 2;
  const entries = [
    transcript(
      "outbound-transcript-1",
      "manager",
      "fitness-builder-manager",
      "Fitness Builder",
      "Can you sanity-check the motion and feedback pattern for workout completion?",
      at(16),
    ),
    transcript(
      "outbound-transcript-2",
      "silicon",
      "motion-silicon",
      "Motion Silicon",
      "Use one decisive completion transition, restrained haptics, and preserve reduced-motion behavior.",
      at(20),
    ),
    transcript(
      "outbound-transcript-3",
      "manager",
      "fitness-builder-manager",
      "Fitness Builder",
      "Perfect. I will apply that to the logging and streak moments.",
      at(21),
    ),
  ];
  return {
    ...eventBase(stage, nowIso, {
      id: "work-event-outbound-call",
      kind: "call",
      body: complete
        ? "Motion and feedback guidance received."
        : "Checking the workout-completion interaction with a specialist Silicon.",
      createdAt: at(16),
      revision: complete ? 1 : 0,
      history: [
        history(
          "outbound-call-started",
          "call_updated",
          "Calling Motion Silicon",
          at(16),
          { entity_id: "call-motion", state: "connecting", sequence: 0 },
        ),
        ...(complete ? [history(
          "outbound-call-completed",
          "call_updated",
          "Motion review completed",
          at(21),
          { entity_id: "call-motion", state: "completed", sequence: 1 },
        )] : []),
      ],
    }),
    kind: "call",
    call_id: "call-motion",
    direction: "outbound",
    target_kind: "silicon",
    target_id: "motion-silicon",
    target_name: "Motion Silicon",
    state: complete ? "completed" : "connecting",
    transcript: complete ? entries : entries.slice(0, 1),
  };
}

function milestoneEvent(stage: FitnessDemoStage, nowIso: string) {
  return {
    ...eventBase(stage, nowIso, {
      id: "work-event-ui-milestone",
      kind: "milestone",
      body: "UI/UX is complete. The responsive flows, information hierarchy, and workout feedback states are ready; implementation is now in the integration pass.",
      blocks: [{
        type: "text",
        format: "markdown",
        body: "**Included:** onboarding, daily plan, active workout, completion feedback, streaks, and the progress dashboard.",
      }],
      createdAt: at(68),
      revision: Math.max(0, stageIndex(stage) - 2),
      history: [history(
        "ui-milestone-created",
        "milestone",
        "Published the UI/UX milestone",
        at(68),
        { entity_id: "work-event-ui-milestone", state: "completed", sequence: 0 },
      )],
    }),
    kind: "milestone" as const,
  };
}

function inboundCall(stage: FitnessDemoStage, nowIso: string): WorkCallEvent {
  const complete = stageIndex(stage) >= 3;
  const entries = [
    transcript(
      "inbound-transcript-1",
      "silicon",
      "coach-os-silicon",
      "CoachOS Silicon",
      "The workout schema should keep exercise identity separate from each logged set.",
      at(73),
    ),
    transcript(
      "inbound-transcript-2",
      "manager",
      "fitness-builder-manager",
      "Fitness Builder",
      "Agreed. That keeps templates reusable while progress remains event-based.",
      at(74),
    ),
    transcript(
      "inbound-transcript-3",
      "silicon",
      "coach-os-silicon",
      "CoachOS Silicon",
      "Exactly. I have shared the edge cases for skipped and partially completed sets.",
      at(76),
    ),
  ];
  return {
    ...eventBase(stage, nowIso, {
      id: "work-event-inbound-call",
      kind: "call",
      body: complete
        ? "Workout data-model edge cases received and incorporated."
        : "CoachOS Silicon called with workout data-model guidance.",
      createdAt: at(73),
      revision: complete ? 1 : 0,
      history: [
        history(
          "inbound-call-received",
          "call_updated",
          "Received call from CoachOS Silicon",
          at(73),
          { entity_id: "call-coach-os", state: "in_progress", sequence: 0 },
        ),
        ...(complete ? [history(
          "inbound-call-completed",
          "call_updated",
          "CoachOS guidance incorporated",
          at(76),
          { entity_id: "call-coach-os", state: "completed", sequence: 1 },
        )] : []),
      ],
    }),
    kind: "call",
    call_id: "call-coach-os",
    direction: "inbound",
    target_kind: "silicon",
    target_id: "coach-os-silicon",
    target_name: "CoachOS Silicon",
    state: complete ? "completed" : "in_progress",
    transcript: complete ? entries : entries.slice(0, 2),
  };
}

function blockerEvent(
  stage: FitnessDemoStage,
  nowIso: string,
): WorkBlockerEvent {
  const resolved = stageIndex(stage) >= 4;
  const browserExpiry = new Date(Date.parse(nowIso) + 30 * 60_000).toISOString();
  return {
    ...eventBase(stage, nowIso, {
      id: "work-event-brand-blocker",
      kind: "blocker",
      body: "Should the primary color be electric blue or vivid red?",
      blocks: [
        {
          type: "text",
          format: "markdown",
          body: "The choice will be applied to **primary actions, active workout states, progress charts, and focus treatment**.",
        },
        {
          type: "remote_browser",
          url: "https://example.com/fitness-app/brand-preview",
          title: "Interactive brand preview",
          session_id: "demo-brand-preview",
          ttl_minutes: 30,
          expires_at: browserExpiry,
          closed: resolved,
        },
      ],
      createdAt: at(103),
      revision: resolved ? 1 : 0,
      history: [
        history(
          "brand-blocker-opened",
          "blocker_opened",
          "Requested the primary color decision",
          at(103),
          { entity_id: "blocker-brand-color", state: "blocked", sequence: 0 },
        ),
        ...(resolved ? [history(
          "brand-blocker-resolved",
          "blocker_resolved",
          "Electric blue selected",
          at(109),
          { entity_id: "blocker-brand-color", state: "completed", sequence: 1 },
        )] : []),
      ],
    }),
    kind: "blocker",
    blocker_id: "blocker-brand-color",
    state: resolved ? "resolved" : "open",
    resolved_at: resolved ? at(109) : null,
  };
}

function completionEvent(stage: FitnessDemoStage, nowIso: string) {
  return {
    ...eventBase(stage, nowIso, {
      id: "work-event-completion",
      kind: "completion",
      body: "The responsive fitness app is complete with workout planning, active logging, streak feedback, progress charts, and accessibility checks.",
      blocks: [{
        type: "text",
        format: "markdown",
        body: "**Delivered:** polished responsive interface, reusable workout model, keyboard-safe interactions, and verified empty/error states.",
      }],
      createdAt: at(166),
      revision: 0,
      history: [history(
        "completion-published",
        "completed",
        "Published the completed delivery",
        at(166),
        { entity_id: "work-event-completion", state: "completed", sequence: 0 },
      )],
    }),
    kind: "completion" as const,
  };
}

function message(
  id: string,
  senderKind: "carbon" | "silicon",
  senderHandle: string,
  body: string,
  createdAt: string,
  options: {
    isFinal?: boolean;
    workContinues?: boolean;
    replyToEventId?: string;
  } = {},
): Event {
  return {
    event_id: id,
    room: 1,
    sender_kind: senderKind,
    sender_id: senderKind === "carbon" ? 1 : 2,
    sender_handle: senderHandle,
    sender_public_id: senderHandle,
    type: "m.text",
    content: {
      body,
      ...(options.workContinues ? { work_continues: true } : {}),
    },
    reply_to_event_id: options.replyToEventId ?? "",
    is_final: options.isFinal ?? true,
    created_at: createdAt,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

function managerFrame(
  frameId: string,
  kind: ManagerActivityFrame["kind"],
  note: string,
  occurredAt: string,
  progress: number,
): ManagerActivityFrame {
  return {
    frame_id: frameId,
    progress_group_id: "fitness-manager-run",
    room_id: FITNESS_DEMO_ROOM_ID,
    task_id: FITNESS_DEMO_TASK_ID,
    kind,
    note,
    progress_pct: progress,
    revision: 0,
    occurred_at: occurredAt,
  };
}

const managerFrames: readonly ManagerActivityFrame[] = [
  managerFrame("manager-thinking", "thinking", "Mapping the product scope", at(1), 4),
  managerFrame("manager-reading", "reading", "Reading the fitness and accessibility references", at(2), 9),
  managerFrame("manager-spawning", "spawning_worker", "Spawning design, build, and quality workers", at(14), 18),
  managerFrame("manager-executing", "executing", "Integrating the parallel workstreams", at(42), 42),
  managerFrame("manager-writing", "writing", "Writing the progress dashboard and workout states", at(72), 63),
  managerFrame("manager-paused", "done", "Paused until the brand decision arrives", at(103), 68),
  managerFrame("manager-resumed", "reading", "Applying the electric-blue direction", at(109), 71),
  managerFrame("manager-verifying", "executing", "Verifying the completed fitness experience", at(154), 94),
  managerFrame("manager-finished", "done", "manager finished", at(166), 100),
];

function managerGroup(stage: FitnessDemoStage): ManagerActivityGroup | null {
  const count = [2, 4, 5, 6, 7, 9][stageIndex(stage)];
  const frames = managerFrames.slice(0, count);
  const settled = stage === "blocked" || stage === "completed";
  const current = settled ? null : frames.at(-1) ?? null;
  return {
    progress_group_id: "fitness-manager-run",
    room_id: FITNESS_DEMO_ROOM_ID,
    task_id: FITNESS_DEMO_TASK_ID,
    current,
    history: [...frames],
    display:
      stage === "completed"
        ? "replaced"
        : settled
          ? "history"
          : "active",
    replaced_by_event_id: stage === "completed" ? "demo-message-final" : null,
    updated_at: frames.at(-1)?.occurred_at ?? at(1),
  };
}

const stagePresentation: Record<
  FitnessDemoStage,
  Pick<FitnessDemoScene, "stageLabel" | "stageDescription" | "roomStatus" | "working" | "workingNote">
> = {
  kickoff: {
    stageLabel: "Kickoff",
    stageDescription: "The manager scopes the request and publishes a durable plan.",
    roomStatus: "Reading product requirements",
    working: true,
    workingNote: "Reading fitness references",
  },
  "parallel-work": {
    stageLabel: "Parallel work",
    stageDescription: "Three workers and a specialist call move the plan forward together.",
    roomStatus: "3 workers active",
    working: true,
    workingNote: "3 workers active",
  },
  milestone: {
    stageLabel: "Milestone",
    stageDescription: "UI/UX lands while implementation and an inbound call continue.",
    roomStatus: "Integrating the application",
    working: true,
    workingNote: "Integrating the application",
  },
  blocked: {
    stageLabel: "Blocker",
    stageDescription: "Work pauses for a Carbon decision and the elapsed timer stops.",
    roomStatus: "Waiting for your answer",
    working: false,
    workingNote: "",
  },
  resumed: {
    stageLabel: "Resumed",
    stageDescription: "The blocker resolves, retained history stays visible, and work resumes.",
    roomStatus: "Applying electric blue",
    working: true,
    workingNote: "Applying electric blue",
  },
  completed: {
    stageLabel: "Completed",
    stageDescription: "The stopped timer, completion card, final answer, and confetti close the run.",
    roomStatus: "Online",
    working: false,
    workingNote: "",
  },
};

function roomForStage(
  stage: FitnessDemoStage,
  lastMessage: Event | null,
): Room {
  const index = stageIndex(stage);
  const lastPreview = stage === "blocked"
    ? "BLOCKER · Choose the primary color"
    : stage === "completed"
      ? "Fitness app delivered"
      : stage === "milestone"
        ? "UPDATE · UI/UX is complete"
        : stage === "parallel-work"
          ? "Started 3 workers"
          : stage === "resumed"
            ? "Applying electric blue"
            : "Build a Fitness App";
  const lastType = stage === "blocked" || stage === "milestone" || stage === "parallel-work"
    ? "m.work_event"
    : lastMessage?.type ?? "m.work_task";
  return {
    room_id: FITNESS_DEMO_ROOM_ID,
    kind: "direct",
    team: null,
    team_slug: null,
    peer_kinds: ["silicon"],
    peers: [{
      kind: "silicon",
      id: "fitness-builder",
      handle: "fitness-builder",
      name: "Fitness Builder Silicon",
      profile_photo_url: null,
      profile_ascii_url: null,
      connection_state: "online",
    }],
    unread: false,
    unread_count: 0,
    unread_boundary: {
      last_read_stream_position: index + 1,
      first_unread_event_id: null,
      first_unread_stream_position: null,
      first_unread_stream_writer: null,
      unread_count: 0,
      through_stream_position: index + 1,
    },
    observed: false,
    notification_preferences: null,
    list_preferences: { pinned: true, archived: false },
    list_projection: {
      version: 1,
      complete: true,
      through_stream_position: index + 1,
      activity_stream_position: index + 1,
      activity_at: stage === "completed" ? at(167) : at(2 + index * 20),
      draft: { active: false, version: 0, updated_at: "", origin_device: "" },
      held: { active_count: 0, attention_count: 0, next_release_at: "" },
    },
    last_event: {
      event_id: lastMessage?.event_id ?? `demo-last-${stage}`,
      preview: lastPreview,
      at: lastMessage?.created_at ?? at(2 + index * 20),
      sender_handle: "fitness-builder",
      sender_kind: "silicon",
      type: lastType,
      read: true,
    },
    name: "Fitness Builder Silicon",
    topic: "Build a Fitness App",
    settings: {},
    security_mode: "server_managed",
    security_version: 1,
    security_frozen_at: null,
    created_by_kind: "carbon",
    created_by_id: 1,
    created_at: at(0),
    updated_at: stage === "completed" ? at(167) : at(2 + index * 20),
  };
}

export function buildFitnessDemoScene(
  stageValue: FitnessDemoStage,
  nowIso: string,
  carbonReply = "Use electric blue — it feels energetic and focused.",
): FitnessDemoScene {
  const stage = fitnessDemoStage(stageValue);
  const index = stageIndex(stage);
  const timeline: FitnessDemoTimelineItem[] = [];
  const pushMessage = (
    event: Event,
    mine: boolean,
    managerActivity?: ManagerActivityGroup,
  ) => {
    timeline.push({ id: event.event_id, kind: "message", event, mine, managerActivity });
  };
  const pushWork = (record: WorkTimelineRecord) => {
    const id = record.type === "m.work_task"
      ? record.task.task_id
      : record.event.work_event_id;
    timeline.push({ id, kind: "work", record });
  };

  pushMessage(message(
    "demo-message-request",
    "carbon",
    "alex",
    "Build me a fitness app that makes the daily workout obvious, keeps logging quick, and makes progress feel motivating.",
    at(0),
  ), true);
  pushMessage(message(
    "demo-message-prework",
    "silicon",
    "fitness-builder",
    "Got it. I’m pulling together the product, accessibility, and workout-flow references now.",
    at(1),
    { isFinal: false, workContinues: true },
  ), false);

  const manager = managerGroup(stage);
  if (manager && stage !== "completed") {
    timeline.push({
      id: `manager:${manager.progress_group_id}`,
      kind: "manager",
      group: manager,
      initiallyExpanded: false,
    });
  }

  pushWork({ type: "m.work_task", task: taskSnapshot(stage, nowIso) });

  if (index >= 1) {
    pushMessage(message(
      "demo-message-split",
      "silicon",
      "fitness-builder",
      "The plan is locked. I’ve split design, implementation, and quality into parallel workstreams.",
      at(13),
      { isFinal: false, workContinues: true },
    ), false);
    pushWork({ type: "m.work_event", event: workerGroup(stage, nowIso) });
    pushWork({ type: "m.work_event", event: outboundCall(stage, nowIso) });
  }

  if (index >= 2) {
    pushWork({ type: "m.work_event", event: milestoneEvent(stage, nowIso) });
    pushWork({ type: "m.work_event", event: inboundCall(stage, nowIso) });
  }

  if (index >= 3) {
    pushWork({ type: "m.work_event", event: blockerEvent(stage, nowIso) });
  }

  if (index >= 4) {
    pushMessage(message(
      "demo-message-blocker-reply",
      "carbon",
      "alex",
      carbonReply,
      at(108),
      { replyToEventId: "work-event-brand-blocker" },
    ), true);
    pushMessage(message(
      "demo-message-resuming",
      "silicon",
      "fitness-builder",
      "Electric blue it is. I’ve resumed the timer and I’m applying it across the product system.",
      at(109),
      { isFinal: false, workContinues: true },
    ), false);
  }

  let finalMessage: Event | null = null;
  if (index >= 5) {
    pushWork({ type: "m.work_event", event: completionEvent(stage, nowIso) });
    finalMessage = message(
      "demo-message-final",
      "silicon",
      "fitness-builder",
      "Done — the fitness app is complete. The daily plan, workout logger, streak feedback, progress dashboard, responsive behavior, and accessibility pass are all in place.",
      at(167),
      { isFinal: true },
    );
    pushMessage(finalMessage, false);
  }

  return {
    stage,
    stageIndex: index,
    ...stagePresentation[stage],
    room: roomForStage(stage, finalMessage),
    timeline,
  };
}
