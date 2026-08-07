/** Legacy quiet-window timing retained only for already-staged held sends. */
export const SILICON_TEXT_HOLD_MS = 5_000;
export const SILICON_TEXT_HOLD_SECONDS = SILICON_TEXT_HOLD_MS / 1_000;

/** New Silicon text messages use the normal immediate-send path. */
export const DELAY_NEW_SILICON_TEXT_SENDS = false;

/** Recovery can also encounter a durable intent from the former ten-second client. */
export const LEGACY_SILICON_TEXT_HOLD_SECONDS = 10;

export function siliconHoldReleaseAt(nowMs: number): string {
  return new Date(nowMs + SILICON_TEXT_HOLD_MS).toISOString();
}

export function recoveredSiliconHoldSeconds(
  releaseAt: string | undefined,
  nowMs: number,
): number {
  const deadline = releaseAt ? Date.parse(releaseAt) : Number.NaN;
  const remainingMs = Number.isFinite(deadline) ? deadline - nowMs : 1_000;
  return Math.max(
    1,
    Math.min(LEGACY_SILICON_TEXT_HOLD_SECONDS, Math.ceil(remainingMs / 1_000)),
  );
}
