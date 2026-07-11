"use client";

import * as React from "react";
import videojs from "video.js";
import type Player from "video.js/dist/types/player";

import { cn } from "@/lib/utils";

import { pauseOtherMedia, registerMediaPauser } from "./media-playback";

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];

function sourceType(url: string, mime?: string): string | undefined {
  const normalizedMime = mime?.split(";", 1)[0]?.trim().toLowerCase();
  // Chrome can decode H.264/AAC in a QuickTime container but reports
  // `video/quicktime` itself as unsupported. Advertising the ISO-BMFF source
  // as MP4 lets the browser inspect and play the compatible streams.
  if (normalizedMime === "video/quicktime") return "video/mp4";
  if (
    normalizedMime?.startsWith("video/") ||
    normalizedMime === "application/x-mpegurl" ||
    normalizedMime === "application/vnd.apple.mpegurl" ||
    normalizedMime === "application/dash+xml"
  ) return normalizedMime;
  let pathname = url.toLowerCase();
  try {
    pathname = new URL(url, window.location.href).pathname.toLowerCase();
  } catch {
    // Video.js can still inspect the source when the URL is non-standard.
  }
  if (pathname.endsWith(".m3u8")) return "application/x-mpegURL";
  if (pathname.endsWith(".mpd")) return "application/dash+xml";
  if (pathname.endsWith(".webm")) return "video/webm";
  if (pathname.endsWith(".ogv") || pathname.endsWith(".ogg")) return "video/ogg";
  if (pathname.endsWith(".mov")) return "video/mp4";
  if (pathname.endsWith(".mp4") || pathname.endsWith(".m4v")) return "video/mp4";
  return undefined;
}

export function CustomVideoPlayer({
  url,
  mime,
  autoPlay = false,
  className,
}: {
  url: string;
  mime?: string;
  autoPlay?: boolean;
  className?: string;
}) {
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const playerRef = React.useRef<Player | null>(null);
  const pauseSelfRef = React.useRef<() => void>(() => {});
  const visibleRef = React.useRef(true);
  const keyboardActiveRef = React.useRef(false);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount || playerRef.current) return;

    // Video.js owns this element. Creating it beneath the React-owned mount
    // keeps React Strict Mode from reconciling nodes that Video.js wraps.
    const videoElement = document.createElement("video-js");
    videoElement.classList.add("video-js", "vjs-big-play-centered");
    videoElement.setAttribute("aria-label", "video player");
    mount.appendChild(videoElement);

    const player = videojs(videoElement, {
      controls: true,
      responsive: true,
      fill: true,
      playsinline: true,
      preload: "metadata",
      autoplay: false,
      playbackRates: PLAYBACK_RATES,
      enableSmoothSeeking: true,
      notSupportedMessage: "this video can’t be played in the browser",
      userActions: { hotkeys: true },
    });
    playerRef.current = player;

    const pause = () => {
      if (!player.isDisposed()) player.pause();
    };
    pauseSelfRef.current = pause;
    const unregister = registerMediaPauser(pause);
    const coordinatePlayback = () => {
      keyboardActiveRef.current = true;
      pauseOtherMedia(pauseSelfRef.current);
    };
    player.on("play", coordinatePlayback);

    player.ready(() => {
      if (!autoPlay || player.isDisposed()) return;
      coordinatePlayback();
      void player.play()?.catch(() => undefined);
    });

    return () => {
      unregister();
      if (!player.isDisposed()) {
        player.off("play", coordinatePlayback);
        player.dispose();
      }
      playerRef.current = null;
      pauseSelfRef.current = () => {};
      keyboardActiveRef.current = false;
    };
    // Player creation/disposal belongs to the component lifetime. Source and
    // autoplay changes are applied by the effect below without rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const player = playerRef.current;
    if (!player || player.isDisposed()) return;
    player.autoplay(autoPlay ? "play" : false);
    keyboardActiveRef.current = false;
    player.src({ src: url, type: sourceType(url, mime) });
    if (autoPlay) {
      pauseOtherMedia(pauseSelfRef.current);
      void player.play()?.catch(() => undefined);
    } else {
      player.pause();
    }
  }, [autoPlay, mime, url]);

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.25);
      },
      { threshold: [0, 0.25, 1] },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const player = playerRef.current;
      const frame = frameRef.current;
      if (
        !player ||
        player.isDisposed() ||
        !visibleRef.current ||
        !keyboardActiveRef.current ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) return;
      const target = event.target;
      if (target instanceof Element && frame?.contains(target)) return;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;

      const key = event.key.toLowerCase();
      const current = Number(player.currentTime() ?? 0);
      const duration = Number(player.duration() ?? 0);
      const seek = (delta: number) => {
        const maximum = Number.isFinite(duration) && duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
        player.currentTime(Math.max(0, Math.min(maximum, current + delta)));
      };
      if (key === " " || key === "k") {
        event.preventDefault();
        if (player.paused()) void player.play()?.catch(() => undefined);
        else player.pause();
      } else if (key === "m") {
        event.preventDefault();
        player.muted(!player.muted());
      } else if (key === "f") {
        event.preventDefault();
        const fullscreen = player.isFullscreen()
          ? player.exitFullscreen()
          : player.requestFullscreen();
        void fullscreen.catch(() => undefined);
      } else if (key === "arrowleft") {
        event.preventDefault();
        seek(-5);
      } else if (key === "arrowright") {
        event.preventDefault();
        seek(5);
      } else if (key === "j") {
        event.preventDefault();
        seek(-10);
      } else if (key === "l") {
        event.preventDefault();
        seek(10);
      } else if (key === "arrowup" || key === "arrowdown") {
        event.preventDefault();
        const direction = key === "arrowup" ? 0.1 : -0.1;
        player.volume(Math.max(0, Math.min(1, Number(player.volume() ?? 1) + direction)));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={frameRef}
      className={cn("silicon-video-player relative isolate overflow-hidden bg-black", className)}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={mountRef} data-vjs-player className="h-full w-full" />
    </div>
  );
}
