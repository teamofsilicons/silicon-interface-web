"use client";

import * as React from "react";
import { Microphone, PaperPlaneRight, Pause, Trash } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import {
  useVoiceRecordingPreviewUrl,
  useVoiceRecordingSession,
  useVoiceRecordingWaveform,
  voiceRecordingSession,
} from "@/lib/voice-recording-session";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SiliconAudio, VoiceWaveform } from "./silicon-audio";

/**
 * Controls for the browser-tab-wide voice recording session.
 *
 * MediaRecorder itself lives in `voice-recording-session.ts`, outside the
 * keyed RoomView tree. This component can therefore unmount while another chat
 * is open and remount later without interrupting the recording.
 */
export function VoiceRecorder() {
  const session = useVoiceRecordingSession();
  const waveform = useVoiceRecordingWaveform();
  const previewUrl = useVoiceRecordingPreviewUrl();
  const [elapsed, setElapsed] = React.useState(() => voiceRecordingSession.durationMs());

  React.useEffect(() => {
    if (session.phase === "idle") return;
    let frame = 0;

    const tick = () => {
      setElapsed(voiceRecordingSession.durationMs());
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [session.phase, session.startedAt]);

  const handleSend = async () => {
    try {
      await voiceRecordingSession.submit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "couldn't finish voice note");
    }
  };

  const handleCancel = async () => {
    await voiceRecordingSession.cancel();
  };

  if (session.phase === "idle") return null;
  const canSend = session.phase === "recording" || session.phase === "paused";
  const canCancel = session.phase !== "stopping";

  return (
    <div className="flex items-center gap-3 border border-input bg-card px-3 py-2">
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void handleCancel()}
        disabled={!canCancel}
        aria-label="discard recording"
        className="text-destructive hover:bg-destructive/10"
      >
        <Trash />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <span className="flex items-center gap-1.5 label-mono text-xs">
          <span className={cn(
            "inline-block h-2 w-2 bg-foreground",
            session.phase === "recording" && "animate-pulse",
          )} />
          {session.phase === "requesting" ? "starting…" : formatElapsed(elapsed)}
        </span>
        {session.phase === "paused" ? (
          <SiliconAudio
            url={previewUrl}
            peaks={waveform}
            durationMs={elapsed}
            className="min-w-0 flex-1"
          />
        ) : (
          <VoiceWaveform
            samples={waveform}
            className="h-7 min-w-0 flex-1 text-foreground/70"
          />
        )}
      </div>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => {
          if (session.phase === "paused") voiceRecordingSession.resume();
          else voiceRecordingSession.pause();
        }}
        disabled={session.phase !== "recording" && session.phase !== "paused"}
        aria-label={session.phase === "paused" ? "continue recording" : "pause recording"}
        title={session.phase === "paused" ? "continue recording" : "pause recording"}
      >
        {session.phase === "paused" ? <Microphone /> : <Pause />}
      </Button>
      <Button
        size="icon"
        onClick={() => void handleSend()}
        disabled={!canSend}
        aria-label="send recording"
      >
        <PaperPlaneRight />
      </Button>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
