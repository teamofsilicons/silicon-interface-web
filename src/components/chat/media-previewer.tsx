"use client";

import * as React from "react";
import { CircleNotch, DownloadSimple } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authStore } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { MarkdownView } from "./markdown-view";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  url: string;
  mime: string;
  filename?: string;
  /** Media id — required to preview text/html, which is rendered through the
   *  same-origin, sandboxed HTML proxy (`/api/media/<id>/html`) rather than
   *  from the presigned URL directly. Other preview types ignore it. */
  mediaId?: string;
}

/**
 * Fullscreen-ish previewer for assets that render in the browser:
 *   • images, videos, audio   — inline `<img>` / `<video controls>` / `<audio>`
 *   • PDFs                    — inline `<iframe>` (most desktop browsers)
 *
 * The bare `<DialogContent>` doesn't ship with a visible title — we still
 * need one for screen readers, so we render a `sr-only` `DialogTitle`.
 */
export function MediaPreviewer({ open, onOpenChange, url, mime, filename, mediaId }: Props) {
  const m = (mime || "").toLowerCase();
  const name = (filename || "").toLowerCase();
  const isImage = m.startsWith("image/");
  const isVideo = m.startsWith("video/");
  const isAudio = m.startsWith("audio/");
  const isPdf = m.includes("pdf");
  // HTML must render through the sandboxed same-origin proxy, never as raw
  // text or a direct-URL iframe. Detected BEFORE (and excluded from) the text
  // branch, since `text/html` would otherwise match `startsWith("text/")`.
  const isHtml = (m === "text/html" || m.startsWith("text/html;") || /\.(html?|htm)$/.test(name)) && !!mediaId;
  // Markdown / plain-text: render inline. Detect by mime or extension, since
  // .md is often served as application/octet-stream or text/plain.
  const isMarkdown =
    m.includes("markdown") || /\.(md|markdown|mdx)$/.test(name);
  const isText =
    !isHtml &&
    (isMarkdown ||
      m.startsWith("text/") ||
      /\.(txt|text|log|csv|json)$/.test(name));

  // Fetch text content lazily when a text/markdown file is previewed.
  const [text, setText] = React.useState<string | null>(null);
  const [textError, setTextError] = React.useState(false);
  React.useEffect(() => {
    if (!open || !isText || !url) return;
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      setText(null);
      setTextError(false);
    });
    fetch(url, { mode: "cors" })
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (alive) setText(t);
      })
      .catch(() => {
        if (alive) setTextError(true);
      });
    return () => {
      alive = false;
    };
  }, [open, isText, url]);

  // HTML preview: mint a single-use ticket for the same-origin proxy and point
  // a sandboxed iframe at it. The mint request lives in a module-level helper
  // (no setState); results land only via `.then`/`.catch`, mirroring the text
  // fetch above, so nothing sets state synchronously inside the effect. Loading
  // is derived (no src, no error), not stored.
  const [htmlSrc, setHtmlSrc] = React.useState<string | null>(null);
  const [htmlError, setHtmlError] = React.useState(false);
  const mintCounter = React.useRef(0);

  React.useEffect(() => {
    if (!open || !isHtml || !mediaId) return;
    // Bump the token so a late-resolving prior mint is ignored. State is reset
    // on close (handleOpenChange), so a reopen starts from the loading state
    // and never shows a stale/consumed iframe.
    const token = ++mintCounter.current;
    requestHtmlTicket(mediaId)
      .then((src) => {
        if (token === mintCounter.current) {
          setHtmlSrc(src);
          setHtmlError(false);
        }
      })
      .catch(() => {
        if (token === mintCounter.current) setHtmlError(true);
      });
  }, [open, isHtml, mediaId]);

  // Re-mint from a user gesture (retry / reload). Event handler → the
  // synchronous resets are fine here (unlike inside an effect body).
  const remintHtml = React.useCallback(() => {
    if (!mediaId) return;
    const token = ++mintCounter.current;
    setHtmlSrc(null);
    setHtmlError(false);
    requestHtmlTicket(mediaId)
      .then((src) => {
        if (token === mintCounter.current) {
          setHtmlSrc(src);
          setHtmlError(false);
        }
      })
      .catch(() => {
        if (token === mintCounter.current) setHtmlError(true);
      });
  }, [mediaId]);

  // Reset the single-use src when the dialog closes.
  const handleOpenChange = React.useCallback(
    (v: boolean) => {
      if (!v) {
        mintCounter.current += 1;
        setHtmlSrc(null);
        setHtmlError(false);
      }
      onOpenChange(v);
    },
    [onOpenChange],
  );

  const label = filename?.trim() || "preview";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[95vh] w-[min(96vw,1100px)] max-w-none gap-0 overflow-hidden p-0">
        {/* Required for a11y — Radix throws a console error if there is no
            DialogTitle. We don't want it visible, so wrap in sr-only. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>

        {/* Right-padding leaves room for the Dialog's built-in close X
            (positioned absolute, right-4 top-4 in DialogContent) so the
            download button no longer collides with it. */}
        <div className="flex items-center justify-between gap-3 border-b py-2 pl-4 pr-14">
          <span className="truncate text-sm font-medium">{label}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadAsset(url, filename)}
            aria-label="download"
          >
            <DownloadSimple /> download
          </Button>
        </div>
        <div
          className={cn(
            "flex max-h-[82vh] min-h-[40vh] overflow-auto bg-card",
            // Text is top-left aligned and scrolls; media is centered.
            isText ? "items-start justify-start" : "items-center justify-center",
          )}
        >
          {isImage && (
            // eslint-disable-next-line @next/next/no-img-element -- presigned/public S3
            <img
              src={url}
              alt={label}
              className="max-h-[80vh] max-w-full object-contain"
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
          {isHtml && (
            <div className="relative h-[80vh] w-full">
              {htmlError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    couldn&rsquo;t load the preview.
                  </p>
                  <Button size="sm" variant="outline" onClick={remintHtml}>
                    retry
                  </Button>
                </div>
              ) : !htmlSrc ? (
                <p className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <CircleNotch className="h-4 w-4 animate-spin" /> loading…
                </p>
              ) : (
                <>
                  <iframe
                    sandbox=""
                    src={htmlSrc}
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    allow=""
                    title={label}
                    className="h-[80vh] w-full border-0"
                    onError={() => setHtmlError(true)}
                  />
                  {/* The proxy ticket is single-use; if the iframe shows the
                      expired/replay page, this re-mints a fresh one. */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={remintHtml}
                    className="absolute right-2 top-2 opacity-80 hover:opacity-100"
                  >
                    reload
                  </Button>
                </>
              )}
            </div>
          )}
          {isText && (
            <div className="w-full p-6">
              {textError ? (
                <p className="text-sm text-muted-foreground">
                  couldn&rsquo;t load the file — use the download button.
                </p>
              ) : text === null ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CircleNotch className="h-4 w-4 animate-spin" /> loading…
                </p>
              ) : isMarkdown ? (
                <MarkdownView source={text} className="mx-auto max-w-3xl" />
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {text}
                </pre>
              )}
            </div>
          )}
          {!isImage && !isVideo && !isAudio && !isPdf && !isText && !isHtml && (
            <p className="p-12 text-sm text-muted-foreground">
              no inline preview available - use the download button.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mint a single-use HTML-preview ticket from the same-origin route, attaching
 * the app's auth headers. Returns the sandboxed proxy `src`, or throws. Kept at
 * module scope (no setState) so callers can resolve it via `.then`.
 */
async function requestHtmlTicket(mediaId: string): Promise<string> {
  const headers: Record<string, string> = {};
  const access = authStore.getAccess();
  if (access) headers["Authorization"] = `Bearer ${access}`;
  const silKey = authStore.getSiliconKey();
  if (silKey) headers["X-Silicon-Key"] = silKey;
  const r = await fetch(`/api/media/${encodeURIComponent(mediaId)}/html/ticket`, {
    method: "POST",
    headers,
  });
  if (!r.ok) throw new Error(`ticket mint failed: ${r.status}`);
  const data = (await r.json()) as { src?: string };
  if (!data.src) throw new Error("ticket mint returned no src");
  return data.src;
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
