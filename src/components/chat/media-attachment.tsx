"use client";

import * as React from "react";
import {
  ArrowsOutSimple,
  CircleNotch,
  DownloadSimple,
  ShieldWarning,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import { getCachedMedia, setCachedMedia } from "@/lib/media-cache";
import { usePdfThumbnail } from "@/lib/pdf-thumb";
import { isTextLike, useTextSnippet } from "@/lib/text-preview";
import type { MediaObject } from "@/lib/types";
import { cn } from "@/lib/utils";

import { AttachmentCard } from "./attachment-card";
import { fileGlyph, isPreviewable } from "./file-icon";
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
  filename: filenameProp,
  showCaption = true,
  localUrl,
  localDurationMs,
  localPeaks,
}: {
  mediaId: string;
  mime?: string;
  caption?: string;
  /** The attachment's real filename, kept separate from `caption` (the typed
   *  message text). Used as the label on file/PDF chips and downloads. Legacy
   *  messages omit it — there we fall back to `caption`. */
  filename?: string;
  /** When false, the caption isn't rendered here — the bubble shows it as a
   *  normal message line instead (so image+text reads like a message). */
  showCaption?: boolean;
  /** Local blob URL for optimistic voice/file renders before the server ack. */
  localUrl?: string | null;
  localDurationMs?: number | null;
  localPeaks?: number[] | null;
}) {
  // Seed from the session cache so a re-mounted (scrolled-back-to) attachment
  // paints instantly with the right dimensions — no spinner, no aspect snap.
  const seeded = localUrl ? null : getCachedMedia(mediaId);
  const [url, setUrl] = React.useState<string | null>(localUrl ?? seeded?.download_url ?? null);
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
      : (seeded?.media ?? null),
  );
  const [failed, setFailed] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  // Mini first-page preview for PDF attachments. Declared at the top (before the
  // status/loading early returns) to keep the Hook order stable.
  const isPdfAttachment =
    (mime || "").toLowerCase().includes("pdf") ||
    (filenameProp || "").toLowerCase().endsWith(".pdf");
  const pdfThumb = usePdfThumbnail(isPdfAttachment ? url : null, mediaId, isPdfAttachment);
  // Content peek for text/markdown/code attachments (only matters for the file
  // card; images/video/audio render their own rich inline preview).
  const textLikeAttachment = isTextLike(filenameProp, mime);
  const textPeek = useTextSnippet(textLikeAttachment ? url : null, mediaId, textLikeAttachment);

  // §6.2 — Pending media (e.g. an in-flight TTS render) reports `status:
  // "pending"` with a null `download_url`. Rather than show an inert
  // placeholder forever, we re-fetch on a bounded interval until the server
  // flips it to "ready" (or a terminal "infected"/"failed"). The attempt cap
  // stops us hammering the API forever if a job is stuck server-side.
  const POLL_INTERVAL_MS = 4000;
  const MAX_POLLS = 30; // ~2 minutes of polling, then we give up gracefully.
  const [pollExhausted, setPollExhausted] = React.useState(false);

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
    setPollExhausted(false);
    let attempts = 0;
    let errors = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const r = await api.mediaDetail(mediaId);
        if (!alive) return;
        errors = 0;
        setMedia(r.media);
        setUrl(r.download_url);
        setCachedMedia(mediaId, { media: r.media, download_url: r.download_url });
        // Keep polling only while the object is still being produced and we
        // don't yet have a usable URL. Terminal states (ready/infected/failed)
        // — or any state that already yielded a URL — stop the loop.
        const stillPending = r.media.status === "pending" && !r.download_url;
        if (stillPending) {
          attempts += 1;
          if (attempts >= MAX_POLLS) {
            setPollExhausted(true);
            return;
          }
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (!alive) return;
        // One dropped request must not brand the attachment "unavailable"
        // forever — a timeline mounting dozens of bubbles makes transient
        // fetch failures routine. Back off and retry before giving up.
        errors += 1;
        if (errors < 4) {
          timer = setTimeout(poll, 1000 * errors);
          return;
        }
        setFailed(true);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
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
  const isDev = !!url && (url.includes("dev-download.local") || url.includes("dev-upload.local"));

  // Decide the placeholder shape *before* the URL is known, so the bubble
  // doesn't visibly snap to size when the image actually arrives.
  const probablyVisual =
    (mime || "").toLowerCase().startsWith("image/") ||
    (mime || "").toLowerCase().startsWith("video/");

  if (failed) return <span className="text-xs text-destructive">attachment unavailable</span>;

  // §6.1 — Branch on the server's moderation/processing status *before* trying
  // to render. An AV-flagged ("infected") or transcode-failed ("failed")
  // object comes back with a null `download_url`; without these guards an
  // image would render `src={null}` and audio would have no source while the
  // placeholder spun forever.
  if (media?.status === "infected") {
    return (
      <div className="inline-flex items-center gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <ShieldWarning className="h-4 w-4 shrink-0" weight="fill" />
        <span>attachment blocked - failed a safety scan</span>
      </div>
    );
  }
  if (media?.status === "failed") {
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
      media?.status === "pending" &&
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
              <>generation is taking longer than usual…</>
            ) : (
              <>
                <CircleNotch className="h-3 w-3 animate-spin" /> generating audio…
              </>
            )}
          </span>
        </div>
      );
    }
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

  // Filename / label used by both the preview header and the download. Prefer
  // the explicit filename; fall back to the caption for legacy messages that
  // stored the name there.
  const filename = filenameProp?.trim() || caption?.trim() || media?.kind || "file";

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
        textPreview={textPeek}
        sizeLabel={sizeLabel}
        onClick={() => {
          if (canPreview) setPreviewOpen(true);
          else if (url) downloadAsset(url, filename);
        }}
      />
      {canPreview && (
        <MediaPreviewer
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          url={url}
          mime={m}
          filename={filename}
        />
      )}
    </>
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
