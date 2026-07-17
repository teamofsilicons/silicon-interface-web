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

export type MultipartPartSnapshot = {
  part_number: number;
  etag: string;
  checksum_sha256?: string;
};

/** Build the completion manifest from the provider's latest authoritative
 * part listing while verifying it still describes the exact locally retained
 * bytes. A concurrent same-message uploader may replace a part and therefore
 * change its ETag; the checksum, rather than that transient ETag, determines
 * whether it is safe to adopt the newer provider snapshot. */
export function verifiedMultipartCompletionParts(
  partCount: number,
  uploadedParts: MultipartPartSnapshot[],
  expectedChecksums: ReadonlyMap<number, string>,
): Array<{ part_number: number; etag: string; checksum_sha256: string }> {
  const count = Math.max(0, Math.trunc(partCount));
  const latest = new Map<number, MultipartPartSnapshot>();
  for (const part of uploadedParts) {
    const number = Math.trunc(part.part_number);
    if (number >= 1 && number <= count) latest.set(number, part);
  }
  const missing = missingMultipartParts(count, [...latest.keys()]);
  if (missing.length > 0) {
    throw new Error("object storage did not acknowledge every upload part");
  }
  return Array.from({ length: count }, (_, index) => index + 1).map((number) => {
    const part = latest.get(number)!;
    const expected = expectedChecksums.get(number);
    if (!expected) throw new Error(`local checksum is missing for upload part ${number}`);
    if (!part.etag?.trim()) throw new Error(`object storage returned no ETag for part ${number}`);
    if (part.checksum_sha256 && part.checksum_sha256 !== expected) {
      throw new Error(`object storage checksum did not match upload part ${number}`);
    }
    return {
      part_number: number,
      etag: part.etag,
      checksum_sha256: expected,
    };
  });
}
