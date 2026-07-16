/**
 * A send must never look pending forever. Text falls back to durable recovery
 * quickly; media gets a full minute or the time its bytes would need on a
 * 1 Mb/s (125 KB/s) uplink.
 */
export const TEXT_SEND_TIMEOUT_MS = 12_000;
export const MIN_SEND_TIMEOUT_MS = 60_000;
export const ASSUMED_UPLOAD_BITS_PER_SECOND = 1_000_000;

export function sendTimeoutMs(sizeBytes = 0): number {
  const safeBytes = Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0;
  if (safeBytes === 0) return TEXT_SEND_TIMEOUT_MS;
  const uploadMs = Math.ceil(((safeBytes * 8) / ASSUMED_UPLOAD_BITS_PER_SECOND) * 1000);
  return Math.max(MIN_SEND_TIMEOUT_MS, uploadMs);
}
