const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

export function validTraceparent(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  const match = TRACEPARENT.exec(normalized);
  if (!match || match[1] === "0".repeat(32) || match[2] === "0".repeat(16)) return "";
  return normalized;
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** A sampled opaque W3C root. It contains no user, room, message, or device data. */
export function newTraceparent(): string {
  let traceId = randomHex(16);
  let spanId = randomHex(8);
  // Defensive only: cryptographic randomness producing either all-zero value is
  // vanishingly unlikely, but W3C declares it invalid and we fail closed.
  while (traceId === "0".repeat(32)) traceId = randomHex(16);
  while (spanId === "0".repeat(16)) spanId = randomHex(8);
  return `00-${traceId}-${spanId}-01`;
}
