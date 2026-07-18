// Tiny synthesized incoming-message tones. We use the Web Audio API instead
// of shipping .wav files, with no network cost or asset pipeline.
//
//  • "received" → soft descending tap   (~150ms, 880 → 600 Hz)
//
// Sound is governed solely by a per-user opt-out (`silicon-interface:sounds =
// "off"`). It is deliberately *decoupled* from prefers-reduced-motion: a user
// who disabled motion for vestibular reasons should not lose audio cues — those
// are separate accessibility axes with a separate preference key. AudioContext
// is lazily constructed and reused — browsers cap how many can exist at once.

let _ctx: AudioContext | null = null;
function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (_ctx) return _ctx;
  const Ctor =
    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    _ctx = new Ctor();
    return _ctx;
  } catch {
    return null;
  }
}

function enabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem("silicon-interface:sounds") === "off") return false;
  } catch {
    /* private mode etc — fine */
  }
  // NOTE: intentionally NOT gated on prefers-reduced-motion — see file header.
  return true;
}

// --- first-gesture primer -------------------------------------------------
// Browsers start the AudioContext in `suspended` state until a user gesture.
// resume() returns a promise; if we schedule the oscillator before it resolves,
// the very first beep is silently dropped. We prime (resume) on the first user
// gesture so the context is already running by the time the first message tone
// fires. This listener is installed lazily and removed after it runs once.
let _primed = false;
function primeOnce() {
  if (_primed || typeof window === "undefined") return;
  _primed = true;
  const ac = ctx();
  if (ac && ac.state === "suspended") ac.resume().catch(() => undefined);
}
if (typeof window !== "undefined") {
  const onGesture = () => {
    primeOnce();
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
  };
  window.addEventListener("pointerdown", onGesture, { once: true });
  window.addEventListener("keydown", onGesture, { once: true });
}

// --- throttle -------------------------------------------------------------
// A burst (e.g. 10 incoming messages in one tick) must not stack 10 overlapping
// tones. We coalesce: rapid calls within MIN_INTERVAL_MS collapse to a single
// audible beep. Stored per "kind" so a sent + received in the same window can
// still both play.
const MIN_INTERVAL_MS = 220;
const _lastPlayed: Record<string, number> = {};

function play(
  kind: string,
  start: number,
  end: number,
  durSec: number,
  vol: number,
  type: OscillatorType = "sine",
) {
  if (!enabled()) return;
  const now = Date.now();
  if (now - (_lastPlayed[kind] ?? 0) < MIN_INTERVAL_MS) return;
  _lastPlayed[kind] = now;

  const ac = ctx();
  if (!ac) return;
  // Never queue notification audio behind a suspended AudioContext. Browsers
  // may resolve resume() only on a much later user gesture; emitting from that
  // old promise makes a stale message sound appear randomly when nothing new
  // happened. Prime the context for future messages and drop this stale cue.
  if (ac.state === "suspended") {
    void ac.resume().catch(() => undefined);
    return;
  }
  emit(ac, start, end, durSec, vol, type);
}

function emit(
  ac: AudioContext,
  start: number,
  end: number,
  durSec: number,
  vol: number,
  type: OscillatorType,
) {
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(start, t0);
  osc.frequency.exponentialRampToValueAtTime(end, t0 + durSec);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.02);
}

// Carbons reply with a warm sine tap…
export function playReceived() {
  play("received", 880, 620, 0.16, 0.06, "sine");
}

// …and silicons with a subtly more *synthetic* timbre (triangle wave), so you
// hear who's talking without looking. Delights §3a.
export function playReceivedSilicon() {
  play("received", 760, 540, 0.18, 0.05, "triangle");
}

// Delights §3c — a feather-light haptic on send / record-start, gated by the
// same sound preference (a no-op where Vibration isn't supported, e.g. desktop).
export function vibrate(ms = 8) {
  if (!enabled()) return;
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(ms);
  } catch {
    /* unsupported — fine */
  }
}
