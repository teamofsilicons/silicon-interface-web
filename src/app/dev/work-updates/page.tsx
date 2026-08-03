import { notFound } from "next/navigation";

import { MessageBubble } from "@/components/chat/message-bubble";
import { WorkUpdateCatalog } from "@/components/chat/work-update-catalog";
import { WorkUpdateDemo } from "@/components/chat/work-update-demo";
import { workUpdateDemoAvailable } from "@/lib/work-update-demo-access";
import { fitnessDemoStage } from "@/lib/work-update-demo-fixtures";
import type { Event } from "@/lib/types";

function voiceTranscriptionPreviewEvent(nowIso: string): Event {
  return {
    event_id: "dev-voice-transcription-pending",
    room: 0,
    sender_kind: "carbon",
    sender_id: null,
    sender_handle: "alex",
    type: "m.voice",
    content: {
      duration_ms: 453_000,
      mime: "audio/webm",
      transcription_status: "pending",
      transcription_delivery_gate: "silicon",
      peaks: Array.from({ length: 72 }, (_, index) =>
        0.22 + (((index * 17) % 31) / 50),
      ),
    },
    reply_to_event_id: "",
    is_final: true,
    created_at: nowIso,
    edited_at: null,
    redacted_at: null,
    redaction_reason: "",
  };
}

export default async function WorkUpdatesDemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!workUpdateDemoAvailable(process.env.NODE_ENV)) notFound();

  const query = await searchParams;
  const rawStage = Array.isArray(query.stage) ? query.stage[0] : query.stage;
  const rawAutoplay = Array.isArray(query.autoplay)
    ? query.autoplay[0]
    : query.autoplay;
  const rawView = Array.isArray(query.view) ? query.view[0] : query.view;

  if (rawView === "voice-transcription") {
    const nowIso = new Date().toISOString();
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-8">
        <div className="w-full max-w-2xl">
          <MessageBubble
            event={voiceTranscriptionPreviewEvent(nowIso)}
            isMine
            status="pending"
            showSender={false}
            isDirect
          />
        </div>
      </main>
    );
  }

  if (rawView === "all") {
    return <WorkUpdateCatalog nowIso={new Date().toISOString()} />;
  }

  return (
    <WorkUpdateDemo
      initialStage={fitnessDemoStage(rawStage)}
      initialAutoplay={rawAutoplay === "1" || rawAutoplay === "true"}
      initialNowIso={new Date().toISOString()}
    />
  );
}
