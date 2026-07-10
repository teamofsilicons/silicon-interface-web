"use client";

import * as React from "react";
import { Pause, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

import { pauseOtherMedia, registerMediaPauser } from "./media-playback";

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

interface Props {
  /** Presigned/permanent URL. May be null while still loading. */
  url: string | null;
  /** Pre-computed peaks (0..1). When absent, the bars fall back to a flat
   *  line; once playback decodes, they stay flat (we trust server peaks for
   *  consistency between sender + receiver). */
  peaks?: number[] | null;
  /** Duration in ms — server-known, so the timer renders before audio loads. */
  durationMs?: number | null;
  autoPlay?: boolean;
  className?: string;
}

/**
 * Silicon-style audio bubble — same waveform language as the recorder.
 *
 *   ┌────────────────────────────────────────────┐
 *   │ ▶  ▁▂▄▆▇▆▄▂▁▂▄▆▇▆▄▂▁▂▄▆▇▆▄▂  00:42 / 01:24 │
 *   └────────────────────────────────────────────┘
 *
 * We render server-computed peaks immediately (so the bars exist before
 * audio decodes), then progress recolors them in step with playback.
 */
export function SiliconAudio({ url, peaks, durationMs, autoPlay = false, className }: Props) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [currentMs, setCurrentMs] = React.useState(0);
  const [internalDurMs, setInternalDurMs] = React.useState<number | null>(null);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [rate, setRate] = React.useState<(typeof PLAYBACK_RATES)[number]>(1);

  // Register this instance's "pause me" callback in the global registry so a
  // sibling player can pause us when it starts. Cleaned up on unmount.
  const pauseSelfRef = React.useRef<() => void>(() => {});
  React.useEffect(() => {
    const pause = () => {
      audioRef.current?.pause();
      setPlaying(false);
    };
    pauseSelfRef.current = pause;
    return registerMediaPauser(pause);
  }, []);

  const bars = React.useMemo(() => {
    const TARGET = 40; // a count that fits the compact player at any width
    const raw =
      peaks && peaks.length > 0
        ? peaks
        : // Synth a gentle wave so a missing peaks projection (older messages,
          // metadata fetch failed, etc.) still looks intentional rather than
          // empty. Static deterministic pattern.
          Array.from({ length: TARGET }, (_, i) =>
            0.25 + 0.5 * Math.abs(Math.sin(i * 0.6 + Math.cos(i * 0.13))),
          );
    if (raw.length <= TARGET) return raw;
    // Downsample to TARGET buckets (averaging) so the *entire* waveform is
    // always visible — flexible bars then fill the width exactly, no clipping.
    const out: number[] = [];
    const size = raw.length / TARGET;
    for (let i = 0; i < TARGET; i++) {
      const start = Math.floor(i * size);
      const end = Math.max(start + 1, Math.floor((i + 1) * size));
      let sum = 0;
      let n = 0;
      for (let j = start; j < end && j < raw.length; j++) {
        sum += raw[j];
        n += 1;
      }
      out.push(n ? sum / n : 0);
    }
    return out;
  }, [peaks]);

  const dur = durationMs ?? internalDurMs ?? 0;
  const progress = dur > 0 ? Math.min(1, currentMs / dur) : 0;

  React.useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrentMs(Math.round(a.currentTime * 1000));
    const onMeta = () => {
      if (!durationMs && a.duration && Number.isFinite(a.duration)) {
        setInternalDurMs(Math.round(a.duration * 1000));
      }
    };
    const onPlay = () => {
      pauseOtherMedia(pauseSelfRef.current);
      setPlaying(true);
    };
    const onPause = () => setPlaying(false);
    const onEnd = () => {
      setPlaying(false);
      setCurrentMs(0);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnd);
    };
  }, [durationMs, url]);

  React.useEffect(() => {
    if (!autoPlay || !url) return;
    const audio = audioRef.current;
    if (!audio) return;
    pauseOtherMedia(pauseSelfRef.current);
    void audio.play().catch(() => undefined);
  }, [autoPlay, url]);

  // Smooth progress: while playing, drive currentMs from rAF so the waveform
  // fill glides continuously instead of stepping on each ~250ms 'timeupdate'.
  React.useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setCurrentMs(Math.round(a.currentTime * 1000));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = async () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      // Pause any other voice note before we start so two never overlap.
      pauseOtherMedia(pauseSelfRef.current);
      try {
        await a.play();
        setPlaying(true);
      } catch {
        /* user gesture or codec issue — silently no-op */
      }
    }
  };

  const seekTo = (frac: number) => {
    const a = audioRef.current;
    if (!a || !dur) return;
    const t = Math.max(0, Math.min(dur, dur * frac));
    a.currentTime = t / 1000;
    setCurrentMs(t);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = !muted;
    audio.muted = next;
    setMuted(next);
  };

  const changeVolume = (next: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = next;
    audio.muted = next === 0;
    setVolume(next);
    setMuted(next === 0);
  };

  const cycleRate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const index = PLAYBACK_RATES.indexOf(rate);
    const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
    audio.playbackRate = next;
    setRate(next);
  };

  return (
    <div
      className={cn(
        // Borderless + transparent: the player inherits the bubble's theme via
        // currentColor (cream controls on a sent ink bubble, ink on a received
        // cream bubble), so a voice note reads like a normal message.
        "flex w-full items-center gap-2",
        className,
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "pause" : "play"}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center transition-opacity hover:opacity-70 [&_svg]:h-5 [&_svg]:w-5"
      >
        {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
      </button>
      <Waveform bars={bars} progress={progress} seekable={dur > 0} onSeek={seekTo} />
      <span className="shrink-0 label-mono text-[10px] opacity-60">
        {formatTime(currentMs)}/{formatTime(dur)}
      </span>
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "unmute audio" : "mute audio"}
        className="grid size-7 shrink-0 place-items-center opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current [&_svg]:size-4"
      >
        {muted ? <SpeakerSlash /> : <SpeakerHigh />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step="0.05"
        value={muted ? 0 : volume}
        onChange={(event) => changeVolume(Number(event.target.value))}
        aria-label="audio volume"
        className="hidden h-7 w-10 shrink-0 accent-current sm:block"
      />
      <button
        type="button"
        onClick={cycleRate}
        aria-label={`playback speed ${rate}x`}
        className="h-7 min-w-8 shrink-0 px-1 font-mono text-[9px] opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
      >
        {rate}x
      </button>
      {url && (
        // The actual playback element. preload=metadata so duration arrives
        // without paying the full bytes cost up front.
        <audio ref={audioRef} src={url} preload="metadata" />
      )}
    </div>
  );
}

function Waveform({
  bars,
  progress,
  seekable,
  onSeek,
}: {
  bars: number[];
  progress: number;
  /** Whether duration is known yet — when false, seeking is a no-op so we
   *  don't expose a focusable but dead control. */
  seekable: boolean;
  onSeek: (frac: number) => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || !seekable) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    onSeek(Math.max(0, Math.min(1, x / rect.width)));
  };
  // Keyboard scrubbing — the element already advertises role="slider", so it
  // must be operable without a mouse. ←/→ step 5%, ↑/↓ step 5%, Home/End jump
  // to the ends. We only handle keys once duration is known.
  const STEP = 0.05;
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!seekable) return;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = progress + STEP;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = progress - STEP;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    if (next === null) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(1, next)));
  };
  // Two identical bar rows stacked: a dim base, and a bright "played" copy
  // clipped to the exact progress fraction. Because both rows lay out the same
  // flexible bars, they align perfectly and the clip reveals the fill smoothly
  // (sub-bar precision) instead of flipping whole bars.
  const renderBars = (bright: boolean) => (
    <div className="flex h-full w-full items-center gap-[2px]">
      {bars.map((v, i) => (
        <span
          key={i}
          className={cn(
            // flex-1 + a 2px floor: every bar is visible and the whole set
            // fits the width without clipping or overflowing.
            "min-w-[2px] flex-1",
            bright ? "bg-current" : "bg-current opacity-30",
          )}
          style={{ height: `${Math.max(8, Math.round(v * 100))}%` }}
        />
      ))}
    </div>
  );
  return (
    <div
      ref={ref}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="slider"
      aria-label="audio scrubber"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={progress}
      aria-valuetext={`${Math.round(progress * 100)}%`}
      aria-disabled={!seekable}
      tabIndex={seekable ? 0 : -1}
      className={cn(
        "relative flex h-9 min-w-0 flex-1 items-center outline-none focus-visible:ring-1 focus-visible:ring-current",
        seekable ? "cursor-pointer" : "cursor-default",
      )}
    >
      {renderBars(false)}
      <div
        className="absolute inset-0 flex items-center"
        style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}
      >
        {renderBars(true)}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
