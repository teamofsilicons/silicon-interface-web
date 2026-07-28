"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  PaperPlaneTilt,
  X,
} from "@phosphor-icons/react/dist/ssr";

import { Logo } from "@/components/logo";
import { IdAvatar } from "@/components/profile/id-avatar";
import { Button } from "@/components/ui/button";
import { setCachedMedia } from "@/lib/media-cache";
import type { Event, MediaObject } from "@/lib/types";
import {
  buildWorkUpdateCatalog,
  resolveCatalogBlocker,
  WORK_UPDATE_CATALOG_MEDIA,
  WORK_UPDATE_CATALOG_ORDER,
  WORK_UPDATE_CATALOG_SILICON,
  type WorkUpdateCatalogSpecimen,
} from "@/lib/work-update-catalog";
import type {
  WorkBlockerEvent,
  WorkTimelineRecord,
} from "@/lib/work-update-types";

import { MessageBubble } from "./message-bubble";
import {
  WorkEventCard,
  WorkManagerActivityHistory,
} from "./work-event-card";

function catalogMedia(
  mediaId: string,
  kind: "image" | "file",
  mime: string,
  width: number | null = null,
  height: number | null = null,
): MediaObject {
  return {
    media_id: mediaId,
    uploader_kind: "silicon",
    uploader_id: 2,
    mime,
    size: 384,
    sha256: `catalog-${mediaId}`,
    status: "ready",
    kind,
    transcript: "",
    transcription_status: "not_started",
    transcription_provider: "",
    duration_ms: null,
    peaks: null,
    width,
    height,
    created_at: "2026-07-23T09:30:00.000Z",
    updated_at: "2026-07-23T09:30:00.000Z",
  };
}

setCachedMedia(WORK_UPDATE_CATALOG_MEDIA.image, {
  media: catalogMedia(
    WORK_UPDATE_CATALOG_MEDIA.image,
    "image",
    "image/svg+xml",
    640,
    360,
  ),
  download_url: "/logo.svg",
});
setCachedMedia(WORK_UPDATE_CATALOG_MEDIA.file, {
  media: catalogMedia(
    WORK_UPDATE_CATALOG_MEDIA.file,
    "file",
    "text/plain",
  ),
  download_url: "data:text/plain;charset=utf-8,Fitness%20accessibility%20and%20brand%20constraints",
});

