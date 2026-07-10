"use client";

import * as React from "react";
import {
  ArrowsOutSimple,
  Pause,
  PictureInPicture,
  Play,
  SpeakerHigh,
  SpeakerSlash,
} from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

import { pauseOtherMedia, registerMediaPauser } from "./media-playback";

const RATES = [1, 1.25, 1.5, 2] as const;

export function CustomVideoPlayer({
  url,
  autoPlay = false,
  className,
}: {
  url: string;
  autoPlay?: boolean;
  className?: string;
}) {
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const pauseSelfRef = React.useRef<() => void>(() => {});
  const [playing, setPlaying] = React.useState(false);
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [rate, setRate] = React.useState<(typeof RATES)[number]>(1);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    const pause = () => {
      videoRef.current?.pause();
      setPlaying(false);
    };
    pauseSelfRef.current = pause;
    return registerMediaPauser(pause);
  }, []);

  React.useEffect(() => {
    if (!autoPlay) return;
    const video = videoRef.current;
    if (!video) return;
    pauseOtherMedia(pauseSelfRef.current);
    void video.play().catch(() => undefined);
  }, [autoPlay, url]);

  const toggle = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    pauseOtherMedia(pauseSelfRef.current);
    await video.play().catch(() => undefined);
  };

  const seek = (value: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime = value;
    setCurrent(value);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !muted;
    video.muted = next;
    setMuted(next);
  };

  const changeVolume = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    setVolume(value);
    setMuted(value === 0);
  };

  const cycleRate = () => {
    const video = videoRef.current;
    if (!video) return;
    const index = RATES.indexOf(rate);
    const next = RATES[(index + 1) % RATES.length];
    video.playbackRate = next;
    setRate(next);
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    } else {
      await frameRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  const togglePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video || !("pictureInPictureEnabled" in document)) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    } catch {
      // PiP availability can change with browser policy or media readiness.
    }
  };

  return (
    <div
      ref={frameRef}
      className={cn("group/player relative isolate overflow-hidden bg-black text-white", className)}
    >
      <video
        ref={videoRef}
        src={url}
        playsInline
        preload="metadata"
        className="h-full w-full object-contain"
        onLoadStart={() => {
          setError(false);
          setCurrent(0);
          setDuration(0);
        }}
        onClick={toggle}
        onPlay={() => {
          pauseOtherMedia(pauseSelfRef.current);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime || 0)}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          setDuration(Number.isFinite(seconds) ? seconds : 0);
        }}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onError={() => setError(true)}
      />

      {error ? (
        <div className="absolute inset-0 grid place-items-center bg-black/80 p-4 text-center text-xs">
          this video can&apos;t be played in the browser
        </div>
      ) : null}

      {!playing && !error ? (
        <button
          type="button"
          onClick={toggle}
          aria-label="play video"
          className="absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center bg-black/70 transition-transform hover:scale-105"
        >
          <Play weight="fill" className="size-6" />
        </button>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-2 pb-2 pt-8 opacity-100 transition-opacity md:opacity-0 md:group-hover/player:opacity-100 md:group-focus-within/player:opacity-100">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step="0.05"
            value={Math.min(current, duration || 0)}
            disabled={!duration}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="video position"
            className="min-w-0 flex-1 accent-white"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            {formatSeconds(current)} / {formatSeconds(duration)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ControlButton label={playing ? "pause video" : "play video"} onClick={toggle}>
            {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
          </ControlButton>
          <ControlButton label={muted ? "unmute video" : "mute video"} onClick={toggleMute}>
            {muted ? <SpeakerSlash /> : <SpeakerHigh />}
          </ControlButton>
          <input
            type="range"
            min={0}
            max={1}
            step="0.05"
            value={muted ? 0 : volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
            aria-label="video volume"
            className="h-7 min-w-10 flex-1 accent-white sm:max-w-24"
          />
          <button
            type="button"
            onClick={cycleRate}
            aria-label={`playback speed ${rate}x`}
            className="h-7 min-w-10 px-1 font-mono text-[10px] hover:bg-white/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white"
          >
            {rate}x
          </button>
          <ControlButton label="picture in picture" onClick={togglePictureInPicture}>
            <PictureInPicture />
          </ControlButton>
          <ControlButton label="fullscreen" onClick={toggleFullscreen}>
            <ArrowsOutSimple />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void | Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid size-7 shrink-0 place-items-center hover:bg-white/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function formatSeconds(value: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
