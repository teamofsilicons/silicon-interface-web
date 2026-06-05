"use client";

import * as React from "react";
import {
  ArrowsOutSimple,
  CircleNotch,
  DownloadSimple,
  File,
  FilePdf,
} from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import type { MediaObject } from "@/lib/types";
import { cn } from "@/lib/utils";

import { MediaPreviewer, downloadAsset } from "./media-previewer";
import { SiliconAudio } from "./silicon-audio";

/**
 * Renders an attachment inline (image/video/audio thumbnail / PDF chip / file
 * chip) and opens a fullscreen previewer on click for everything we can
 * render in-browser. Dev presigns (`dev-download.local`) skip the actual
 * fetch and just show a labelled chip.
 */
export function MediaAttachment({
  mediaId,
  mime,
  caption,
  showCaption = true,
  localUrl,
  localDurationMs,
  localPeaks,
}: {
  mediaId: string;
  mime?: string;
  caption?: string;
  /** When false, the caption isn't rendered here — the bubble shows it as a
   *  normal message line instead (so image+text reads like a message). */
  showCaption?: boolean;
  /** Local blob URL for optimistic voice/file renders before the server ack. */
  localUrl?: string | null;
  localDurationMs?: number | null;
  localPeaks?: number[] | null;
}) {
  const [url, setUrl] = React.useState<string | null>(localUrl ?? null);
  const [media, setMedia] = React.useState<MediaObject | null>(
    localUrl
      ? ({
          media_id: mediaId || "local",
          uploader_kind: "carbon",
          uploader_id: 0,
          mime: mime || "audio/webm",
          size: 0,
          sha256: "",
          status: "ready",
          kind: (mime || "").startsWith("audio/") ? "voice" : "file",
          transcript: "",
          duration_ms: localDurationMs ?? null,
          peaks: localPeaks ?? null,
          width: null,
          height: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as MediaObject)
      : null,
  );
  const [failed, setFailed] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  const retriedRef = React.useRef(false);
  React.useEffect(() => {
    if (localUrl) {
      setFailed(false);
      setUrl(localUrl);
      setMedia(
        {
          media_id: mediaId || "local",
          uploader_kind: "carbon",
          uploader_id: 0,
          mime: mime || "audio/webm",
          size: 0,
          sha256: "",
          status: "ready",
          kind: (mime || "").startsWith("audio/") ? "voice" : "file",
          transcript: "",
          duration_ms: localDurationMs ?? null,
          peaks: localPeaks ?? null,
          width: null,
          height: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as MediaObject,
      );
      return;
    }
    if (!mediaId) return;
    let alive = true;
    retriedRef.current = false;
    (async () => {
      try {
        const r = await api.mediaDetail(mediaId);
        if (!alive) return;
        setMedia(r.media);
        setUrl(r.download_url);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mediaId, localUrl, localDurationMs, localPeaks, mime]);

  // Self-heal a stale/expired presigned URL: re-fetch a fresh one once if the
  // asset fails to load (S3 "Request has expired" after a very long session).
  const refreshUrl = React.useCallback(() => {
    if (localUrl || !mediaId) return;
    if (retriedRef.current) return;
    retriedRef.current = true;
    api
      .mediaDetail(mediaId)
      .then((r) => setUrl(r.download_url))
      .catch(() => undefined);
  }, [mediaId, localUrl]);

  const m = (mime || media?.mime || "").toLowerCase();
  const isImage = m.startsWith("image/") || media?.kind === "image";
  const isVideo = m.startsWith("video/");
  const isAudio = m.startsWith("audio/") || media?.kind === "voice" || media?.kind === "tts_output";
  const isPdf = m.includes("pdf");
  const isDev = !!url && (url.includes("dev-download.local") || url.includes("dev-upload.local"));

  // Decide the placeholder shape *before* the URL is known, so the bubble
  // doesn't visibly snap to size when the image actually arrives.
  const probablyVisual =
    (mime || "").toLowerCase().startsWith("image/") ||
    (mime || "").toLowerCase().startsWith("video/");

  if (failed) return <span className="text-xs text-destructive">attachment unavailable</span>;
  if (!url) {
    if (probablyVisual) {
      // #22 — Reserve the *exact* aspect from media.width/height so loading
      // never reflows the bubble.
      const aspect =
        media?.width && media?.height && media.width > 0 && media.height > 0
          ? `${media.width} / ${media.height}`
          : "4 / 3";
      return (
        <div
          className="flex w-72 max-w-full items-center justify-center bg-card"
          style={{ aspectRatio: aspect }}
          aria-busy="true"
        >
          <CircleNotch className="h-4 w-4 animate-spin opacity-40" />
        </div>
      );
    }
    // Audio loading state — render the Silicon waveform placeholder so the
    // bars + timer exist before bytes arrive.
    if ((mime || "").toLowerCase().startsWith("audio/")) {
      return (
        <SiliconAudio
          url={null}
          peaks={media?.peaks ?? null}
          durationMs={media?.duration_ms ?? null}
          className="w-full max-w-[20rem]"
        />
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <CircleNotch className="h-3 w-3 animate-spin" /> loading…
      </span>
    );
  }

  // Filename / label used by both the preview header and the download.
  const filename = caption?.trim() || media?.kind || "file";

  // Image — clickable thumbnail in a fixed-aspect frame so the bubble
  // doesn't reflow when the actual pixels arrive over the network. When the
  // server knows the real dimensions (#22), we use the actual aspect ratio
  // instead of the 4/3 fallback — zero layout shift.
  if (isImage && !isDev) {
    const imgAspect =
      media?.width && media?.height && media.width > 0 && media.height > 0
        ? `${media.width} / ${media.height}`
        : "4 / 3";
    return (
      <>
        <figure className="space-y-1">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setPreviewOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setPreviewOpen(true);
            }}
            aria-label="preview image"
            className="group relative w-72 max-w-full cursor-pointer overflow-hidden bg-card"
            style={{ aspectRatio: imgAspect }}
          >
            {/* `absolute inset-0` sizes the image from the aspect box rather
                than a percentage height — Safari fails to resolve `h-full`
                inside an aspect-ratio box, which let tall images render at
                natural size and spill out below the bubble. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- presigned/public S3 */}
            <img
              src={url}
              alt={caption || ""}
              onError={refreshUrl}
              className="absolute inset-0 h-full w-full object-contain transition-opacity hover:opacity-90"
            />
            <DownloadOverlay onClick={() => downloadAsset(url, filename)} />
          </div>
          {showCaption && caption && (
            <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
          )}
        </figure>
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={url}
          mime={m}
          filename={filename}
        />
      </>
    );
  }

  // Video — same fixed-aspect-frame treatment so loading doesn't shift the
  // bubble; the inline player handles its own controls. Real dims (#22)
  // override the 16/9 fallback.
  if (isVideo && !isDev) {
    const vidAspect =
      media?.width && media?.height && media.width > 0 && media.height > 0
        ? `${media.width} / ${media.height}`
        : "16 / 9";
    return (
      <>
        <div
          className="group relative w-72 max-w-full overflow-hidden bg-card"
          style={{ aspectRatio: vidAspect }}
        >
          <video
            src={url}
            controls
            className="absolute inset-0 h-full w-full bg-black object-contain"
          />
          <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <IconChip onClick={() => setPreviewOpen(true)} label="expand">
              <ArrowsOutSimple />
            </IconChip>
            <IconChip onClick={() => downloadAsset(url, filename)} label="download">
              <DownloadSimple />
            </IconChip>
          </div>
        </div>
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={url}
          mime={m}
          filename={filename}
        />
      </>
    );
  }

  // Audio — Silicon-style waveform player. Uses server-computed peaks +
  // duration so the bars + timer render before the audio bytes download.
  if (isAudio && !isDev) {
    // No inline download — it's available from the message's options menu. Cap
    // the width so the player stays compact and never overflows narrow
    // containers like the profile drawer.
    return (
      <SiliconAudio
        url={url}
        peaks={media?.peaks ?? null}
        durationMs={media?.duration_ms ?? null}
        className="w-full max-w-[20rem]"
      />
    );
  }

  // PDF — a clean, clearly-clickable document card. Clicking opens the
  // fullscreen previewer; download lives in the message's options menu.
  if (isPdf && !isDev) {
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setPreviewOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setPreviewOpen(true);
          }}
          aria-label={`preview ${filename}`}
          className="group flex w-60 max-w-full cursor-pointer items-center gap-3 bg-card px-3 py-3 text-foreground transition-colors hover:bg-accent"
        >
          <FilePdf className="h-9 w-9 shrink-0" weight="light" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{filename}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {media?.size ? `${formatBytes(media.size)} · ` : ""}click to preview
            </div>
          </div>
          <ArrowsOutSimple className="h-4 w-4 shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
        </div>
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={url}
          mime={m}
          filename={filename}
        />
      </>
    );
  }

  // Fallback: file chip with download. Used for unknown types or any asset
  // served via a dev placeholder URL. Same `text-foreground` rationale as
  // the PDF chip — pin the ink color so the chip stays readable inside a
  // primary-colored "mine" bubble.
  return (
    <div className="inline-flex items-center gap-2 bg-card px-3 py-2 text-xs text-foreground">
      <File className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{filename}</span>
      {!isDev && (
        <IconChip onClick={() => downloadAsset(url, filename)} label="download">
          <DownloadSimple />
        </IconChip>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Hover-revealed download tag in the corner of an image. */
function DownloadOverlay({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="download"
      className={cn(
        "absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center border",
        "bg-background/80 text-foreground opacity-0 backdrop-blur-sm transition-opacity",
        "group-hover:opacity-100",
      )}
    >
      <DownloadSimple className="h-3.5 w-3.5" />
    </button>
  );
}

/** Small bordered icon button used in the video overlay and the file chip. */
function IconChip({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center border bg-background text-foreground transition-colors hover:bg-accent"
    >
      {children}
    </button>
  );
}
