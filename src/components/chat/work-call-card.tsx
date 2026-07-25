"use client";

import * as React from "react";
import {
  CaretRight,
  CheckCircle,
  PhoneIncoming,
  PhoneOutgoing,
  SpinnerGap,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react/dist/ssr";

import { MarkdownView } from "@/components/chat/markdown-view";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { workCallPreviewContent } from "@/lib/work-call-presentation";

import { WorkHistory } from "./work-update-shared";
import type { WorkCallState, WorkCallView } from "./work-update-types";

const callStateLabel: Record<WorkCallState, string> = {
  calling: "Connecting",
  connected: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function CallStateIcon({ state }: { state: WorkCallState }) {
  if (state === "calling" || state === "connected") {
    return (
      <SpinnerGap
        className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
        weight="bold"
        aria-hidden
      />
    );
  }
  if (state === "completed") return <CheckCircle className="h-3.5 w-3.5 text-success" weight="fill" aria-hidden />;
  if (state === "failed") return <WarningCircle className="h-3.5 w-3.5 text-destructive" weight="fill" aria-hidden />;
  return <XCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />;
}

function callTitle(call: WorkCallView): string {
  if (call.direction === "inbound") return `Received call from ${call.peer}`;
  if (call.state === "calling" || call.state === "connected") return `Calling ${call.peer}`;
  return `Called ${call.peer}`;
}

function transcriptTime(value: string | number): string {
  const instant = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(instant)) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(instant);
}

export interface WorkCallCardProps {
  call: WorkCallView;
  className?: string;
}

/** Persistent inbound/outbound manager or Silicon call with full transcript. */
export function WorkCallCard({ call, className }: WorkCallCardProps) {
  const title = callTitle(call);
  const PhoneIcon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  const contentPreview = workCallPreviewContent(call);

  return (
    <article
      className={cn("w-full max-w-[36rem] overflow-hidden border bg-elevated shadow-sm", className)}
      data-work-event-id={call.id}
      data-work-event-kind="call"
    >
      {call.taskTitle ? (
        <div className="border-b px-3.5 py-2 font-mono text-[10px] tracking-wide text-muted-foreground">
          {call.taskTitle}
        </div>
      ) : null}
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-accent"
            aria-label={`${title}. Open call transcript`}
          >
            <PhoneIcon className="h-5 w-5 shrink-0" weight="fill" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-semibold">{title}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <CallStateIcon state={call.state} />
                {callStateLabel[call.state]}
              </span>
              {contentPreview ? (
                <span className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                  {contentPreview}
                </span>
              ) : null}
            </span>
            <CaretRight className="h-4 w-4 shrink-0 text-muted-foreground" weight="bold" aria-hidden />
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[min(88dvh,48rem)] w-[calc(100%-1.5rem)] max-w-2xl gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <PhoneIcon className="h-5 w-5" weight="fill" aria-hidden />
              {title}
            </DialogTitle>
            <DialogDescription>
              {call.summary ?? `${callStateLabel[call.state]} · conversation transcript`}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[calc(min(88dvh,48rem)-5rem)]">
            <div className="space-y-6 px-5 py-5">
              {call.content ? (
                <section aria-label="Call attachments" className="min-w-0">
                  {call.content}
                </section>
              ) : null}
              <section aria-label="Call transcript">
                {call.transcript.length ? (
                  <ol className="space-y-3">
                    {call.transcript.map((entry) => (
                      <li key={entry.id} className="border-l-2 border-foreground/35 pl-3">
                        <div className="flex min-w-0 items-baseline justify-between gap-3">
                          <p className="truncate text-xs font-semibold">{entry.speaker}</p>
                          <time className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {transcriptTime(entry.at)}
                          </time>
                        </div>
                        {entry.body ? <MarkdownView source={entry.body} compact className="mt-1" /> : null}
                        {entry.content ? <div className="mt-2 min-w-0">{entry.content}</div> : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">No transcript entries yet.</p>
                )}
              </section>
              {call.history?.length ? (
                <section aria-label="Call history">
                  <h3 className="label-mono mb-3 text-[10px] tracking-wide text-muted-foreground">CALL HISTORY</h3>
                  <WorkHistory entries={call.history} />
                </section>
              ) : null}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </article>
  );
}
