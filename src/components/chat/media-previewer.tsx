"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CircleNotch,
  Code,
  DownloadSimple,
  Eye,
  PencilSimple,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  hasRenderedSourcePreview,
  isTextLikeFile,
  languageForFile,
} from "@/lib/programmatic-files";
import { cn } from "@/lib/utils";
import type { AnnotationDraft } from "@/lib/types";

import { AnnotationStudio } from "./annotation-studio/annotation-studio";
import { CsvPreviewer } from "./csv-previewer";
import { CustomVideoPlayer } from "./custom-video-player";
import { MarkdownView } from "./markdown-view";
import { PreviewModalComposer } from "./preview-modal-composer";
import { SiliconAudio } from "./silicon-audio";
import { SourceCodeViewer } from "./source-code-viewer";

export interface AnnotationOpenRequest {
  url: string;
  mime: string;
  filename?: string;
  roomId: string;
  sourceMediaId: string;
  sourceEventId?: string;
  onAttach?: (draft: AnnotationDraft) => void;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  url: string;
  mime: string;
  filename?: string;
  replyToEventId?: string;
  /** When both are set and the asset is an image/PDF, offer annotation. */
  roomId?: string;
  sourceMediaId?: string;
  sourceEventId?: string;
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
  /** Let a stable parent own the studio instead of nesting it in this dialog. */
  onOpenAnnotation?: (request: AnnotationOpenRequest) => void;
}

/**
 * Fullscreen-ish previewer for assets that render in the browser:
 *   • images, videos, audio   — inline image + Silicon custom media controls
 *   • PDFs                    — authenticated bytes in a local blob frame
 *
 * The bare `<DialogContent>` doesn't ship with a visible title — we still
 * need one for screen readers, so we render a `sr-only` `DialogTitle`.
 */
