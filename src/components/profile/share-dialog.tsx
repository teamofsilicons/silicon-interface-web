"use client";

import * as React from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Copy, DownloadSimple, LinkSimple } from "@phosphor-icons/react/dist/ssr";
import { toast } from "sonner";

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

const QR_DISPLAY_SIZE = 200; // px in the dialog
const QR_DOWNLOAD_SIZE = 760; // hidden hi-res render — drawn into the share card
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
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/c/${carbonId}`
      : `/c/${carbonId}`;

  // The visible QR shows the live preview; the hidden one renders at a higher
  // size so the downloaded PNG stays crisp on every display, not just retina.
  const qrRef = React.useRef<HTMLCanvasElement>(null);
  const qrHiResRef = React.useRef<HTMLCanvasElement>(null);

  const copyLink = () => {
    navigator.clipboard.writeText(link);
    toast.success("link copied");
  };
  const copyId = () => {
    navigator.clipboard.writeText(carbonId);
    toast.success("Carbon ID copied");
  };

  const download = async () => {
    // Prefer the hi-res hidden canvas; fall back to the visible one if it
    // hasn't mounted yet (e.g. download invoked the exact tick the dialog opens).
    const qr = qrHiResRef.current ?? qrRef.current;
    if (!qr) return;
    try {
      await buildShareCard({ qr, carbonId, name, link });
      toast.success("share card downloaded");
    } catch {
      toast.error("download failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Share your chat</DialogTitle>
          <DialogDescription>
            Scan to start a conversation with you.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {/* QR on a beige card so it matches the rest of the interface. The
              inner padding keeps a clear quiet zone around the modules so
              scanners still pick it up reliably. */}
          <div className="border bg-card p-3">
            <QRCodeCanvas
              ref={qrRef}
              value={link}
              size={QR_DISPLAY_SIZE}
              bgColor={BG}
              fgColor={INK}
              level="H"
              marginSize={2}
              imageSettings={{
                src: "/logo.png",
                width: Math.round(QR_DISPLAY_SIZE * QR_LOGO_FRACTION),
                height: Math.round(QR_DISPLAY_SIZE * QR_LOGO_FRACTION),
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

          <Button onClick={download} className="mt-1 w-full">
            <DownloadSimple /> Download share card
          </Button>
        </div>

        {/* Hidden hi-res QR used only as the pixel source for the downloaded
            share card. Positioned offscreen rather than display:none so the
            canvas actually rasterizes its pixels. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-[-9999px] top-[-9999px]"
        >
          <QRCodeCanvas
            ref={qrHiResRef}
            value={link}
            size={QR_DOWNLOAD_SIZE}
            bgColor={BG}
            fgColor={INK}
            level="H"
            marginSize={2}
            imageSettings={{
              src: "/logo.png",
              width: Math.round(QR_DOWNLOAD_SIZE * QR_LOGO_FRACTION),
              height: Math.round(QR_DOWNLOAD_SIZE * QR_LOGO_FRACTION),
              excavate: true,
              crossOrigin: "anonymous",
            }}
          />
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
    <div className="w-full border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-1 label-mono text-[10px]">
        {icon}
        <span className="opacity-60">{label}</span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate font-mono text-xs">{value}</span>
        <Button size="icon" variant="ghost" aria-label={copyLabel} onClick={onCopy}>
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
 * Layout (logical px, 2× device scale for retina-sharp output):
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
  const W = 720;
  const H = 720;
  const SCALE = 2;
  const FRAME_INSET = 24;

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
  const logo = await loadImage("/logo.png");
  const logoH = 24;
  const logoW = (logo.width / logo.height) * logoH;
  const wordmark = "Silicon Interface";
  ctx.font = '500 13px "JetBrains Mono", ui-monospace, monospace';
  const wordW = ctx.measureText(wordmark).width;
  const eyebrowGap = 10;
  const eyebrowTotalW = logoW + eyebrowGap + wordW;
  const eyebrowX = (W - eyebrowTotalW) / 2;
  const eyebrowY = 64;
  ctx.drawImage(logo, eyebrowX, eyebrowY - logoH + 4, logoW, logoH);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.fillText(wordmark, eyebrowX + logoW + eyebrowGap, eyebrowY);

  // ---- QR — sits directly on the beige canvas, no card chrome around it
  const qrSize = 380;
  const qrX = (W - qrSize) / 2;
  const qrY = eyebrowY + 48;
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  // ---- Divider: hairline with a brand glyph in the middle. The middle gap
  // is a subtle decorative beat that breaks the rule cleanly without needing
  // extra ornaments.
  const dividerY = qrY + qrSize + 56;
  const dividerHalfW = 80;
  const dividerGap = 18;
  ctx.strokeStyle = BORDER;
  ctx.beginPath();
  ctx.moveTo(W / 2 - dividerHalfW, dividerY + 0.5);
  ctx.lineTo(W / 2 - dividerGap, dividerY + 0.5);
  ctx.moveTo(W / 2 + dividerGap, dividerY + 0.5);
  ctx.lineTo(W / 2 + dividerHalfW, dividerY + 0.5);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(W / 2, dividerY + 0.5, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // ---- Subtitle
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = '500 13px "TikTok Sans", -apple-system, "Segoe UI", sans-serif';
  ctx.fillText("scan to start a chat", W / 2, dividerY + 32);

  // ---- Identity block: optional display name → Carbon ID → link
  let cursorY = dividerY + 64;
  if (name && name.trim()) {
    ctx.fillStyle = INK;
    ctx.font = '600 22px "TikTok Sans", -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(name.trim(), W / 2, cursorY);
    cursorY += 30;
  }

  ctx.fillStyle = INK;
  ctx.font = '600 16px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(carbonId, W / 2, cursorY);
  cursorY += 28;

  ctx.fillStyle = MUTED;
  ctx.font = '500 12px "JetBrains Mono", ui-monospace, monospace';
  const maxLinkW = W - FRAME_INSET * 2 - 32;
  ctx.fillText(truncateMid(link, ctx, maxLinkW), W / 2, cursorY);

  // ---- Trigger download. Same-origin canvases aren't tainted → toDataURL OK.
  const dataUrl = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `silicon-interface-${carbonId}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
