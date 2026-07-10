"use client";

import * as React from "react";
import { PaperPlaneRight, Trash } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import {
  useVoiceRecordingSession,
  voiceRecordingSession,
} from "@/lib/voice-recording-session";
import { Button } from "@/components/ui/button";

/**
 * Controls for the browser-tab-wide voice recording session.
 *
 * MediaRecorder itself lives in `voice-recording-session.ts`, outside the
 * keyed RoomView tree. This component can therefore unmount while another chat
 * is open and remount later without interrupting the recording.
 */
export function VoiceRecorder() {
  const session = useVoiceRecordingSession();
  const [elapsed, setElapsed] = React.useState(0);
  const wavesContainerRef = React.useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = React.useState(48);
  const [waves, setWaves] = React.useState<number[]>(() => new Array(48).fill(0));

  React.useEffect(() => {
    const element = wavesContainerRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || 200;
      setBarCount(Math.max(24, Math.floor(width / 5)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (session.phase === "idle") return;
    let frame = 0;
    let lastSampleAt = 0;
    const sampleEveryMs = 50;

    const tick = (now: number) => {
      setElapsed(session.startedAt ? Math.max(0, Date.now() - session.startedAt) : 0);
      if (now - lastSampleAt >= sampleEveryMs) {
        lastSampleAt = now;
        const measured = voiceRecordingSession.getLevel();
        const idleFloor = 0.06 + 0.04 * Math.abs(Math.sin(now / 350));
        const amplitude = Math.max(idleFloor, measured);
        setWaves((previous) => {
          const fitted =
            previous.length >= barCount
              ? previous.slice(previous.length - barCount + 1)
              : [...new Array(Math.max(0, barCount - previous.length - 1)).fill(0), ...previous];
          fitted.push(amplitude);
          return fitted.slice(-barCount);
        });
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [barCount, session.phase, session.startedAt]);

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
  const canSend = session.phase === "recording";
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
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex items-center gap-1.5 label-mono text-xs">
          <span className="inline-block h-2 w-2 animate-pulse bg-foreground" />
          {session.phase === "requesting" ? "starting…" : formatElapsed(elapsed)}
        </span>
        <div ref={wavesContainerRef} className="flex h-7 flex-1 items-center gap-[2px]">
          {waves.map((value, index) => (
            <span
              key={index}
              className="inline-block w-[3px] bg-foreground/70"
              style={{ height: `${Math.max(3, value * 100)}%` }}
            />
          ))}
        </div>
      </div>
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
