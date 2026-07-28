"use client";

import * as React from "react";
import {
  ArrowBendUpLeft,
  MagnifyingGlass,
  PaperPlaneRight,
  Paperclip,
  Plus,
  Smiley,
  X,
} from "@phosphor-icons/react/dist/ssr";

import { Logo } from "@/components/logo";
import { IdAvatar } from "@/components/profile/id-avatar";
import { Button } from "@/components/ui/button";
import type { Contact } from "@/lib/types";
import type { WorkBlockerEvent } from "@/lib/work-update-types";
import {
  FITNESS_DEMO_ROOM_ID,
  buildFitnessDemoScene,
  fitnessDemoStage,
  nextFitnessDemoStage,
  type FitnessDemoStage,
} from "@/lib/work-update-demo-fixtures";
import { cn } from "@/lib/utils";

import { MessageBubble } from "./message-bubble";
import { RoomList } from "./room-list";
import { WorkEventCard, WorkManagerActivityHistory } from "./work-updates";

const AUTOPLAY_STEP_MS = 2_800;

const DEMO_CONTACTS = new Map<string, Contact>([[
  "silicon:fitness-builder",
  {
    id: -1,
    target_kind: "silicon",
    target_id: "fitness-builder",
    name: "Fitness Builder",
    note: "Local work-update demo",
    custom_photo: false,
    photo_url: null,
    target_name: "Fitness Builder Silicon",
    target_photo_url: null,
    created_at: "2026-07-23T09:30:00.000Z",
    updated_at: "2026-07-23T09:30:00.000Z",
  },
]]);

interface BlockerReplyTarget {
  blockerId: string;
  event: WorkBlockerEvent;
}

function validInstant(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}