function catalogMessageEvent(
  specimen: Extract<WorkUpdateCatalogSpecimen, { kind: "message" }>,
): Event {
  const carbon = specimen.sender === "carbon";
  return {
    event_id: `catalog-message-${specimen.id}`,
    room: 1,
    sender_kind: carbon ? "carbon" : "silicon",
    sender_id: carbon ? 1 : 2,
    sender_handle: carbon ? "alex" : WORK_UPDATE_CATALOG_SILICON.id,
    sender_public_id: carbon ? "alex" : WORK_UPDATE_CATALOG_SILICON.id,
    type: "m.text",
    content: { body: specimen.body },
    reply_to_event_id: "",
    is_final: true,
    created_at: `2026-07-23T${specimen.time === "3:01 PM" ? "09:31" : "12:17"}:00.000Z`,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

function replyEvent(
  blockerId: string,
  body: string,
): Event {
  return {
    event_id: `catalog-reply-${blockerId}`,
    room: 1,
    sender_kind: "carbon",
    sender_id: 1,
    sender_handle: "alex",
    sender_public_id: "alex",
    type: "m.text",
    content: { body },
    reply_to_event_id: blockerId,
    is_final: true,
    created_at: "2026-07-23T11:18:00.000Z",
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

function WorkRow({
  specimen,
  record,
  onReply,
}: {
  specimen: Extract<WorkUpdateCatalogSpecimen, { kind: "work" }>;
  record: WorkTimelineRecord;
  onReply: (blockerId: string, event: WorkBlockerEvent) => void;
}) {
  return (
    <div
      className="flex min-w-0 items-start gap-2"
      data-catalog-author-id={WORK_UPDATE_CATALOG_SILICON.id}
      data-catalog-author-kind="silicon"
    >
      <IdAvatar
        seed={WORK_UPDATE_CATALOG_SILICON.id}
        size={28}
        family={WORK_UPDATE_CATALOG_SILICON.family}
        className="mt-0.5"
      />
      <WorkEventCard
        event={record}
        task={specimen.task}
        onReply={onReply}
      />
    </div>
  );
}

function BlockerReplyComposer({
  blocker,
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  blocker: WorkBlockerEvent;
  draft: string;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="ml-9 mt-3 w-[min(34rem,calc(100%-2.25rem))] border bg-elevated shadow-xs"
      aria-label={`Reply to blocker ${blocker.blocker_id}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="label-mono text-[9px] tracking-[0.12em] text-muted-foreground">
            REPLYING TO BLOCKER
          </p>
          <p className="mt-1 line-clamp-2 text-xs">{blocker.body}</p>
        </div>
        <button
          type="button"
          aria-label="Cancel blocker reply"
          className="grid h-7 w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="flex gap-2 p-2">
        <textarea
          autoFocus
          rows={2}
          value={draft}
          aria-label={`Answer ${blocker.blocker_id}`}
          placeholder="Answer the blocker…"
          className="min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <Button
          type="submit"
          size="icon"
          aria-label={`Send answer for ${blocker.blocker_id}`}
          disabled={!draft.trim()}
          className="h-10 w-10 self-end rounded-none"
        >
          <PaperPlaneTilt className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </form>
  );
}

function AnsweredBlocker({
  blockerId,
  answer,
}: {
  blockerId: string;
  answer: string;
}) {
  return (
    <div className="ml-9 mt-3 space-y-2">
      <MessageBubble
        event={replyEvent(blockerId, answer)}
        isMine
        status="read"
        showSender={false}
        isDirect
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-4 w-4 text-success" weight="bold" aria-hidden />
        This blocker is resolved. Other blockers remain independent.
      </div>
    </div>
  );
}

export function WorkUpdateCatalog({ nowIso }: { nowIso: string }) {
  const catalog = React.useMemo(
    () => buildWorkUpdateCatalog(nowIso),
    [nowIso],
  );
  const [replyTarget, setReplyTarget] = React.useState<WorkBlockerEvent | null>(null);
  const [draft, setDraft] = React.useState("");
  const [answers, setAnswers] = React.useState<Record<string, string>>({});

  const beginReply = React.useCallback((
    blockerId: string,
    event: WorkBlockerEvent,
  ) => {
    setReplyTarget({ ...event, blocker_id: blockerId });
    setDraft("");
  }, []);

  const submitReply = React.useCallback(() => {
    const body = draft.trim();
    if (!replyTarget || !body) return;
    setAnswers((current) => ({
      ...current,
      [replyTarget.blocker_id]: body,
    }));
    setReplyTarget(null);
    setDraft("");
  }, [draft, replyTarget]);

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="z-30 flex h-[58px] shrink-0 items-center justify-between border-b bg-sidebar/95 px-4 backdrop-blur sm:px-6">
        <Logo size={26} withWordmark />
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            production components · local data
          </span>
          <span className="label-mono border bg-background px-2 py-1 text-[9px] tracking-[0.12em]">
            ALL WORK UPDATES
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-72 shrink-0 flex-col border-r bg-sidebar lg:flex">
          <div className="border-b px-5 py-4">
            <p className="text-sm font-semibold">Update index</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Every supported update is rendered once with a stable anchor.
            </p>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Update catalog">
            <ol>
              {catalog.specimens.map((specimen, index) => (
                <li key={specimen.id}>
                  <a
                    href={`#catalog-${specimen.id}`}
                    className="group flex min-h-9 items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <span className="w-5 shrink-0 font-mono text-[9px]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{specimen.label}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </aside>

        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-smooth">
          <div className="mx-auto w-full max-w-4xl px-4 pb-20 pt-7 sm:px-8">
            <div className="mb-4 border-b pb-6">
              <p className="label-mono text-[9px] tracking-[0.14em] text-muted-foreground">
                LOCAL INSPECTION CATALOG
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">
                Every work update, in one place
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                The small numbered labels exist only on this development page.
                Each update below uses the same component, details dialog, timer,
                avatar, and reply behavior as the chat timeline.
              </p>
            </div>

            <ol className="divide-y">
              {catalog.specimens.map((specimen, index) => {
                const answer = specimen.kind === "work" &&
                    specimen.record.type === "m.work_event" &&
                    specimen.record.event.kind === "blocker"
                  ? answers[specimen.record.event.blocker_id]
                  : undefined;
                const record = specimen.kind === "work"
                  ? resolveCatalogBlocker(specimen.record, answer, nowIso)
                  : null;
                const blocker = record?.type === "m.work_event" &&
                    record.event.kind === "blocker"
                  ? record.event
                  : null;

                return (
                  <li
                    key={specimen.id}
                    id={`catalog-${specimen.id}`}
                    className="scroll-mt-4 py-7"
                    data-catalog-item-id={specimen.id}
                    data-catalog-order={index + 1}
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <span className="font-mono text-[9px] text-muted-foreground">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="label-mono text-[9px] tracking-[0.12em] text-muted-foreground">
                        {specimen.label}
                      </span>
                    </div>

                    {specimen.kind === "message" ? (
                      <div
                        data-catalog-author-id={
                          specimen.sender === "silicon"
                            ? WORK_UPDATE_CATALOG_SILICON.id
                            : "alex"
                        }
                        data-catalog-author-kind={specimen.sender}
                      >
                        <MessageBubble
                          event={catalogMessageEvent(specimen)}
                          isMine={specimen.sender === "carbon"}
                          managerActivity={specimen.managerActivity ? (
                            <WorkManagerActivityHistory
                              group={specimen.managerActivity}
                              initiallyExpanded={false}
                            />
                          ) : undefined}
                          status={specimen.sender === "carbon" ? "read" : undefined}
                          senderAvatarKind={specimen.sender}
                          senderDisplayName={
                            specimen.sender === "silicon"
                              ? WORK_UPDATE_CATALOG_SILICON.name
                              : "Alex"
                          }
                          showSender
                          isDirect
                        />
                      </div>
                    ) : specimen.kind === "manager" ? (
                      <div
                        data-catalog-author-id={WORK_UPDATE_CATALOG_SILICON.id}
                        data-catalog-author-kind="silicon"
                      >
                        <WorkManagerActivityHistory
                          group={specimen.group}
                          initiallyExpanded={false}
                          avatarSeed={WORK_UPDATE_CATALOG_SILICON.id}
                          avatarFamily={WORK_UPDATE_CATALOG_SILICON.family}
                        />
                      </div>
                    ) : record ? (
                      <>
                        <WorkRow
                          specimen={specimen}
                          record={record}
                          onReply={beginReply}
                        />
                        {blocker && replyTarget?.blocker_id === blocker.blocker_id ? (
                          <BlockerReplyComposer
                            blocker={blocker}
                            draft={draft}
                            onDraftChange={setDraft}
                            onCancel={() => {
                              setReplyTarget(null);
                              setDraft("");
                            }}
                            onSubmit={submitReply}
                          />
                        ) : null}
                        {blocker && answer ? (
                          <AnsweredBlocker
                            blockerId={blocker.work_event_id}
                            answer={answer}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <p className="pt-8 text-center font-mono text-[9px] tracking-[0.12em] text-muted-foreground">
              {WORK_UPDATE_CATALOG_ORDER.length} UPDATE SPECIMENS · LOCAL ONLY · NOTHING IS SENT
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
