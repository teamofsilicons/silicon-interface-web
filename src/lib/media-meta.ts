// Browser-side metadata extraction for uploads.
//
// • measureImage(file)  → { width, height }
// • computePeaks(blob)  → { duration_ms, peaks: number[] }
//
// Both return Promise<T | null> — we never block the upload on metadata,
// and a measurement failure just means the bubble gets the default
// placeholder treatment.
//
// Every path here is *bounded*: a decode that hangs (corrupt header, a codec
// the browser starts but never finishes) must never leave the composer's send
// button disabled forever. A timeout resolves to null so the upload completes
// with default placeholders rather than getting stuck.

/** Wall-clock cap on any single metadata decode. Beyond this we give up and
 *  let the bubble fall back to placeholder dimensions / no waveform. */
const META_TIMEOUT_MS = 8000;

/** computePeaks decodes the *entire* file into memory (PCM samples), so a very
 *  large or very long audio file can OOM the tab. Skip waveform extraction
 *  past these caps — the player still works, it just shows the synthesized
 *  fallback waveform. */
const PEAKS_MAX_BYTES = 25 * 1024 * 1024; // 25 MB compressed
const PEAKS_MAX_DURATION_MS = 20 * 60 * 1000; // 20 minutes

/** Identify a GIF from canonical MIME, with a filename fallback for legacy
 * events that predate the mime field. */
export function isGifMedia(mime: unknown, filename?: unknown): boolean {
  const normalizedMime = typeof mime === "string" ? mime.split(";", 1)[0].trim().toLowerCase() : "";
  if (normalizedMime === "image/gif") return true;
  return typeof filename === "string" && /\.gif$/i.test(filename.trim());
}

/** Decode an image enough to read its natural dimensions. */
export async function measureImage(
  file: File | Blob,
): Promise<{ width: number; height: number } | null> {
  if (!file || !file.type.startsWith("image/")) return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (
      out: { width: number; height: number } | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(out);
    };
    const timer = setTimeout(() => done(null), META_TIMEOUT_MS);
    const img = new Image();
    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

/** Decode video metadata (duration + dimensions). */
export async function measureVideo(
  file: File | Blob,
): Promise<{ width: number; height: number; duration_ms: number } | null> {
  if (!file || !file.type.startsWith("video/")) return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (
      out: { width: number; height: number; duration_ms: number } | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(out);
    };
    const timer = setTimeout(() => done(null), META_TIMEOUT_MS);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      done({
        width: v.videoWidth,
        height: v.videoHeight,
        duration_ms: Math.round((v.duration || 0) * 1000),
      });
    v.onerror = () => done(null);
    v.src = url;
  });
}

/**
 * Decode an audio blob and compress its samples into a fixed-count peaks
 * array (0..1 normalized) plus the duration in ms. Uses OfflineAudioContext
 * for fully-headless decoding — never touches the speakers.
 */
export async function computePeaks(
  blob: Blob,
  bucketCount = 60,
): Promise<{ duration_ms: number; peaks: number[] } | null> {
  if (!blob || typeof window === "undefined") return null;
  // Guard the memory blow-up: decoding a huge compressed blob expands to many
  // times its size as float PCM. Past the byte cap, skip waveform extraction
  // entirely — the player falls back to a synthesized waveform and still plays.
  if (blob.size > PEAKS_MAX_BYTES) return null;
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  // Declared outside the try so the catch can close it if the decode times
  // out — otherwise a timed-out context would leak.
  let ctx: AudioContext | null = null;
  try {
    const buf = await blob.arrayBuffer();
    ctx = new Ctor();
    // Bound the decode so a malformed/half-decodable blob can't hang here.
    const decoded = await Promise.race([
      ctx.decodeAudioData(buf.slice(0)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("decode timeout")), META_TIMEOUT_MS),
      ),
    ]);
    // Very long audio: still report duration (cheap), but skip the O(samples)
    // peak scan that would otherwise churn through tens of millions of floats.
    if (decoded.duration * 1000 > PEAKS_MAX_DURATION_MS) {
      const duration_ms = Math.round(decoded.duration * 1000);
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
      return { duration_ms, peaks: [] };
    }
    // Mono-mix every channel (max amplitude across channels) so the result
    // reads as the loudest envelope, not a single channel that happens to
    // be quieter.
    const channels = decoded.numberOfChannels;
    const length = decoded.length;
    const samplesPerBucket = Math.max(1, Math.floor(length / bucketCount));
    const peaks: number[] = new Array(bucketCount).fill(0);
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < bucketCount; i++) {
        const start = i * samplesPerBucket;
        const end = Math.min(start + samplesPerBucket, length);
        let peak = 0;
        for (let j = start; j < end; j++) {
          const v = Math.abs(data[j]);
          if (v > peak) peak = v;
        }
        if (peak > peaks[i]) peaks[i] = peak;
      }
    }
    // Normalize so the loudest moment hits 1.0 — the bars are a relative
    // shape, not an absolute level meter.
    let max = 0;
    for (const v of peaks) if (v > max) max = v;
    if (max > 0) {
      for (let i = 0; i < peaks.length; i++) peaks[i] = peaks[i] / max;
    }
    const duration_ms = Math.round(decoded.duration * 1000);
    try {
      await ctx.close();
    } catch {
      /* some browsers can't close offline contexts */
    }
    return { duration_ms, peaks: peaks.map((v) => Number(v.toFixed(3))) };
  } catch {
    // Close the context on the decode-timeout / decode-error path too so a
    // failed attempt doesn't leak an open AudioContext.
    try {
      await ctx?.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}
