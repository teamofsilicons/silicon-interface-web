"use client";

import {
  deleteSyncCursors,
  readSyncCheckpoint,
  readSyncCursors,
  writeSyncCheckpoint,
  writeSyncCursors,
  type SyncCheckpoint,
  type SyncCursors,
} from "./chat-store";

export type { SyncCheckpoint, SyncCursors };

const LEGACY_PREFIX = "silicon-interface:sync-cursors-v1";

function legacyKey(ownerId: string): string {
  return `${LEGACY_PREFIX}:${encodeURIComponent(ownerId)}`;
}

export async function getSyncCursors(ownerId: string): Promise<SyncCursors | null> {
  if (typeof window === "undefined" || !ownerId) return null;
  // Deliberately do not import the old localStorage checkpoint. Its timeline
  // database may have been evicted independently, so trusting it could skip
  // history. One fresh bounded snapshot safely establishes the v2 checkpoint.
  return readSyncCursors(ownerId);
}

export async function getSyncCheckpoint(ownerId: string): Promise<SyncCheckpoint | null> {
  if (typeof window === "undefined" || !ownerId) return null;
  return readSyncCheckpoint(ownerId);
}

export async function setSyncCursors(ownerId: string, cursors: SyncCursors): Promise<void> {
  if (typeof window === "undefined" || !ownerId) return;
  await writeSyncCursors(ownerId, cursors);
  try { window.localStorage.removeItem(legacyKey(ownerId)); } catch { /* best effort */ }
}

export async function setSyncCheckpoint(
  ownerId: string,
  checkpoint: SyncCheckpoint,
): Promise<void> {
  if (typeof window === "undefined" || !ownerId) return;
  await writeSyncCheckpoint(ownerId, checkpoint);
  try { window.localStorage.removeItem(legacyKey(ownerId)); } catch { /* best effort */ }
}

export async function clearSyncCursors(ownerId: string, signal?: AbortSignal): Promise<void> {
  if (typeof window === "undefined" || !ownerId) return;
  await deleteSyncCursors(ownerId, signal);
  try { window.localStorage.removeItem(legacyKey(ownerId)); } catch { /* best effort */ }
}
