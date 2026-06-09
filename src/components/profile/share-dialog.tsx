"use client";

import * as React from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Copy, DownloadSimple, LinkSimple } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

import { copyText } from "@/lib/clipboard";
import { glyphAscii } from "@/lib/glyph";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Brand tokens — kept as literals so the downloaded PNG matches the in-app
// card pixel-for-pixel without reading computed CSS off live elements.
const BG = "#ede8e0"; // warm beige canvas
const INK = "#1a1a1a"; // near-black
const BORDER = "#d4cfc7"; // hairline
const MUTED = "#666666";

const QR_DISPLAY_SIZE = 200; // CSS px in the dialog
const QR_RENDER_SIZE = 960; // backing pixels used for retina display + downloads
const QR_LOGO_FRACTION = 0.22; // logo edge ÷ qr edge — tuned for level-H error correction

/**
 * A scannable QR + downloadable share card. The QR encodes a `/c/<id>` deep
 * link that opens a direct chat with this Carbon. The center of the QR holds
 * the brand logo (level-H error correction tolerates the overlay), and the
 * download button rasterizes a high-res branded composite as a PNG.
 */
export function ShareDialog({
  carbonId,
  name,
  open,
  onOpenChange,
}: {
  carbonId: string;
  name?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // Lazy init so we never touch `window` on the server during render. The
  // dialog is client-only ('use client'), but a few production builds in
  // React 19 still pre-render the static shell — this avoids a possible
  // hydration mismatch on `link`.
  const [link, setLink] = React.useState(`/c/${carbonId}`);
  React.useEffect(() => {
    setLink(`${window.location.origin}/c/${carbonId}`);
  }, [carbonId]);

  // Single canvas — the displayed QR also feeds the downloaded share card.
  // The previous hidden hi-res companion canvas (position:absolute,
  // left:-9999px) was the most likely cause of the "share modal broken"
  // reports — extra portal mount + offscreen layout interacted badly with
  // some Vercel edge cache states.
  const qrRef = React.useRef<HTMLCanvasElement>(null);

  // QA §7.1: route every copy through the never-lies helper and only toast
  // success on a real copy; otherwise tell the user it failed.
  const copyLink = async () => {
    if (await copyText(link)) toast.success("link copied");
    else toast.error("couldn't copy — copy it manually");
  };
  const copyId = async () => {
    if (await copyText(carbonId)) toast.success("Carbon ID copied");
    else toast.error("couldn't copy — copy it manually");
  };

  const download = async () => {
    const qr = qrRef.current;
    if (!qr) {
      toast.error("share card not ready yet — try again in a moment");
      return;
    }
    try {
      await buildShareCard({ qr, carbonId, name, link });
      toast.success("share card downloaded");
    } catch (err) {
      // Surface the real error so the user knows what to retry.
      const msg = err instanceof Error ? err.message : "download failed";
      toast.error(msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-sm overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share your chat</DialogTitle>
          <DialogDescription>
            Scan to start a conversation with you.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col items-center gap-3">
          {/* QR on a beige card so it matches the rest of the interface. The
              inner padding keeps a clear quiet zone around the modules so
              scanners still pick it up reliably. */}
          <div className="border bg-card p-3">
            <QRCodeCanvas
              ref={qrRef}
              value={link}
              size={QR_RENDER_SIZE}
              bgColor={BG}
              fgColor={INK}
              level="H"
              marginSize={2}
              style={{ width: QR_DISPLAY_SIZE, height: QR_DISPLAY_SIZE }}
              imageSettings={{
                src: "/logo.png",
                width: Math.round(QR_RENDER_SIZE * QR_LOGO_FRACTION),
                height: Math.round(QR_RENDER_SIZE * QR_LOGO_FRACTION),
                excavate: true,
                crossOrigin: "anonymous",
              }}
            />
          </div>

          <CardRow
            label="Carbon ID"
            value={carbonId}
            onCopy={copyId}
            copyLabel="copy Carbon ID"
          />

          <CardRow
            icon={<LinkSimple className="h-3.5 w-3.5 shrink-0 opacity-50" />}
            label="link"
            value={link}
            onCopy={copyLink}
            copyLabel="copy link"
          />

          {/* §8d — a copy-code button distinct from copy-link. The Carbon ID is
              the OTP-style code people read aloud, so it earns its own action
              separate from the URL copy above. */}
          <Button variant="outline" onClick={copyId} className="w-full">
            <Copy /> copy code
          </Button>

          <Button onClick={download} className="mt-1 w-full">
            <DownloadSimple /> Download share card
          </Button>
        </div>

      </DialogContent>
    </Dialog>
  );
}

/** Compact row: monospaced value + copy button, with a label eyebrow above. */
function CardRow({
  label,
  value,
  icon,
  onCopy,
  copyLabel,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  onCopy: () => void;
  copyLabel: string;
}) {
  return (
    <div className="min-w-0 w-full border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-1 label-mono text-[10px]">
        {icon}
        <span className="opacity-60">{label}</span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 overflow-hidden truncate whitespace-nowrap font-mono text-xs">
          {value}
        </span>
        <Button size="icon" variant="ghost" aria-label={copyLabel} onClick={onCopy} className="shrink-0">
          <Copy />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Download composite
// ---------------------------------------------------------------------------

interface BuildArgs {
  qr: HTMLCanvasElement;
  carbonId: string;
  name?: string;
  link: string;
}

/**
 * Render a high-resolution branded share card and trigger a PNG download.
 *
 * Layout (logical px, 3× device scale for high-resolution output):
 *
 *   ┌─────────────────────────────────┐
 *   │                                 │
 *   │      ▢  Silicon Interface       │   ← centered eyebrow
 *   │                                 │
 *   │                                 │
 *   │              [QR]               │   ← scannable, with logo embedded,
 *   │                                 │      sitting directly on beige
 *   │                                 │
 *   │           ──── ✶ ────           │   ← hairline + brand dot
 *   │                                 │
 *   │       scan to start a chat      │   ← small TikTok Sans subtitle
 *   │                                 │
 *   │            Shubham              │   ← display name (if provided)
 *   │         carbon-shubham          │   ← Carbon ID, mono
 *   │                                 │
 *   │       interface.com/c/carbon-…  │   ← link, mono, muted
 *   │                                 │
 *   └─────────────────────────────────┘
 *
 * The composite carries everything a scanner can't already give — the
 * recipient sees who they're scanning, the canonical link, and the brand,
 * even before they decode the QR.
 */
async function buildShareCard({ qr, carbonId, name, link }: BuildArgs): Promise<void> {
  // Square card — same shape as social-share posters and printable cards.
  const W = 1080;
  const H = 1080;
  const SCALE = 3;
  const FRAME_INSET = 36;

  // Wait for the brand webfonts (JetBrains Mono / TikTok Sans) to finish
  // loading before measuring/drawing. Canvas text falls back to a system font
  // if the face isn't ready yet, producing an off-brand card whose measured
  // widths (used for centering + truncation) are wrong too. `document.fonts`
  // is widely supported; guard it just in case.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* draw with whatever's available rather than fail the export */
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "alphabetic";

  // Canvas
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Inset hairline frame — gives the card a printed-poster feel without any
  // weight. The +0.5 keeps the 1px line crisp on the pixel grid.
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    FRAME_INSET + 0.5,
    FRAME_INSET + 0.5,
    W - FRAME_INSET * 2,
    H - FRAME_INSET * 2,
  );

  // ---- Eyebrow: logo + wordmark, centered near the top
  // QA medium: if `/logo.png` is served from a CDN that doesn't return CORS
  // headers, drawing it taints the canvas and the later `toDataURL` throws a
  // SecurityError that aborts the whole export. The logo is decorative, so we
  // load it best-effort and fall back to wordmark-only rather than risk the
  // download. (loadImage already requests crossOrigin="anonymous"; a clean CDN
  // keeps the canvas exportable, a misconfigured one just drops the glyph.)
  const logo = await loadImage("/logo.png").catch(() => null);
  const logoH = 36;
  const logoW = logo ? (logo.width / logo.height) * logoH : 0;
  const wordmark = "Silicon Interface";
  ctx.font = '500 20px "JetBrains Mono", ui-monospace, monospace';
  const wordW = ctx.measureText(wordmark).width;
  const eyebrowGap = logo ? 16 : 0;
  const eyebrowTotalW = logoW + eyebrowGap + wordW;
  const eyebrowX = (W - eyebrowTotalW) / 2;
  const eyebrowY = 96;
  if (logo) ctx.drawImage(logo, eyebrowX, eyebrowY - logoH + 6, logoW, logoH);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.fillText(wordmark, eyebrowX + logoW + eyebrowGap, eyebrowY);

  // ---- QR — sits directly on the beige canvas, no card chrome around it
  const qrSize = 570;
  const qrX = (W - qrSize) / 2;
  const qrY = eyebrowY + 72;
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  // ---- §8a — the recipient's ASCII mark, in monospace beside the QR. Same
  // deterministic grid that renders their avatar everywhere else, so the share
  // card carries their actual silicon identity, not just a generic QR. Drawn in
  // the left gutter, vertically centered on the QR.
  drawAsciiMark(ctx, carbonId, { qrX, qrY, qrSize }, FRAME_INSET);

  // ---- Divider: hairline with a brand glyph in the middle. The middle gap
  // is a subtle decorative beat that breaks the rule cleanly without needing
  // extra ornaments.
  const dividerY = qrY + qrSize + 84;
  const dividerHalfW = 120;
  const dividerGap = 26;
  ctx.strokeStyle = BORDER;
  ctx.beginPath();
  ctx.moveTo(W / 2 - dividerHalfW, dividerY + 0.5);
  ctx.lineTo(W / 2 - dividerGap, dividerY + 0.5);
  ctx.moveTo(W / 2 + dividerGap, dividerY + 0.5);
  ctx.lineTo(W / 2 + dividerHalfW, dividerY + 0.5);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(W / 2, dividerY + 0.5, 4, 0, Math.PI * 2);
  ctx.fill();

  // ---- Subtitle
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = '500 20px "TikTok Sans", -apple-system, "Segoe UI", sans-serif';
  ctx.fillText("scan to start a chat", W / 2, dividerY + 48);

  // ---- Identity block: optional display name → Carbon ID → link
  // QA medium: a long name or carbonId overflowed the card edge — the prior
  // fix only truncated the link. Clamp each line to the inner content width.
  const maxIdentityW = W - FRAME_INSET * 2 - 48;
  let cursorY = dividerY + 96;
  if (name && name.trim()) {
    ctx.fillStyle = INK;
    ctx.font = '600 34px "TikTok Sans", -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(truncateEnd(name.trim(), ctx, maxIdentityW), W / 2, cursorY);
    cursorY += 44;
  }

  ctx.fillStyle = INK;
  ctx.font = '600 24px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(truncateEnd(carbonId, ctx, maxIdentityW), W / 2, cursorY);
  cursorY += 42;

  ctx.fillStyle = MUTED;
  ctx.font = '500 18px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(truncateMid(link, ctx, maxIdentityW), W / 2, cursorY);

  // ---- Trigger download. A same-origin /logo.png keeps the canvas clean; if
  // it's served cross-origin without CORS, the embedded logo (in the QR and/or
  // eyebrow) taints the canvas and toDataURL throws a SecurityError. Translate
  // that into an actionable message instead of leaking the raw DOMException.
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    throw new Error(
      "couldn't export the share card — the logo is blocking it. Try the copy-link button instead.",
    );
  }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `silicon-interface-${carbonId}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * §8a — draw the recipient's MarkSystem mark as ASCII in the left gutter beside
 * the QR. The grid is the same one `IdAvatar` falls back to, so the poster
 * carries the user's real silicon identity. Sized to fit the gutter width and
 * vertically centered on the QR; falls back to a no-op if the mark is empty.
 */
function drawAsciiMark(
  ctx: CanvasRenderingContext2D,
  carbonId: string,
  qr: { qrX: number; qrY: number; qrSize: number },
  frameInset: number,
): void {
  const rows = glyphAscii(carbonId, { family: "carbon" }).split("\n");
  const cols = rows.reduce((m, r) => Math.max(m, [...r].length), 0);
  if (!rows.length || !cols) return;

  // Fit the mark into the left gutter: the clear beige between the card frame
  // and the QR. Leave breathing room on both sides.
  const gutterLeft = frameInset + 28;
  const gutterRight = qr.qrX - 28;
  const gutterW = gutterRight - gutterLeft;
  if (gutterW <= 0) return;

  // Monospace: cell width ≈ 0.6 × font size. Solve so the grid fills the gutter,
  // then clamp to a tasteful range.
  const cellW = gutterW / cols;
  const fontSize = Math.max(10, Math.min(20, cellW / 0.6));
  const lineH = fontSize; // line-height:1, like the in-app <pre>
  const blockH = lineH * rows.length;

  ctx.save();
  ctx.font = `${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const startX = gutterLeft;
  const startY = qr.qrY + (qr.qrSize - blockH) / 2;
  // Draw cell-by-cell at fixed column centers so the grid stays aligned even if
  // the block/triangle glyphs (█ ◤◥◢◣) carry different advance widths than the
  // space — relying on string layout would skew the mark.
  rows.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      if (ch === " ") return;
      ctx.fillText(ch, startX + (c + 0.5) * cellW, startY + r * lineH);
    });
  });
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Trim with a trailing ellipsis so a too-long single line fits its column. */
function truncateEnd(s: string, ctx: CanvasRenderingContext2D, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid;
  }
  return `${s.slice(0, lo)}…`;
}

/** Trim with ellipsis in the middle so the link's start + end stay visible. */
function truncateMid(s: string, ctx: CanvasRenderingContext2D, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (hi - lo > 2) {
    const mid = (lo + hi) >> 1;
    const head = s.slice(0, mid);
    const tail = s.slice(s.length - mid);
    if (ctx.measureText(`${head}…${tail}`).width <= maxW) lo = mid;
    else hi = mid;
  }
  return `${s.slice(0, lo)}…${s.slice(s.length - lo)}`;
}
