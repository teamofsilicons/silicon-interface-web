/**
 * Canonical quiet window for text sent to a Silicon.
 *
 * Keep this in a dependency-free module so the composer, recovery paths, and
 * reliability tests all consume one contract instead of copying durations.
 */
export const SILICON_TEXT_HOLD_MS = 5_000;
export const SILICON_TEXT_HOLD_SECONDS = SILICON_TEXT_HOLD_MS / 1_000;

/**
 * New sends always use the five-second contract. Recovery may encounter a
 * durable intent written by the former ten-second client, so callers must
 * preserve its recorded deadline rather than silently sending it early.
 */
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
