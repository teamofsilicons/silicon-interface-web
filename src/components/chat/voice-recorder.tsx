"use client";

import * as React from "react";
import { PaperPlaneRight, Trash } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/sounds";

interface Props {
  /** Recording is "locked" the moment the icon is clicked — there is no
   *  hold-to-talk. Active = the recorder bar replaces the composer body. */
  active: boolean;
  /** Cancel / discard the recording. */
  onCancel: () => void;
  /** Recording finalized — the parent should upload + send as `m.voice`. */
  onSubmit: (blob: Blob, durationMs: number) => void;
}

// Use whichever WebM/Opus mime the browser supports; fall back to default.
function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

/**
 * Telegram-style locked voice recorder.
 *
 * The icon in the composer flips this on. We immediately request mic access,
 * start a MediaRecorder, and replace the composer body with a recording bar:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ 🗑  ● 00:42  ▁▂▄▆▇▆▄▂▁                  ➤    │
 *   └──────────────────────────────────────────────┘
 *
 * Cancel discards the captured audio. Send finalizes, hands the blob up to
 * the composer to upload + post as an `m.voice` event. The recording does
 * not stop on focus changes — only on user action.
 */
export function VoiceRecorder({ active, onCancel, onSubmit }: Props) {
  const recRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<BlobPart[]>([]);
  const startedAtRef = React.useRef<number>(0);
  const intentRef = React.useRef<"send" | "cancel">("cancel");
  const [elapsed, setElapsed] = React.useState(0);
  const [armed, setArmed] = React.useState(false);

  // Wave bars — purely cosmetic, sampled in real time from an AnalyserNode.
  // Bar count grows with the container's actual width so the waveform spans
  // the whole remaining strip instead of clustering on the left.
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const wavesContainerRef = React.useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = React.useState(48);
  const [waves, setWaves] = React.useState<number[]>(() => new Array(48).fill(0));

  const cleanup = React.useCallback(() => {
    try {
      recRef.current?.state === "recording" && recRef.current.stop();
    } catch {
      /* recorder may already be inactive */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => undefined);
    recRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    chunksRef.current = [];
    setElapsed(0);
    setArmed(false);
    setWaves((w) => w.map(() => 0));
  }, []);

  // Start / stop with the `active` flag.
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    intentRef.current = "cancel";

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const mime = pickMime();
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recRef.current = rec;
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          const duration = Date.now() - startedAtRef.current;
          const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
          // Only forward the recording up if the user pressed send; cancel
          // throws everything away (most of the surprise privacy bug in
          // recorders comes from emitting on every stop, intentful or not).
          if (intentRef.current === "send" && blob.size > 0) {
            onSubmit(blob, duration);
          }
          cleanup();
        };
        startedAtRef.current = Date.now();
        rec.start(200); // 200ms timeslice — even pacing for the level meter
        vibrate(8); // §3c — feather-light haptic on record start
        setArmed(true);

        // Live level meter. fftSize 2048 gives 2048 time-domain samples per
        // read — plenty of headroom for the rolling RMS used to drive the bars.
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        src.connect(an);
        audioCtxRef.current = ctx;
        analyserRef.current = an;
      } catch (err) {
        toast.error(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "microphone permission denied"
            : "couldn't start recorder",
        );
        cleanup();
        onCancel();
      }
    })();

    return () => {
      cancelled = true;
      // §6.5 — Actually tear the recorder down on unmount. Previously this
      // only flipped `cancelled`, so switching rooms mid-record left the
      // MediaStream open (OS mic indicator stuck on) and the recorder alive.
      // We set the intent to "cancel" first so the `onstop` handler doesn't
      // emit a half-finished blob, then stop the stream + close the context.
      intentRef.current = "cancel";
      cleanup();
    };
    // onSubmit/onCancel/cleanup are stable for the lifetime of this hook
    // invocation — re-running on every render would tear down the recorder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Resize observer: keep bar count proportional to the available width.
  // Each bar gets ~5px of horizontal real estate (3px bar + 2px gap), so we
  // divide and clamp to a sensible minimum.
  React.useEffect(() => {
    const el = wavesContainerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || 200;
      setBarCount(Math.max(24, Math.floor(w / 5)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Timer + waveform tick. We use time-domain data (an oscilloscope-style
  // signal in [0,255] around 128) and compute a single RMS amplitude per
  // sample, then *roll* the wave array: the newest amplitude becomes the
  // rightmost bar and everything older scrolls one step left. This is what
  // makes every bar react to incoming sound — the previous approach split
  // a tiny frequency-bin buffer across the bars, leaving everything past
  // the buffer length stuck at zero.
  React.useEffect(() => {
    if (!armed) return;
    let raf = 0;
    let lastSampleAt = 0;
    const SAMPLE_MS = 50; // 20 samples/sec — smooth without overdrawing.
    const loop = (now: number) => {
      setElapsed(Date.now() - startedAtRef.current);
      const an = analyserRef.current;
      if (an && now - lastSampleAt >= SAMPLE_MS) {
        lastSampleAt = now;
        const buf = new Uint8Array(an.fftSize);
        an.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128; // → [-1, 1]
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        // Boost so quiet speech still moves the bars; cap at 1. Add a tiny
        // breathing floor (a slow sine on the sample clock) so a silent mic
        // still scrolls a faint ripple instead of looking frozen/flatlined.
        const idleFloor = 0.06 + 0.04 * Math.abs(Math.sin(now / 350));
        const amp = Math.min(1, Math.max(idleFloor, rms * 4));
        setWaves((prev) => {
          // Keep length === barCount: drop the oldest, push the newest.
          const next =
            prev.length >= barCount
              ? prev.slice(prev.length - barCount + 1)
              : [...new Array(barCount - prev.length - 1).fill(0), ...prev];
          next.push(amp);
          return next;
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [armed, barCount]);

  // When the strip resizes mid-recording, reshape the waves array so the
  // newest samples stay anchored to the right edge.
  React.useEffect(() => {
    setWaves((prev) => {
      if (prev.length === barCount) return prev;
      if (prev.length > barCount) return prev.slice(prev.length - barCount);
      return [...new Array(barCount - prev.length).fill(0), ...prev];
    });
  }, [barCount]);

  const handleSend = () => {
    intentRef.current = "send";
    try {
      recRef.current?.stop();
    } catch {
      cleanup();
    }
  };

  const handleCancel = () => {
    intentRef.current = "cancel";
    try {
      recRef.current?.stop();
    } catch {
      /* nothing to stop */
    }
    onCancel();
  };

  if (!active) return null;

  return (
    <div className="flex items-center gap-3 border border-input bg-card px-3 py-2">
      <Button
        size="icon"
        variant="ghost"
        onClick={handleCancel}
        aria-label="discard recording"
        className="text-destructive hover:bg-destructive/10"
      >
        <Trash />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex items-center gap-1.5 label-mono text-xs">
          <span className="inline-block h-2 w-2 animate-pulse bg-foreground" />
          {formatElapsed(elapsed)}
        </span>
        <div
          ref={wavesContainerRef}
          className="flex h-7 flex-1 items-center gap-[2px]"
        >
          {waves.map((v, i) => (
            <span
              key={i}
              className={cn("inline-block w-[3px] bg-foreground/70")}
              style={{ height: `${Math.max(3, v * 100)}%` }}
            />
          ))}
        </div>
      </div>
      <Button
        size="icon"
        onClick={handleSend}
        aria-label="send recording"
      >
        <PaperPlaneRight />
      </Button>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
