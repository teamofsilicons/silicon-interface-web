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
  const active = call.state === "calling" || call.state === "connected";
  const historyId = React.useId();
  const [historyExpanded, setHistoryExpanded] = React.useState(false);
  const summary = call.summary?.trim();
  const visibleSummary =
    summary && summary.localeCompare(title, undefined, { sensitivity: "base" }) !== 0
      ? summary
      : null;

  return (
    <article
      className={cn("w-full max-w-[34rem]", className)}
      data-work-event-id={call.id}
      data-work-event-kind="call"
    >
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className="group -ml-1 flex min-h-10 w-[calc(100%+0.25rem)] min-w-0 items-center gap-2.5 px-1 py-1.5 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label={`${title}. ${callStateLabel[call.state]}. Open call transcript`}
          >
            <PhoneIcon className="h-5 w-5 shrink-0" weight="regular" aria-hidden />
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              <span className={cn(
                "min-w-0 truncate text-sm font-medium",
                active && "manager-activity-shimmer",
              )}>
                {title}
              </span>
              <span className="sr-only">{callStateLabel[call.state]}.</span>
              {call.state !== "completed" ? (
                <CallStateIcon state={call.state} />
              ) : null}
              <CaretRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                weight="bold"
                aria-hidden
              />
            </span>
          </button>
        </DialogTrigger>
        <DialogContent className="max-h-[min(88dvh,48rem)] w-[calc(100%-1.5rem)] max-w-2xl gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle className="flex items-center gap-2 text-base">
              <PhoneIcon className="h-5 w-5" weight="fill" aria-hidden />
              {title}
            </DialogTitle>
            <DialogDescription className={cn(!visibleSummary && "sr-only")}>
              {visibleSummary ?? `${callStateLabel[call.state]} conversation with ${call.peer}`}
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
                  <p className="text-sm text-muted-foreground">No conversation content yet.</p>
                )}
              </section>
              {call.history?.length ? (
                <section aria-label="Call history">
                  <button
                    type="button"
                    className="group -ml-1 flex min-h-8 items-center gap-1.5 px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-expanded={historyExpanded}
                    aria-controls={historyId}
                    onClick={() => setHistoryExpanded((value) => !value)}
                  >
                    <CaretRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                        historyExpanded && "rotate-90",
                      )}
                      weight="bold"
                      aria-hidden
                    />
                    <span className="label-mono text-[10px] tracking-wide text-muted-foreground transition-colors group-hover:text-foreground">
                      CALL HISTORY
                    </span>
                  </button>
                  {historyExpanded ? (
                    <div id={historyId} className="mt-3">
                      <WorkHistory entries={call.history} />
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </article>
  );
}