function writeDemoUrl(
  stage: FitnessDemoStage,
  autoplay: boolean,
  mode: "push" | "replace",
) {
  const url = new URL(window.location.href);
  url.searchParams.set("stage", stage);
  if (autoplay) url.searchParams.set("autoplay", "1");
  else url.searchParams.delete("autoplay");
  window.history[mode === "push" ? "pushState" : "replaceState"](
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function DemoComposer({
  replyTarget,
  draft,
  inputRef,
  onDraftChange,
  onCancelReply,
  onSend,
}: {
  replyTarget: BlockerReplyTarget | null;
  draft: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onCancelReply: () => void;
  onSend: () => void;
}) {
  const canSend = Boolean(replyTarget && draft.trim());
  return (
    <form
      className="space-y-2 border-t bg-background p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
      aria-label="Local demo composer"
    >
      {replyTarget ? (
        <div className="flex items-start gap-2 border-l-2 border-foreground/60 bg-card px-2 py-1 text-xs">
          <ArrowBendUpLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="label-mono text-[10px] opacity-60">
              replying to blocker
            </div>
            <div className="truncate text-foreground/80">
              {replyTarget.event.body}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="cancel blocker reply"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="relative flex items-end gap-2">
        <button
          type="button"
          title="attachments are disabled in the local demo"
          aria-label="attach file"
          disabled
          className="flex h-11 w-11 shrink-0 items-center justify-center border border-input text-foreground opacity-45"
        >
          <Paperclip aria-hidden />
        </button>
        <div className="relative flex min-h-11 min-w-0 flex-1 items-center border border-input transition-colors focus-within:border-ring">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            disabled={!replyTarget}
            placeholder={replyTarget ? "answer the blocker…" : "Use “Reply to blocker” to try the local reply flow"}
            rows={1}
            className="relative z-10 w-full resize-none bg-transparent px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70"
          />
        </div>
        <button
          type="submit"
          disabled={!canSend}
          aria-label="send local blocker reply"
          className="flex h-11 w-11 shrink-0 items-center justify-center border border-input bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <PaperPlaneRight aria-hidden />
        </button>
        <button
          type="button"
          title="expressions are disabled in the local demo"
          aria-label="add emoji or GIF"
          disabled
          className="flex h-11 w-11 shrink-0 items-center justify-center border border-input bg-transparent text-foreground opacity-45"
        >
          <Smiley className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <p className="px-[52px] font-mono text-[9px] tracking-wide text-muted-foreground">
        LOCAL DEMO · NOTHING IS SENT OR SAVED
      </p>
    </form>
  );
}

export interface WorkUpdateDemoProps {
  initialStage: FitnessDemoStage;
  initialAutoplay?: boolean;
  initialNowIso: string;
}

export function WorkUpdateDemo({
  initialStage,
  initialAutoplay = false,
  initialNowIso,
}: WorkUpdateDemoProps) {
  const [stage, setStage] = React.useState(() => fitnessDemoStage(initialStage));
  const [playing, setPlaying] = React.useState(initialAutoplay);
  const [snapshotAt, setSnapshotAt] = React.useState(() => validInstant(initialNowIso));
  const [replyTarget, setReplyTarget] = React.useState<BlockerReplyTarget | null>(null);
  const [draft, setDraft] = React.useState("");
  const [carbonReply, setCarbonReply] = React.useState(
    "Use electric blue — it feels energetic and focused.",
  );
  const timelineRef = React.useRef<HTMLDivElement>(null);
  const composerInputRef = React.useRef<HTMLTextAreaElement>(null);

  const scene = React.useMemo(
    () => buildFitnessDemoScene(stage, snapshotAt, carbonReply),
    [carbonReply, snapshotAt, stage],
  );
  const currentTask = React.useMemo(() => {
    for (const item of scene.timeline) {
      if (item.kind === "work" && item.record.type === "m.work_task") {
        return item.record.task;
      }
    }
    return undefined;
  }, [scene.timeline]);

  const moveToStage = React.useCallback((
    next: FitnessDemoStage,
    options: { keepPlaying?: boolean; history?: "push" | "replace" } = {},
  ) => {
    const keepPlaying = options.keepPlaying ?? false;
    setStage(next);
    setSnapshotAt(new Date().toISOString());
    setPlaying(keepPlaying);
    if (next !== "blocked") {
      setReplyTarget(null);
      setDraft("");
    }
    writeDemoUrl(next, keepPlaying, options.history ?? "push");
  }, []);

  React.useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const next = fitnessDemoStage(params.get("stage"));
      setStage(next);
      setSnapshotAt(new Date().toISOString());
      setPlaying(params.get("autoplay") === "1");
      setReplyTarget(null);
      setDraft("");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  React.useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      const next = nextFitnessDemoStage(stage);
      if (!next) {
        setPlaying(false);
        writeDemoUrl(stage, false, "replace");
        return;
      }
      moveToStage(next, { keepPlaying: true, history: "replace" });
    }, AUTOPLAY_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [moveToStage, playing, stage]);

  React.useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTop = timeline.scrollHeight;
  }, [replyTarget, scene.timeline.length, stage]);

  const beginBlockerReply = React.useCallback((
    blockerId: string,
    event: WorkBlockerEvent,
  ) => {
    setPlaying(false);
    writeDemoUrl(stage, false, "replace");
    setReplyTarget({ blockerId, event });
    setDraft("");
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }, [stage]);

  const sendBlockerReply = React.useCallback(() => {
    const body = draft.trim();
    if (!replyTarget || !body) return;
    setCarbonReply(body);
    setReplyTarget(null);
    setDraft("");
    moveToStage("resumed");
  }, [draft, moveToStage, replyTarget]);

  const workingRooms = React.useMemo(
    () => scene.working ? new Set([FITNESS_DEMO_ROOM_ID]) : new Set<string>(),
    [scene.working],
  );
  const workingNotes = React.useMemo(
    (): Record<string, string> => scene.working
      ? { [FITNESS_DEMO_ROOM_ID]: scene.workingNote }
      : {},
    [scene.working, scene.workingNote],
  );

  return (
    <main
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-demo-stage={stage}
    >
      <header className="z-30 flex h-[58px] shrink-0 items-center justify-between border-b bg-sidebar/95 px-6 backdrop-blur">
        <Logo size={26} withWordmark />
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            local fixture · no backend
          </span>
          <span className="label-mono border bg-background px-2 py-1 text-[9px] tracking-[0.12em]">
            WORK UPDATE DEMO
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="relative z-10 hidden min-h-0 w-[21rem] shrink-0 flex-col border-r bg-sidebar shadow-[1px_0_14px_-3px_rgba(60,50,36,0.12)] md:flex">
          <div className="flex h-[52px] items-stretch border-b">
            <div className="flex flex-1 items-center gap-2 pl-6 pr-3">
              <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
              <input
                readOnly
                value=""
                placeholder="search Carbons + Silicons"
                className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                aria-label="Search demo conversations"
              />
            </div>
            <button
              type="button"
              disabled
              aria-label="new chat"
              className="m-2 grid h-8 w-8 shrink-0 self-center place-items-center border border-border text-foreground opacity-45"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <RoomList
            rooms={[scene.room]}
            myHandle="alex"
            contacts={DEMO_CONTACTS}
            selectedId={FITNESS_DEMO_ROOM_ID}
            onSelect={() => undefined}
            onNew={() => undefined}
            workingRoomIds={workingRooms}
            workingNotes={workingNotes}
          />
          <div className="border-t px-6 py-3 font-mono text-[9px] leading-relaxed text-muted-foreground">
            This room and its events exist only in memory for visual verification.
          </div>
        </aside>

        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <header className="group/header relative z-10 flex h-[68px] shrink-0 items-center gap-3 border-b bg-elevated pl-4 pr-4 shadow-[0_2px_12px_-6px_rgba(60,50,36,0.14)] sm:pl-6 sm:pr-6">
            <IdAvatar seed="fitness-builder" size={36} family="silicon" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold tracking-tight">
                Fitness Builder
              </h1>
              <p className="truncate text-xs text-muted-foreground" role="status" aria-live="polite">
                {scene.roomStatus}
              </p>
            </div>
            <Button size="icon" variant="ghost" disabled aria-label="search messages">
              <MagnifyingGlass aria-hidden />
            </Button>
          </header>

          <div
            ref={timelineRef}
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none] [overscroll-behavior-y:contain]"
            data-private
          >
            <div className="flex min-h-full flex-col justify-end">
              <div className="w-full shrink-0 px-4 py-4 sm:px-6">
                {scene.timeline.map((item) => {
                  if (item.kind === "message") {
                    return (
                      <div
                        key={item.id}
                        className={cn("my-3 flex w-full", item.mine ? "justify-end" : "justify-start")}
                        data-demo-item={item.id}
                      >
                        <MessageBubble
                          event={item.event}
                          isMine={item.mine}
                          managerActivity={
                            item.managerActivity ? (
                              <WorkManagerActivityHistory
                                group={item.managerActivity}
                                initiallyExpanded={false}
                                className="max-w-none"
                              />
                            ) : undefined
                          }
                          myHandle="alex"
                          isDirect
                          status={item.mine ? "read" : undefined}
                          senderAvatarKind={item.event.sender_kind}
                          senderDisplayName={item.mine ? "Alex" : "Fitness Builder"}
                          showSender={!item.mine}
                          showTime
                        />
                      </div>
                    );
                  }
                  if (item.kind === "manager") {
                    return (
                      <div key={item.id} className="my-3 flex w-full justify-start" data-demo-item={item.id}>
                        <WorkManagerActivityHistory
                          group={item.group}
                          initiallyExpanded={item.initiallyExpanded}
                          avatarSeed="fitness-builder"
                          avatarFamily="silicon"
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "my-3 flex w-full items-start justify-start gap-2",
                      )}
                      data-demo-item={item.id}
                    >
                      <IdAvatar
                        seed="fitness-builder"
                        size={28}
                        family="silicon"
                        className="mt-0.5"
                      />
                      <WorkEventCard
                        event={item.record}
                        task={currentTask}
                        onReply={beginBlockerReply}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="h-2 shrink-0" />
            </div>
          </div>

          <DemoComposer
            replyTarget={replyTarget}
            draft={draft}
            inputRef={composerInputRef}
            onDraftChange={setDraft}
            onCancelReply={() => {
              setReplyTarget(null);
              setDraft("");
            }}
            onSend={sendBlockerReply}
          />
        </section>
      </div>
    </main>
  );
}