export function MediaPreviewer({
  open,
  onOpenChange,
  url,
  mime,
  filename,
  replyToEventId,
  roomId,
  sourceMediaId,
  sourceEventId,
  onAttachAnnotations,
  onOpenAnnotation,
}: Props) {
  const m = (mime || "").toLowerCase();
  const name = (filename || "").toLowerCase();
  const language = languageForFile(filename, mime);
  const isSvgDocument = language?.id === "svg";
  const isImage = m.startsWith("image/") && !isSvgDocument;
  const isVideo = m.startsWith("video/");
  const isAudio = m.startsWith("audio/");
  const isPdf = m.includes("pdf") || name.endsWith(".pdf");
  const canAnnotate = Boolean(
    roomId &&
      sourceMediaId &&
      (onAttachAnnotations || onOpenAnnotation) &&
      (isImage || isPdf),
  );
  const [localStudioOpen, setLocalStudioOpen] = React.useState(false);
  const isMarkdown = language?.id === "markdown";
  const isCsv = language?.id === "csv";
  const isHtmlDocument = language?.id === "html";
  const hasPreviewPane = hasRenderedSourcePreview(filename, mime);
  const isText = isTextLikeFile(filename, mime);
  const defaultSourceMode: SourceViewMode = hasPreviewPane ? "preview" : "code";
  const sourceKey = `${url}\n${defaultSourceMode}`;
  const [sourceModeState, setSourceModeState] = React.useState<{
    key: string;
    mode: SourceViewMode;
  }>(() => ({ key: sourceKey, mode: defaultSourceMode }));
  const sourceMode =
    sourceModeState.key === sourceKey ? sourceModeState.mode : defaultSourceMode;
  const setSourceMode = React.useCallback(
    (mode: SourceViewMode) => setSourceModeState({ key: sourceKey, mode }),
    [sourceKey],
  );

  // Fetch text content lazily when source/text files are previewed.
  const [textState, setTextState] = React.useState<{
    key: string;
    text: string | null;
    error: boolean;
  } | null>(null);
  const textKey = `${sourceMediaId ?? ""}\n${url}`;
  React.useEffect(() => {
    if (!open || !isText || !url) return;
    let alive = true;
    const directText = () => fetch(url, { mode: "cors" }).then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.text();
      });
    // Stable authenticated media bytes make .txt/.json previews work even
    // when an older presigned URL expired or the storage bucket omits CORS.
    // The direct path remains necessary for this sender's pre-scan blob URL.
    const text = sourceMediaId
      ? api.mediaTextPreview(sourceMediaId, 256 * 1024).catch(directText)
      : directText();
    text
      .then((t) => {
        if (alive) setTextState({ key: textKey, text: t, error: false });
      })
      .catch(() => {
        if (alive) setTextState({ key: textKey, text: null, error: true });
      });
    return () => {
      alive = false;
    };
  }, [open, isText, sourceMediaId, textKey, url]);

  const label = filename?.trim() || "preview";
  const textForUrl = textState?.key === textKey ? textState.text : null;
  const textError = textState?.key === textKey ? textState.error : false;
  const activeSourceMode = hasPreviewPane ? sourceMode : "code";
  const showSourceToggle = isText && hasPreviewPane;
  const renderedSourceOpen = isText && activeSourceMode === "preview";

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100vh-1rem)] h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none min-w-0 flex-col gap-0 overflow-hidden p-0 sm:h-[95vh] sm:h-[95dvh] sm:w-[min(96vw,1100px)]">
        {/* Required for a11y — Radix throws a console error if there is no
            DialogTitle. We don't want it visible, so wrap in sr-only. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>

        {/* Right-padding leaves room for the Dialog's built-in close X
            (positioned absolute, right-4 top-4 in DialogContent) so the
            download button no longer collides with it. */}
        <div className="flex items-center justify-between gap-3 border-b py-2 pl-4 pr-14">
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{label}</span>
            {language ? (
              <span className="label-mono text-[10px] text-muted-foreground">
                {language.label}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showSourceToggle ? (
              <SourceModeToggle mode={sourceMode} onModeChange={setSourceMode} />
            ) : null}
            {canAnnotate ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!roomId || !sourceMediaId) return;
                  if (!onOpenAnnotation) {
                    setLocalStudioOpen(true);
                    return;
                  }
                  onOpenAnnotation({
                    url,
                    mime,
                    filename,
                    roomId,
                    sourceMediaId,
                    ...(sourceEventId ? { sourceEventId } : {}),
                    onAttach: onAttachAnnotations,
                  });
                  onOpenChange(false);
                }}
                aria-label="annotate"
              >
                <PencilSimple /> annotate
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadAsset(url, filename, { mediaId: sourceMediaId })}
              aria-label="download"
            >
              <DownloadSimple /> download
            </Button>
          </div>
        </div>
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 bg-card",
            // Text is top-left aligned and scrolls; media is centered.
            isText || isPdf
              ? renderedSourceOpen
                ? "items-stretch justify-start overflow-hidden"
                : "items-start justify-start overflow-auto"
              : "items-center justify-center overflow-auto",
          )}
        >
          {isImage && (
            // eslint-disable-next-line @next/next/no-img-element -- presigned/public S3
            <img
              src={url}
              alt={label}
              draggable={false}
              className="sdr-media max-h-full max-w-full select-none object-contain"
            />
          )}
          {isVideo && (
            <CustomVideoPlayer
              url={url}
              mime={m}
              autoPlay
              className="aspect-video max-h-full w-full max-w-full"
            />
          )}
          {isAudio && (
            <SiliconAudio
              url={url}
              autoPlay
              className="w-[min(90vw,680px)] border bg-background p-4 text-foreground"
            />
          )}
          {isPdf && (
            <PdfPreviewFrame
              url={url}
              mediaId={sourceMediaId}
              title={label}
            />
          )}
          {isText && (
            <div className={cn("min-w-0 max-w-full flex-1", renderedSourceOpen ? "h-full min-h-[40dvh]" : "p-4 sm:p-6")}>
              {textError ? (
                <p className="grid h-full min-h-[40dvh] w-full place-items-center p-6 text-sm text-muted-foreground">
                  couldn&rsquo;t load the file - use the download button.
                </p>
              ) : textForUrl === null ? (
                <div
                  className="grid h-full min-h-[40dvh] w-full place-items-center p-6 text-sm text-muted-foreground"
                  role="status"
                >
                  <span className="flex items-center gap-2">
                    <CircleNotch className="h-4 w-4 animate-spin" /> loading...
                  </span>
                </div>
              ) : activeSourceMode === "preview" && isHtmlDocument ? (
                <HtmlPreviewFrame source={textForUrl} title={label} baseUrl={url} />
              ) : activeSourceMode === "preview" && isSvgDocument ? (
                <SvgPreviewFrame source={textForUrl} title={label} />
              ) : activeSourceMode === "preview" && isMarkdown ? (
                <div className="h-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 py-5 [overscroll-behavior:contain] sm:p-6">
                  <MarkdownView source={textForUrl} className="mx-auto w-full min-w-0 max-w-3xl" />
                </div>
              ) : activeSourceMode === "preview" && isCsv ? (
                <CsvPreviewer source={textForUrl} />
              ) : (
                <SourceCodeViewer source={textForUrl} language={language} />
              )}
            </div>
          )}
          {!isImage && !isVideo && !isAudio && !isPdf && !isText && (
            <p className="p-12 text-sm text-muted-foreground">
              no inline preview available - use the download button.
            </p>
          )}
        </div>
        <PreviewModalComposer replyToEventId={replyToEventId} onSent={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
    {!onOpenAnnotation && canAnnotate && roomId && sourceMediaId ? (
      <AnnotationStudio
        key={`${roomId}:${sourceMediaId}`}
        open={localStudioOpen}
        onOpenChange={setLocalStudioOpen}
        url={url}
        mime={mime}
        filename={filename}
        roomId={roomId}
        sourceMediaId={sourceMediaId}
        sourceEventId={sourceEventId}
        onAttach={onAttachAnnotations}
      />
    ) : null}
    </>
  );
}

