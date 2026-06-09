"use client";

import * as React from "react";
import Link from "next/link";

// §7h — turn a dead end into a screenshot. Falling MarkSystem cells rain down a
// terminal field behind a mono `> 404 · route not found` line and a way back to
// /chat. Under prefers-reduced-motion we render a static field — same glyphs,
// no motion.
//
// This is the root app/not-found, so it also catches any unmatched URL. It runs
// inside the root layout, so the page chrome (beige canvas, fonts) is inherited.

// The brand glyph alphabet — the same cells `glyphAscii` emits for a mark, so
// the rain reads as MarkSystem debris rather than generic katakana.
const GLYPHS = ["█", "◤", "◥", "◢", "◣", "▮", "▯", "░", "▒", "▓"];
const BG = "#ede8e0"; // warm beige canvas
const INK = "#1a1a1a"; // near-black

export default function NotFound() {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const FONT = 18; // px cell size
    let raf = 0;
    let drops: number[] = [];
    let cols = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.max(1, Math.floor(w / FONT));
      // Each column starts at a random row so the field looks settled, not a
      // synchronized wave.
      drops = Array.from({ length: cols }, () => Math.floor(Math.random() * (h / FONT)));
      ctx.font = `${FONT}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = "top";
    };

    const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

    // Static field: one pass, faint ink, no animation.
    const drawStatic = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      const rows = Math.ceil(h / FONT);
      for (let c = 0; c < cols; c += 1) {
        for (let r = 0; r < rows; r += 1) {
          if (Math.random() < 0.5) continue; // sparse
          ctx.fillStyle = `rgba(26,26,26,${0.06 + Math.random() * 0.12})`;
          ctx.fillText(glyph(), c * FONT, r * FONT);
        }
      }
    };

    // Animated rain: translucent beige wash each frame leaves a fading trail,
    // a brighter leading cell drops down each column.
    const drawFrame = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.fillStyle = "rgba(237,232,224,0.16)"; // BG with alpha → trail fade
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < cols; i += 1) {
        const x = i * FONT;
        const y = drops[i] * FONT;
        // Leading cell brighter, trailing dimmer.
        ctx.fillStyle = "rgba(26,26,26,0.55)";
        ctx.fillText(glyph(), x, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        else drops[i] += 1;
      }
      raf = window.requestAnimationFrame(drawFrame);
    };

    resize();
    if (reduce) {
      drawStatic();
    } else {
      // Prime with a faint static base so the first frames aren't empty.
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      raf = window.requestAnimationFrame(drawFrame);
    }

    const onResize = () => {
      resize();
      if (reduce) drawStatic();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      <div className="relative z-10 flex flex-col items-center gap-4 border bg-background/80 px-8 py-6 text-center backdrop-blur-[1px]">
        <pre className="font-mono text-sm text-foreground" style={{ color: INK }}>
          &gt; 404 · route not found
        </pre>
        <Link
          href="/chat"
          className="font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          &gt; back to /chat
        </Link>
      </div>
    </main>
  );
}
