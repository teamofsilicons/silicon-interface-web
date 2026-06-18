"use client";

import * as React from "react";
import { Copy, CircleNotch, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { QRCodeCanvas } from "qrcode.react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { Invite } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Brand tokens — literals so the downloaded PNG matches the in-app card.
const BG = "#ede8e0";
const INK = "#1a1a1a";
const BORDER = "#d4cfc7";
const MUTED = "#666666";

const QR_DISPLAY = 168;
const QR_RENDER = 960; // backing pixels for retina display + download
const QR_LOGO_FRACTION = 0.22; // logo edge ÷ qr edge (level-H tolerates it)

/**
 * Generate + show a link invite scoped to a single silicon — a scannable QR
 * (brand mark in the centre), the link + 4-digit code, and a downloadable
 * branded share card. Whoever accepts joins the silicon's owner team.
 */
export function SiliconInviteDialog({
  open,
  onOpenChange,
  teamSlug,
  siliconId,
  siliconName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  teamSlug: string;
  siliconId: string;
  siliconName: string;
}) {
  const [invite, setInvite] = React.useState<Invite | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const qrRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    if (!open) {
      setInvite(null);
      setError("");
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    api
      .createInvite(teamSlug, { scope: "silicon", silicon_id: siliconId, channel: "link" })
      .then((inv) => {
        if (alive) setInvite(inv);
      })
      .catch((e) => {
        if (alive) {
          setError(
            e instanceof ApiError ? e.message : "Couldn't create an invite for this silicon.",
          );
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, teamSlug, siliconId]);

  const link = invite
    ? `${typeof window === "undefined" ? "" : window.location.origin}/join/${invite.token}?code=${invite.code}`
    : "";

  const download = async () => {
    const qr = qrRef.current;
    if (!qr || !invite) {
      toast.error("share card not ready yet - try again in a moment");
      return;
    }
    try {
      await buildInviteCard({ qr, siliconId, siliconName, link, code: invite.code });
      toast.success("share card downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "download failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm overflow-hidden">
        <DialogHeader>
          <DialogTitle>Invite to @{siliconName}</DialogTitle>
          <DialogDescription>
            Anyone who accepts this link joins{" "}
            <span className="font-medium text-foreground">@{siliconName}</span> and can chat with it.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid place-items-center py-12 text-muted-foreground">
            <CircleNotch className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <p className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : invite ? (
          <div className="flex min-w-0 flex-col items-center gap-3">
            {/* QR with the brand mark in the centre, on a beige card. */}
            <div className="border bg-card p-3">
              <QRCodeCanvas
                ref={qrRef}
                value={link}
                size={QR_RENDER}
                bgColor={BG}
                fgColor={INK}
                level="H"
                marginSize={2}
                style={{ width: QR_DISPLAY, height: QR_DISPLAY }}
                imageSettings={{
                  src: "/logo-qr.svg",
                  width: Math.round(QR_RENDER * QR_LOGO_FRACTION),
                  height: Math.round(QR_RENDER * QR_LOGO_FRACTION),
                  excavate: true,
                  crossOrigin: "anonymous",
                }}
              />
            </div>

            <div className="flex w-full min-w-0 items-center gap-2 border bg-background px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  navigator.clipboard.writeText(link);
                  toast.success("invite link copied");
                }}
                aria-label="copy invite link"
              >
                <Copy />
              </Button>
            </div>
            <div className="flex w-full items-center justify-between border bg-background px-3 py-2">
              <span className="label-mono text-[10px] text-muted-foreground">code</span>
              <span className="font-mono text-xl font-semibold tracking-wider">{invite.code}</span>
            </div>

            <Button onClick={download} className="mt-1 w-full">
              <DownloadSimple /> Download share card
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Download composite
// ---------------------------------------------------------------------------

interface BuildArgs {
  qr: HTMLCanvasElement;
  siliconId: string;
  siliconName: string;
  link: string;
  code: string;
}

/** Render a branded silicon-invite share card and trigger a PNG download. */
async function buildInviteCard({ qr, siliconId, siliconName, link, code }: BuildArgs): Promise<void> {
  const W = 1080;
  const H = 1080;
  const SCALE = 3;
  const FRAME_INSET = 36;

  if (typeof document !== "undefined" && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* draw with whatever's available */
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(FRAME_INSET + 0.5, FRAME_INSET + 0.5, W - FRAME_INSET * 2, H - FRAME_INSET * 2);

  // Eyebrow: logo + wordmark, centered near the top.
  const logo = await loadImage("/logo.svg").catch(() => null);
  const logoH = 36;
  const logoW = logo ? (logo.width / logo.height) * logoH : 0;
  const wordmark = "Silicon Interface";
  ctx.font = '500 20px "JetBrains Mono", ui-monospace, monospace';
  const wordW = ctx.measureText(wordmark).width;
  const eyebrowGap = logo ? 16 : 0;
  const eyebrowX = (W - (logoW + eyebrowGap + wordW)) / 2;
  const eyebrowY = 96;
  if (logo) ctx.drawImage(logo, eyebrowX, eyebrowY - logoH + 6, logoW, logoH);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.fillText(wordmark, eyebrowX + logoW + eyebrowGap, eyebrowY);

  // QR.
  const qrSize = 570;
  const qrX = (W - qrSize) / 2;
  const qrY = eyebrowY + 72;
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  // Divider with brand dot.
  const dividerY = qrY + qrSize + 84;
  const halfW = 120;
  const gap = 26;
  ctx.strokeStyle = BORDER;
  ctx.beginPath();
  ctx.moveTo(W / 2 - halfW, dividerY + 0.5);
  ctx.lineTo(W / 2 - gap, dividerY + 0.5);
  ctx.moveTo(W / 2 + gap, dividerY + 0.5);
  ctx.lineTo(W / 2 + halfW, dividerY + 0.5);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(W / 2, dividerY + 0.5, 4, 0, Math.PI * 2);
  ctx.fill();

  // Subtitle + identity block.
  const maxW = W - FRAME_INSET * 2 - 48;
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = '500 20px "TikTok Sans", -apple-system, "Segoe UI", sans-serif';
  ctx.fillText("scan to join", W / 2, dividerY + 48);

  let cursorY = dividerY + 96;
  ctx.fillStyle = INK;
  ctx.font = '600 34px "TikTok Sans", -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(truncateEnd(`@${siliconName}`, ctx, maxW), W / 2, cursorY);
  cursorY += 46;

  ctx.fillStyle = INK;
  ctx.font = '600 24px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(`code ${code}`, W / 2, cursorY);
  cursorY += 42;

  ctx.fillStyle = MUTED;
  ctx.font = '500 18px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(truncateMid(link, ctx, maxW), W / 2, cursorY);

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    throw new Error("couldn't export the share card - try the copy-link button instead.");
  }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `silicon-invite-${siliconId}.png`;
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

function truncateMid(s: string, ctx: CanvasRenderingContext2D, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (hi - lo > 2) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…${s.slice(s.length - mid)}`).width <= maxW) lo = mid;
    else hi = mid;
  }
  return `${s.slice(0, lo)}…${s.slice(s.length - lo)}`;
}