type SourceViewMode = "preview" | "code";

function PdfPreviewFrame({
  url,
  mediaId,
  title,
}: {
  url: string;
  mediaId?: string;
  title: string;
}) {
  const key = `${mediaId ?? ""}\n${url}`;
  const [state, setState] = React.useState<{
    key: string;
    frameUrl: string | null;
    error: boolean;
  } | null>(null);

  React.useEffect(() => {
    let alive = true;
    let ownedUrl: string | null = null;

    const load = async () => {
      try {
        // Persisted files use the authenticated same-origin content endpoint.
        // This avoids both expiring presigns and storage response headers that
        // forbid framing. Local draft previews can reuse their existing blob.
        if (!mediaId && url.startsWith("blob:")) {
          if (alive) setState({ key, frameUrl: url, error: false });
          return;
        }

        let blob: Blob;
        if (mediaId) {
          try {
            blob = await api.mediaContent(mediaId);
          } catch {
            const response = await fetch(url, { mode: "cors" });
            if (!response.ok) throw new Error(`status ${response.status}`);
            blob = await response.blob();
          }
        } else {
          const response = await fetch(url, { mode: "cors" });
          if (!response.ok) throw new Error(`status ${response.status}`);
          blob = await response.blob();
        }
        if (!alive) return;
        ownedUrl = URL.createObjectURL(
          blob.type === "application/pdf"
            ? blob
            : new Blob([blob], { type: "application/pdf" }),
        );
        setState({ key, frameUrl: ownedUrl, error: false });
      } catch {
        if (alive) setState({ key, frameUrl: null, error: true });
      }
    };

    void load();
    return () => {
      alive = false;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [key, mediaId, url]);

  const current = state?.key === key ? state : null;
  if (current?.error) {
    return (
      <p className="m-auto p-6 text-sm text-muted-foreground">
        couldn&rsquo;t load the PDF preview - use the download button.
      </p>
    );
  }
  if (!current?.frameUrl) {
    return (
      <p className="m-auto flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status">
        <CircleNotch className="h-4 w-4 animate-spin" /> loading PDF...
      </p>
    );
  }
  return (
    <iframe
      src={current.frameUrl}
      title={title}
      className="h-full min-h-[40vh] w-full border-0"
    />
  );
}

function SourceModeToggle({
  mode,
  onModeChange,
}: {
  mode: SourceViewMode;
  onModeChange: (mode: SourceViewMode) => void;
}) {
  return (
    <div className="inline-flex h-8 shrink-0 border bg-background" role="group" aria-label="source view">
      <button
        type="button"
        aria-pressed={mode === "preview"}
        onClick={() => onModeChange("preview")}
        className={cn(
          "inline-flex items-center gap-1 border-r px-2 text-xs transition-colors",
          mode === "preview"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Eye className="h-3.5 w-3.5" /> preview
      </button>
      <button
        type="button"
        aria-pressed={mode === "code"}
        onClick={() => onModeChange("code")}
        className={cn(
          "inline-flex items-center gap-1 px-2 text-xs transition-colors",
          mode === "code"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Code className="h-3.5 w-3.5" /> code
      </button>
    </div>
  );
}

function HtmlPreviewFrame({
  source,
  title,
  baseUrl,
}: {
  source: string;
  title: string;
  baseUrl: string;
}) {
  const srcDoc = React.useMemo(() => withBaseHref(source, baseUrl), [source, baseUrl]);
  return (
    <iframe
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={`${title} preview`}
      className="h-full w-full border-0 bg-card"
    />
  );
}

function SvgPreviewFrame({ source, title }: { source: string; title: string }) {
  const srcDoc = React.useMemo(
    () => `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
html,body{margin:0;min-height:100%}
body{display:grid;place-items:center;min-height:100vh;overflow:auto}
svg{max-width:100%;max-height:100vh}
</style>
</head>
<body>${source}</body>
</html>`,
    [source],
  );
  return (
    <iframe
      sandbox=""
      srcDoc={srcDoc}
      title={`${title} preview`}
      className="h-full w-full border-0 bg-card"
    />
  );
}

function withBaseHref(source: string, baseUrl: string): string {
  if (/<base\b/i.test(source)) return source;
  const tag = `<base href="${escapeHtmlAttr(baseUrl)}" />`;
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
  }
  return `${tag}${source}`;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Force a true download by fetching the asset as a blob and triggering an
 * `<a download>` click on its blob URL. For persisted media, prefer Glass's
 * attachment-specific presign so the browser downloads directly even when S3
 * doesn't expose the object to cross-origin fetches.
 */
export async function downloadAsset(
  url: string,
  filename?: string,
  options: { mediaId?: string; attachmentUrl?: string | null } = {},
): Promise<void> {
  let attachmentUrl = options.attachmentUrl ?? null;
  if (!attachmentUrl && options.mediaId) {
    try {
      attachmentUrl = (await api.mediaDetail(options.mediaId)).attachment_url ?? null;
    } catch {
      // Fall through to the blob path, which still works when S3 allows CORS.
    }
  }
  const bridge = desktopBridge();
  const nativeUrl = attachmentUrl ?? url;
  if (bridge && /^https?:\/\//i.test(nativeUrl)) {
    const progressToast = toast.loading("downloading…");
    const result = await bridge.downloads.saveUrl(
      nativeUrl,
      filename || guessFilenameFromUrl(url),
    );
    toast.dismiss(progressToast);
    if (result === "saved") toast.success("download complete");
    else if (result === "failed") toast.error("couldn't download attachment");
    return;
  }
  if (attachmentUrl) {
    triggerDownload(attachmentUrl, filename || guessFilenameFromUrl(url));
    return;
  }

  try {
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const blob = await r.blob();
    const tmp = URL.createObjectURL(blob);
    triggerDownload(tmp, filename || guessFilenameFromUrl(url));
    setTimeout(() => URL.revokeObjectURL(tmp), 1500);
  } catch {
    toast.error("couldn't download attachment");
  }
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function guessFilenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "download";
  } catch {
    return "download";
  }
}
