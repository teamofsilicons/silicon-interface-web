/** Deterministically select missing valid parts despite duplicate/noisy provider state. */
export function missingMultipartParts(partCount: number, uploadedParts: number[]): number[] {
  const count = Math.max(0, Math.trunc(partCount));
  const uploaded = new Set(
    uploadedParts
      .map((part) => Math.trunc(part))
      .filter((part) => part >= 1 && part <= count),
  );
  return Array.from({ length: count }, (_, index) => index + 1).filter(
    (part) => !uploaded.has(part),
  );
}
