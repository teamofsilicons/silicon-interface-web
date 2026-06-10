import { glyphSvg, glyphAscii } from "./glyph";

export type MarkFamily = "carbon" | "silicon" | "team";

export function identiconSvg(seed: string, size = 256, family: MarkFamily = "carbon"): string {
  return glyphSvg(seed || "?", { size, family });
}

/** Delights §0b — the MarkSystem mark as an ASCII grid. */
export function identiconAscii(seed: string, family: MarkFamily = "carbon"): string {
  return glyphAscii(seed || "?", { family });
}

/**
 * No-op. The server now renders + stores a deterministic PNG mark when the
 * Carbon is created (see glass `apps/accounts/signals`), so the client no longer
 * uploads an SVG avatar — that diverged from Glass's render. The stored PNG is
 * loaded by every surface via `profile_photo_url`. Kept as a stable export so
 * the onboarding call site is unchanged.
 */
export async function generateAndStoreAvatar(_carbonId: string): Promise<string | null> {
  return null;
}
