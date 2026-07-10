/**
 * A send must never look pending forever. Small sends get a full minute; large
 * media gets the time its bytes would need on a 1 MB/s uplink.
 */
export const MIN_SEND_TIMEOUT_MS = 60_000;
export const ASSUMED_UPLOAD_BYTES_PER_SECOND = 1_000_000;

export function sendTimeoutMs(sizeBytes = 0): number {
  const safeBytes = Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0;
  const uploadMs = Math.ceil((safeBytes / ASSUMED_UPLOAD_BYTES_PER_SECOND) * 1000);
  return Math.max(MIN_SEND_TIMEOUT_MS, uploadMs);
}
