"use client";

export const MAX_CACHED_MEDIA_HASHES = 100;
const STORAGE_PREFIX = "silicon-interface:media-hash-cache:v1:";

export interface MediaDigest {
  hex: string;
  base64: string;
}

export interface CachedMediaHash {
  sha256: string;
  mediaId: string;
  roomId: string;
  size: number;
  mime: string;
  kind: "image" | "file";
  lastUsedAt: number;
}

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerId}`;
}

function validEntry(value: unknown): value is CachedMediaHash {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CachedMediaHash>;
  return (
    typeof row.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(row.sha256) &&
    typeof row.mediaId === "string" &&
    row.mediaId.length > 0 &&
    typeof row.roomId === "string" &&
    row.roomId.length > 0 &&
    typeof row.size === "number" &&
    Number.isFinite(row.size) &&
    row.size >= 0 &&
    typeof row.mime === "string" &&
    (row.kind === "image" || row.kind === "file") &&
    typeof row.lastUsedAt === "number" &&
    Number.isFinite(row.lastUsedAt)
  );
}

function read(ownerId: string): CachedMediaHash[] {
  if (typeof window === "undefined" || !ownerId) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(ownerId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validEntry).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_CACHED_MEDIA_HASHES);
  } catch {
    return [];
  }
}

function write(ownerId: string, rows: CachedMediaHash[]): void {
  if (typeof window === "undefined" || !ownerId) return;
  try {
    window.localStorage.setItem(
      storageKey(ownerId),
      JSON.stringify(
        rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, MAX_CACHED_MEDIA_HASHES),
      ),
    );
  } catch {
    // Hash reuse is an optimization. Local storage pressure must never block
    // the upload or message send path.
  }
}

function binaryBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

export async function hashMediaBlob(blob: Blob): Promise<MediaDigest> {
  const digest = new Uint8Array(
    await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  return {
    hex: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""),
    base64: binaryBase64(digest),
  };
}

export function cachedMediaForHash(input: {
  ownerId: string;
  roomId: string;
  digest: MediaDigest;
  size: number;
  mime: string;
  kind: "image" | "file";
}): CachedMediaHash | null {
  return read(input.ownerId).find((row) =>
    row.roomId === input.roomId &&
    row.sha256 === input.digest.hex &&
    row.size === input.size &&
    row.mime === input.mime &&
    row.kind === input.kind
  ) ?? null;
}

export function rememberCachedMedia(input: {
  ownerId: string;
  roomId: string;
  digest: MediaDigest;
  mediaId: string;
  size: number;
  mime: string;
  kind: "image" | "file";
  at?: number;
}): void {
  const next: CachedMediaHash = {
    sha256: input.digest.hex,
    mediaId: input.mediaId,
    roomId: input.roomId,
    size: input.size,
    mime: input.mime,
    kind: input.kind,
    lastUsedAt: input.at ?? Date.now(),
  };
  write(input.ownerId, [
    next,
    ...read(input.ownerId).filter((row) =>
      !(row.roomId === input.roomId && row.sha256 === input.digest.hex),
    ),
  ]);
}

export function forgetCachedMedia(ownerId: string, roomId: string, sha256: string): void {
  write(
    ownerId,
    read(ownerId).filter((row) => !(row.roomId === roomId && row.sha256 === sha256)),
  );
}

export function clearCachedMediaHashes(ownerId: string): void {
  if (typeof window === "undefined" || !ownerId) return;
  try {
    window.localStorage.removeItem(storageKey(ownerId));
  } catch {
    // Best-effort account cleanup.
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("silicon-interface:auth-clear", (event) => {
    const ownerKey = (event as CustomEvent<{ ownerKey?: string | null }>).detail?.ownerKey;
    if (ownerKey?.startsWith("carbon:")) clearCachedMediaHashes(ownerKey.slice("carbon:".length));
  });
}
