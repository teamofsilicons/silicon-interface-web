"use client";

/* eslint-disable @next/next/no-img-element -- authenticated presigned/GIPHY media */

import * as React from "react";
import {
  CircleNotch,
  DownloadSimple,
  Play,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import {
  getCachedMedia,
  getLocalMediaPreview,
  refreshMediaDetail,
  subscribeMediaDetail,
} from "@/lib/media-cache";
import { isGifMedia } from "@/lib/media-meta";
import { usePdfThumbnail } from "@/lib/pdf-thumb";
import { isTextLike, useTextSnippetState } from "@/lib/text-preview";
import { languageForFile } from "@/lib/programmatic-files";
import type { AnnotationDraft, MediaObject } from "@/lib/types";
import { cn } from "@/lib/utils";

import { AttachmentCard } from "./attachment-card";
import { fileGlyph, isPreviewable } from "./file-icon";
import { MediaPreviewer, downloadAsset, type AnnotationOpenRequest } from "./media-previewer";
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
  filename: filenameProp,
  showCaption = true,
  localUrl,
  localDurationMs,
  localPeaks,
  initialStatus,
  width,
  height,
  replyToEventId,
  roomId,
  eventId,
  onAttachAnnotations,
  onOpenAnnotation,
  presentation = "timeline",
}: {
  mediaId: string;
  mime?: string;
  caption?: string;
  /** Pixel dimensions from the event (media_meta) — used to reserve the exact
   *  bubble aspect from the FIRST render so the timeline never shifts when the
   *  image/video actually loads. Falls back to the fetched media dims. */
  width?: number | null;
  height?: number | null;
  /** The attachment's real filename, kept separate from `caption` (the typed
   *  message text). Used as the label on file/PDF chips and downloads. Legacy
   *  messages omit it — there we fall back to `caption`. */
  filename?: string;
  /** When false, the caption isn't rendered here — the bubble shows it as a
   *  normal message line instead (so image+text reads like a message). */
  showCaption?: boolean;
  /** Local or trusted remote URL for optimistic media before the server ack. */
  localUrl?: string | null;
  localDurationMs?: number | null;
  localPeaks?: number[] | null;
  /** Event-time processing state. Media detail polling remains authoritative. */
  initialStatus?: MediaObject["status"];
  replyToEventId?: string;
  /** Room and source identifiers enable annotation for image/PDF previews. */
  roomId?: string;
  eventId?: string;
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
  onOpenAnnotation?: (request: AnnotationOpenRequest) => void;
  /** Profile shared-content layouts use the same loader/preview behavior with
   * container-sized cards instead of timeline bubble caps. */
  presentation?: "timeline" | "profile-media" | "profile-file" | "profile-voice";
}) {
  // Seed from the session cache so a re-mounted (scrolled-back-to) attachment
  // paints instantly with the right dimensions — no spinner, no aspect snap.
  const seeded = localUrl ? null : getCachedMedia(mediaId);
  const retainedLocalUrl = localUrl ?? getLocalMediaPreview(mediaId);
  const [url, setUrl] = React.useState<string | null>(
    retainedLocalUrl ?? seeded?.download_url ?? null,
  );
  const [media, setMedia] = React.useState<MediaObject | null>(
    retainedLocalUrl
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
      : (seeded?.media ?? null),
  );
  const [failed, setFailed] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [assetLoaded, setAssetLoaded] = React.useState(false);
  // A late metadata refresh is allowed to improve a rendered preview, never
  // to replace one that already worked with a transient "unavailable" card.
  const hasSuccessfulPreviewRef = React.useRef(
    Boolean(retainedLocalUrl ?? seeded?.download_url),
  );

  // Mini first-page preview for PDF attachments. Declared at the top (before the
  // status/loading early returns) to keep the Hook order stable.
  const isPdfAttachment =
    (mime || "").toLowerCase().includes("pdf") ||
    (filenameProp || "").toLowerCase().endsWith(".pdf");
  const pdfThumb = usePdfThumbnail(isPdfAttachment ? url : null, mediaId, isPdfAttachment);
  // Content peek for text/markdown/code attachments (only matters for the file
  // card; images/video/audio render their own rich inline preview).
  const textLikeAttachment = isTextLike(filenameProp, mime);
  const textPeek = useTextSnippetState(
    textLikeAttachment ? url : null,
    mediaId,
    textLikeAttachment,
  );

  const [pollExhausted, setPollExhausted] = React.useState(false);

  const retriedRef = React.useRef(false);
  React.useEffect(() => {
    let alive = true;
    queueMicrotask(() => {
      if (alive) setAssetLoaded(false);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  React.useEffect(() => {
    let alive = true;
    const immediateUrl = localUrl ?? getLocalMediaPreview(mediaId);
    if (immediateUrl) {
      queueMicrotask(() => {
        if (!alive) return;
        setFailed(false);
        setPollExhausted(false);
        setUrl(immediateUrl);
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
      });
    }
    if (!mediaId) {
      return () => {
        alive = false;
      };
    }
    retriedRef.current = false;
    queueMicrotask(() => {
      if (!alive) {
        return;
      }
      setFailed(false);
      setPollExhausted(false);
    });
    const unsubscribe = subscribeMediaDetail(
      mediaId,
      () => api.mediaDetail(mediaId),
      (state) => {
        if (!alive) return;
        const value = state.value;
        if (value) {
          setMedia(value.media);
          // Never erase bytes this sender already has locally while the
          // durable object-store capability is resolving.
          if (value.download_url) setUrl(value.download_url);
          else if (!immediateUrl) setUrl(null);
          if (value.download_url) hasSuccessfulPreviewRef.current = true;
        }
        setPollExhausted(state.exhausted);
        if (!hasSuccessfulPreviewRef.current) setFailed(state.failed);
      },
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [mediaId, localUrl, localDurationMs, localPeaks, mime]);

  // Self-heal a stale/expired presigned URL: re-fetch a fresh one once if the
  // asset fails to load (S3 "Request has expired" after a very long session).
  const refreshUrl = React.useCallback(() => {
    if (localUrl || !mediaId) return;
    if (retriedRef.current) return;
    retriedRef.current = true;
    refreshMediaDetail(mediaId, () => api.mediaDetail(mediaId))
      .then((r) => {
        if (r?.download_url) setUrl(r.download_url);
        else setFailed(true);
      })
      .catch(() => undefined);
  }, [mediaId, localUrl]);

  const m = (mime || media?.mime || "").toLowerCase();
  const isImage = m.startsWith("image/") || media?.kind === "image";
  const isGif = isGifMedia(m, filenameProp || caption);
  const isVideo = m.startsWith("video/");
  const isAudio = m.startsWith("audio/") || media?.kind === "voice" || media?.kind === "tts_output";
  const isDev = !!url && (url.includes("dev-download.local") || url.includes("dev-upload.local"));
  const gifFrameRef = React.useRef<HTMLDivElement>(null);
  const [gifInRenderRange, setGifInRenderRange] = React.useState(false);
  React.useEffect(() => {
    if (!isGif) return;
    const element = gifFrameRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setGifInRenderRange(true));
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setGifInRenderRange(entry.isIntersecting),
      { rootMargin: "320px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isGif, url]);

  // Decide the placeholder shape *before* the URL is known, so the bubble
  // doesn't visibly snap to size when the image actually arrives.
  const probablyVisual =
    (mime || "").toLowerCase().startsWith("image/") ||
    (mime || "").toLowerCase().startsWith("video/");

  // Authoritative dimensions: prefer the event's media_meta (known from the
  // very first render) over the lazily-fetched media object, so the reserved
  // aspect is correct before any pixels load — the timeline never shifts.
  const knownW = width ?? media?.width ?? null;
  const knownH = height ?? media?.height ?? null;
  const aspectFrom = (fallback: string) =>
    knownW && knownH && knownW > 0 && knownH > 0 ? `${knownW} / ${knownH}` : fallback;

  if (failed) return <span className="text-xs text-destructive">attachment unavailable</span>;

  // Branch on processing failure before trying to render. A failed object has
  // no download URL, so rendering it as normal media would spin forever.
  const effectiveStatus = media?.status ?? initialStatus;

  if (effectiveStatus === "failed") {
    return (
      <div className="inline-flex items-center gap-2 border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive">
        <WarningCircle className="h-4 w-4 shrink-0" weight="fill" />
        <span>attachment failed to process</span>
      </div>
    );
  }

  if (!url) {
    // §6.2 — Distinguish a still-generating TTS render ("pending", null URL)
    // from a generic load. For audio we show a live "generating audio…" label
    // over the waveform so the user knows it's working, not stuck; the poll in
    // the fetch effect refreshes us once the server flips it to "ready".
    const isPendingTts =
      effectiveStatus === "pending" &&
      (media?.kind === "tts_output" || (mime || "").toLowerCase().startsWith("audio/"));
    if (isPendingTts) {
      return (
        <div className="flex w-full max-w-[20rem] flex-col gap-1">
          <SiliconAudio
            url={null}
            peaks={media?.peaks ?? null}
            durationMs={media?.duration_ms ?? null}
            className="w-full"
          />
          <span className="inline-flex items-center gap-1 label-mono text-[10px] text-muted-foreground">
            {pollExhausted ? (
              <>This is taking longer than usual…</>
            ) : (
              <>
                <CircleNotch className="h-3 w-3 animate-spin" /> Preparing audio…
              </>
            )}
          </span>
        </div>
      );
    }
    if (probablyVisual) {
      // #22 — Reserve the *exact* aspect from media.width/height so loading
      // never reflows the bubble.
      const aspect = aspectFrom("4 / 3");
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
        <div className="relative w-full" aria-busy="true">
          <SiliconAudio
            url={null}
            peaks={media?.peaks ?? null}
            durationMs={media?.duration_ms ?? null}
            className={cn(
              "w-full opacity-45",
              presentation === "profile-voice" ? "max-w-none" : "max-w-[20rem]",
            )}
          />
          <CircleNotch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin" />
        </div>
      );
    }
    // A file/pdf/zip whose URL hasn't resolved yet: render the SAME fixed-size
    // card we'll show once it loads (no "loading…" text, no size snap). The
    // glyph + filename need no URL; the thumbnail/preview fills in or the click
    // fetches the URL on demand.
    return (
      <AttachmentCard
        glyph={fileGlyph(filenameProp || caption || "", m)}
        filename={filenameProp?.trim() || caption?.trim() || "file"}
        loading
        className={presentation === "profile-file" ? "w-full shadow-none" : undefined}
        textPreviewFormat={
          languageForFile(filenameProp || caption, m)?.id === "csv" ? "csv" : "plain"
        }
        textPreviewLoading={languageForFile(filenameProp || caption, m)?.id === "csv"}
      />
    );
  }

  // Filename / label used by both the preview header and the download. Prefer
  // the explicit filename; fall back to the caption for legacy messages that
  // stored the name there.
  const filename = filenameProp?.trim() || caption?.trim() || media?.kind || "file";

  // Image — clickable thumbnail in a fixed-aspect frame so the bubble
  // doesn't reflow when the actual pixels arrive over the network. When the
  // server knows the real dimensions (#22), we use the actual aspect ratio
  // instead of the 4/3 fallback — zero layout shift.
  if (isImage && !isDev) {
    const imgAspect = aspectFrom("4 / 3");
    return (
      <>
        <figure className="space-y-1">
          <div
            ref={gifFrameRef}
            role="button"
            tabIndex={0}
            onClick={() => setPreviewOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setPreviewOpen(true);
            }}
            aria-label="preview image"
            className={cn(
              "group relative max-w-full cursor-pointer overflow-hidden bg-card",
              presentation === "profile-media" ? "w-full" : "w-72",
            )}
            style={{
              aspectRatio: imgAspect,
              contain: "layout paint",
            }}
          >
            {/* `absolute inset-0` sizes the image from the aspect box rather
                than a percentage height — Safari fails to resolve `h-full`
                inside an aspect-ratio box, which let tall images render at
                natural size and spill out below the bubble. */}
            {(!isGif || gifInRenderRange) && (
              <img
                src={url}
                alt={caption || ""}
                draggable={false}
                loading="lazy"
                decoding="async"
                fetchPriority={isGif ? "low" : "auto"}
                onLoad={() => setAssetLoaded(true)}
                onError={() => {
                  setAssetLoaded(false);
                  refreshUrl();
                }}
                className="sdr-media absolute inset-0 h-full w-full select-none object-contain transition-opacity hover:opacity-90"
              />
            )}
            {!assetLoaded ? (
              <div
                className="pointer-events-none absolute inset-0 grid place-items-center bg-background/55"
                role="status"
                aria-label={isGif ? "loading GIF" : "loading attachment"}
              >
                <CircleNotch className="h-5 w-5 animate-spin" />
              </div>
            ) : null}
            {!isGif && (
              <DownloadOverlay onClick={() => downloadAsset(url, filename, { mediaId })} />
            )}
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
          replyToEventId={replyToEventId}
          roomId={roomId}
          sourceMediaId={mediaId}
          sourceEventId={eventId}
          onAttachAnnotations={onAttachAnnotations}
          onOpenAnnotation={onOpenAnnotation}
        />
      </>
    );
  }

  // Video — the timeline is a lightweight preview. Clicking anywhere opens
  // the dialog, where the actual Video.js player owns playback and controls.
  if (isVideo && !isDev) {
    const vidAspect = aspectFrom("16 / 9");
    return (
      <>
        <div
          className={cn(
            "group relative max-w-full overflow-hidden bg-card",
            presentation === "profile-media" ? "w-full" : "w-72",
          )}
          style={{ aspectRatio: vidAspect }}
        >
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            draggable={false}
            onLoadedData={() => setAssetLoaded(true)}
            onError={() => {
              setAssetLoaded(false);
              refreshUrl();
            }}
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          />
          {!assetLoaded ? (
            <div
              className="pointer-events-none absolute inset-0 grid place-items-center bg-background/55"
              role="status"
              aria-label="loading attachment"
            >
              <CircleNotch className="h-5 w-5 animate-spin" />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            aria-label="open video player"
            className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
          >
            <span className="pointer-events-none absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 place-items-center border border-white/80 bg-black/70 text-white">
              <Play weight="fill" className="size-6" />
            </span>
          </button>
          <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <IconChip
              onClick={() => downloadAsset(url, filename, { mediaId })}
              label="download"
            >
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
          replyToEventId={replyToEventId}
          roomId={roomId}
          sourceMediaId={mediaId}
          sourceEventId={eventId}
          onAttachAnnotations={onAttachAnnotations}
          onOpenAnnotation={onOpenAnnotation}
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
        className={cn(
          "w-full",
          presentation === "profile-voice" ? "max-w-none" : "max-w-[20rem]",
        )}
      />
    );
  }

  // Everything else (PDF, markdown/text, archives, docs, unknown types) — the
  // SAME card used for attachment pins, so standalone files look consistent.
  // Previewable types open the in-place previewer; the rest download directly.
  const Glyph = fileGlyph(filename, m);
  const sizeLabel = media?.size ? formatBytes(media.size) : null;
  const canPreview = !isDev && isPreviewable(filename, m);
  return (
    <>
      <AttachmentCard
        glyph={Glyph}
        filename={filename}
        thumbnailUrl={pdfThumb}
        textPreview={textPeek.text}
        textPreviewFormat={attachmentTextPreviewFormat(filename, m)}
        textPreviewLoading={textPeek.loading}
        sizeLabel={sizeLabel}
        className={presentation === "profile-file" ? "w-full shadow-none" : undefined}
        onClick={() => {
          if (canPreview) setPreviewOpen(true);
          else if (url) downloadAsset(url, filename, { mediaId });
        }}
      />
      {canPreview && (
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={url}
          mime={m}
          filename={filename}
          replyToEventId={replyToEventId}
          roomId={roomId}
          sourceMediaId={mediaId}
          sourceEventId={eventId}
          onAttachAnnotations={onAttachAnnotations}
          onOpenAnnotation={onOpenAnnotation}
        />
      )}
    </>
  );
}

function attachmentTextPreviewFormat(
  filename?: string | null,
  mime?: string | null,
): "plain" | "markdown" | "csv" {
  const language = languageForFile(filename, mime)?.id;
  if (language === "markdown") return "markdown";
  if (language === "csv") return "csv";
  return "plain";
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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
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
