import { geometryBBox } from "./annotation-coords";
import { MARKUP_COLOR, type Geometry } from "./annotation-types";

const COLOR_CANDIDATES = [
  MARKUP_COLOR,
  "#a8e6cf",
  "#f7b2d9",
  "#b9c8ff",
  "#004c6d",
  "#5b2c6f",
  "#6b341e",
  "#1b5e3f",
] as const;
const NEUTRAL_FALLBACKS = ["#111827", "#ffffff"] as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function colorDistance(candidate: Rgb, samples: Rgb[]): number {
  if (!samples.length) return 0;
  return samples.reduce(
    (total, sample) => total + Math.hypot(
      candidate.r - sample.r,
      candidate.g - sample.g,
      candidate.b - sample.b,
    ),
    0,
  ) / samples.length;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

async function readableImageUrl(src: string): Promise<{ src: string; revoke?: string }> {
  if (src.startsWith("data:") || src.startsWith("blob:")) return { src };
  try {
    const r = await fetch(src, { mode: "cors" });
    if (!r.ok) throw new Error(`fetch failed (${r.status})`);
    const revoke = URL.createObjectURL(await r.blob());
    return { src: revoke, revoke };
  } catch {
    return { src };
  }
}

function samplePixels(ctx: CanvasRenderingContext2D, w: number, h: number, geometry: Geometry): Rgb[] {
  const bb = geometryBBox(geometry);
  const pad = geometry.kind === "pin" ? 0.035 : 0.012;
  const x0 = Math.max(0, Math.floor((bb.x0 - pad) * w));
  const y0 = Math.max(0, Math.floor((bb.y0 - pad) * h));
  const x1 = Math.min(w - 1, Math.ceil((bb.x1 + pad) * w));
  const y1 = Math.min(h - 1, Math.ceil((bb.y1 + pad) * h));
  const sw = Math.max(1, x1 - x0 + 1);
  const sh = Math.max(1, y1 - y0 + 1);
  const data = ctx.getImageData(x0, y0, sw, sh).data;
  const samples: Rgb[] = [];
  const target = 360;
  const step = Math.max(1, Math.floor(Math.sqrt((sw * sh) / target)));
  for (let y = 0; y < sh; y += step) {
    for (let x = 0; x < sw; x += step) {
      const i = (y * sw + x) * 4;
      const a = data[i + 3] / 255;
      const r = Math.round(data[i] * a + 255 * (1 - a));
      const g = Math.round(data[i + 1] * a + 255 * (1 - a));
      const b = Math.round(data[i + 2] * a + 255 * (1 - a));
      samples.push({ r, g, b });
    }
  }
  return samples;
}

function chooseByContrast(samples: Rgb[]): string {
  if (!samples.length) return MARKUP_COLOR;
  const score = (candidate: string) => {
    const c = parseHex(candidate);
    let count = 0;
    let total = 0;
    for (const sample of samples) {
      const ratio = contrast(c, sample);
      total += ratio;
      if (ratio >= 7) count += 1;
    }
    return {
      candidate,
      count,
      average: total / samples.length,
      distance: colorDistance(c, samples),
    };
  };
  const colorful = COLOR_CANDIDATES.map(score);
  // Prefer a real marker color whenever it maintains AAA contrast across at
  // least 80% of the marked pixels. Black/white are safety fallbacks for busy
  // or mixed regions where no chromatic marker remains reliably readable.
  const strongColorExists = colorful.some((item) => item.count / samples.length >= 0.8);
  const pool = strongColorExists
    ? colorful
    : [...colorful, ...NEUTRAL_FALLBACKS.map(score)];
  pool.sort((a, b) =>
    b.count - a.count ||
    b.distance - a.distance ||
    b.average - a.average,
  );
  return pool[0]?.candidate ?? MARKUP_COLOR;
}

/**
 * Pick a markup color that contrasts with the actual pixels under the markup.
 * Mixed backgrounds are handled by majority: the winning candidate is the one
 * that clears the WCAG AAA contrast threshold for the most sampled pixels, with average
 * contrast as the tiebreaker.
 */
export async function chooseMarkupColor(opts: {
  imageSrc: string;
  geometry: Geometry;
}): Promise<string> {
  const readable = await readableImageUrl(opts.imageSrc);
  try {
    const img = await loadImage(readable.src);
    const maxSide = 360;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return MARKUP_COLOR;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return chooseByContrast(samplePixels(ctx, w, h, opts.geometry));
  } catch {
    return MARKUP_COLOR;
  } finally {
    if (readable.revoke) URL.revokeObjectURL(readable.revoke);
  }
}
