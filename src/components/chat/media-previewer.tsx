"use client";

import * as React from "react";
import {
  CircleNotch,
  Code,
  DownloadSimple,
  Eye,
  PencilSimple,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
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
import { MarkdownView } from "./markdown-view";
import { SourceCodeViewer } from "./source-code-viewer";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  url: string;
  mime: string;
  filename?: string;
  /** When both are set and the asset is an image/PDF, an "annotate" action is
   *  offered next to download, opening the annotation studio. */
  roomId?: string;
  sourceMediaId?: string;
  /** event_id of the message carrying this attachment (reply target for the
   *  annotation draft). */
  sourceEventId?: string;
  /** Stage the annotations as a composer draft instead of posting directly. */
  onAttachAnnotations?: (draft: AnnotationDraft) => void;
}

/**
 * Fullscreen-ish previewer for assets that render in the browser:
 *   • images, videos, audio   — inline `<img>` / `<video controls>` / `<audio>`
 *   • PDFs                    — inline `<iframe>` (most desktop browsers)
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
  roomId,
  sourceMediaId,
  sourceEventId,
  onAttachAnnotations,
}: Props) {
  const m = (mime || "").toLowerCase();
  const language = languageForFile(filename, mime);
  const isSvgDocument = language?.id === "svg";
  const isImage = m.startsWith("image/") && !isSvgDocument;
  const isVideo = m.startsWith("video/");
  const isAudio = m.startsWith("audio/");
  const name = (filename || "").toLowerCase();
  const isPdf = m.includes("pdf") || name.endsWith(".pdf");
  const isMarkdown = language?.id === "markdown";
  const isHtmlDocument = language?.id === "html";
  const hasPreviewPane = hasRenderedSourcePreview(filename, mime);
  const isText = isTextLikeFile(filename, mime);
  const canAnnotate = Boolean(roomId && sourceMediaId && (isImage || isPdf));
  const [studioOpen, setStudioOpen] = React.useState(false);
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
    url: string;
    text: string | null;
    error: boolean;
  } | null>(null);
  React.useEffect(() => {
    if (!open || !isText || !url) return;
    let alive = true;
    fetch(url, { mode: "cors" })
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (alive) setTextState({ url, text: t, error: false });
      })
      .catch(() => {
        if (alive) setTextState({ url, text: null, error: true });
      });
    return () => {
      alive = false;
    };
  }, [open, isText, url]);

  const label = filename?.trim() || "preview";
  const textForUrl = textState?.url === url ? textState.text : null;
  const textError = textState?.url === url ? textState.error : false;
  const activeSourceMode = hasPreviewPane ? sourceMode : "code";
  const showSourceToggle = isText && hasPreviewPane;
  const renderedSourceOpen = isText && activeSourceMode === "preview";

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[95vh] w-[min(96vw,1100px)] max-w-none gap-0 overflow-hidden p-0">
        {/* Required for a11y — Radix throws a console error if there is no
            DialogTitle. We don't want it visible, so wrap in sr-only. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>

        {/* Right-padding leaves room for the Dialog's built-in close X
            (positioned absolute, right-4 top-4 in DialogContent) so the
            action buttons no longer collide with it. */}
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
            {canAnnotate && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  // Hand off to the studio; close the read-only previewer so the
                  // two modals don't stack.
                  setStudioOpen(true);
                  onOpenChange(false);
                }}
                aria-label="annotate"
              >
                <PencilSimple /> annotate
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadAsset(url, filename)}
              aria-label="download"
            >
              <DownloadSimple /> download
            </Button>
          </div>
        </div>
        <div
          className={cn(
            "flex max-h-[82vh] min-h-[40vh] bg-card",
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
              className="sdr-media max-h-[80vh] max-w-full object-contain"
            />
          )}
          {isVideo && (
            <video src={url} controls autoPlay className="max-h-[80vh] max-w-full" />
          )}
          {isAudio && (
            <audio src={url} controls autoPlay className="w-[min(80vw,520px)] p-6" />
          )}
          {isPdf && (
            <iframe
              src={url}
              title={label}
              className="h-[80vh] w-full border-0"
            />
          )}
          {isText && (
            <div className={cn("w-full", renderedSourceOpen ? "h-[82vh]" : "p-6")}>
              {textError ? (
                <p className="text-sm text-muted-foreground">
                  couldn&rsquo;t load the file - use the download button.
                </p>
              ) : textForUrl === null ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleNotch className="h-4 w-4 animate-spin" /> loading...
                </p>
              ) : activeSourceMode === "preview" && isHtmlDocument ? (
                <HtmlPreviewFrame source={textForUrl} title={label} baseUrl={url} />
              ) : activeSourceMode === "preview" && isSvgDocument ? (
                <SvgPreviewFrame source={textForUrl} title={label} />
              ) : activeSourceMode === "preview" && isMarkdown ? (
                <div className="h-full overflow-auto p-6">
                  <MarkdownView source={textForUrl} className="mx-auto max-w-3xl" />
                </div>
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
      </DialogContent>
    </Dialog>
    {canAnnotate && roomId && sourceMediaId && (
      <AnnotationStudio
        open={studioOpen}
        onOpenChange={setStudioOpen}
        url={url}
        mime={mime}
        filename={filename}
        roomId={roomId}
        sourceMediaId={sourceMediaId}
        sourceEventId={sourceEventId}
        onAttach={onAttachAnnotations}
      />
    )}
    </>
  );
}

type SourceViewMode = "preview" | "code";

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
 * `<a download>` click on its blob URL. If the bucket isn't returning CORS
 * headers (so `fetch` rejects), silently fall back to opening the URL in a
 * new tab — the user can still right-click → save there.
 */
export async function downloadAsset(url: string, filename?: string): Promise<void> {
  try {
    const r = await fetch(url, { mode: "cors" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const blob = await r.blob();
    const tmp = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = tmp;
    a.download = filename || guessFilenameFromUrl(url);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(tmp), 1500);
    return;
  } catch {
    // CORS blocked / network failure — silent fall through; opening in a
    // new tab still lets the user right-click → save, which is the worst
    // case we want to land in.
  }
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
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
