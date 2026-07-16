"use client";

import { ApiError } from "./api";
import {
  readSyncRecovery,
  resolveSyncRecovery,
  writeSyncRecovery,
  type SyncRecoveryRecord,
} from "./chat-store";
import {
  SyncIntegrityError,
  type SyncIntegrityDetails,
  type SyncIntegrityReason,
  type SyncStream,
} from "./sync-integrity";

export const SYNC_RECOVERY_EVENT = "silicon:sync-recovery";
const currentRecords = new Map<string, SyncRecoveryRecord>();

export type SyncFailureDecision = {
  action: "resnapshot" | "retry";
  reason: SyncIntegrityReason;
  stream: SyncStream;
  details: SyncIntegrityDetails;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function safePosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Parse the only HTTP 410 response allowed to discard remote projections.
 * HTTP status, root code, finite stream/reason matrix, complete field types,
 * and reason-specific position relationships all form the authorization. */
export function validateResyncEvidence(
  status: number,
  body: unknown,
): SyncFailureDecision | null {
  if (status !== 410 || !isRecord(body) || !owns(body, "code") || body.code !== "resync_required") {
    return null;
  }
  if (!owns(body, "gap") || !isRecord(body.gap)) return null;
  const gap = body.gap;
  if (
    !owns(gap, "stream") || typeof gap.stream !== "string" ||
    !owns(gap, "reason") || typeof gap.reason !== "string" ||
    !owns(gap, "requested_position") ||
    !owns(gap, "minimum_position") ||
    !owns(gap, "current_position")
  ) {
    return null;
  }

  const requested = gap.requested_position;
  const minimum = gap.minimum_position;
  const current = gap.current_position;
  if (gap.stream === "initial" && gap.reason === "cursor_expired") {
    if (requested !== null || minimum !== null || current !== null) return null;
    return {
      action: "resnapshot",
      reason: "invalid_cursor",
      stream: "initial",
      details: {
        expectedPosition: undefined,
        observedPosition: undefined,
        throughPosition: undefined,
      },
    };
  }

  if (
    (gap.stream !== "events" && gap.stream !== "account") ||
    !["retention_floor", "cursor_ahead", "position_gap", "page_invariant"].includes(gap.reason) ||
    !safePosition(requested) || !safePosition(minimum) || !safePosition(current) ||
    minimum > current
  ) {
    return null;
  }
  const relationshipIsValid =
    gap.reason === "retention_floor"
      ? requested < minimum
      : gap.reason === "cursor_ahead"
        ? requested > current
        : minimum <= requested && requested <= current;
  if (!relationshipIsValid) return null;

  const reason: SyncIntegrityReason = gap.reason === "retention_floor"
    ? "retention_floor"
    : gap.reason === "cursor_ahead"
      ? "invalid_cursor"
      : "position_discontinuity";
  return {
    action: "resnapshot",
    reason,
    stream: gap.stream,
    details: {
      expectedPosition: minimum,
      observedPosition: requested,
      throughPosition: current,
    },
  };
}

/** Decide whether a failed page proves the remote checkpoint must be rebuilt. */
export function classifySyncFailure(
  error: unknown,
  fallbackStream: SyncStream = "events",
): SyncFailureDecision {
  if (error instanceof SyncIntegrityError) {
    return {
      action: "resnapshot",
      reason: error.reason,
      stream: error.stream,
      details: error.details,
    };
  }
  if (error instanceof ApiError) {
    const authorized = validateResyncEvidence(error.status, error.body);
    if (authorized) return authorized;
    if (
      error.status === 400 &&
      isRecord(error.body) &&
      owns(error.body, "code") &&
      error.body.code === "invalid_cursor" &&
      !owns(error.body, "gap")
    ) {
      return {
        action: "resnapshot",
        reason: "invalid_cursor",
        stream: fallbackStream,
        details: {},
      };
    }
  }
  return {
    action: "retry",
    reason: "transient_failure",
    stream: fallbackStream,
    details: {},
  };
}

function emit(record: SyncRecoveryRecord): void {
  currentRecords.set(record.ownerId, record);
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent(SYNC_RECOVERY_EVENT, { detail: record }));
  }
}

export async function syncRecoveryState(ownerId: string): Promise<SyncRecoveryRecord | null> {
  try {
    const durable = await readSyncRecovery(ownerId);
    if (durable) {
      const memory = currentRecords.get(ownerId);
      if (memory && memory.updatedAt >= durable.updatedAt && memory !== durable) {
        return memory;
      }
      currentRecords.set(ownerId, durable);
      return durable;
    }
  } catch {
    // The in-memory state still drives this window when diagnostics storage is
    // unavailable; checkpoint advancement remains independently fail closed.
  }
  return currentRecords.get(ownerId) ?? null;
}

export async function reportSyncRecovery(
  ownerId: string,
  incident: Omit<SyncFailureDecision, "action"> & {
    phase: "degraded" | "rebuilding";
  },
): Promise<SyncRecoveryRecord | null> {
  if (!ownerId) return null;
  const now = Date.now();
  const provisional: SyncRecoveryRecord = {
    ownerId,
    phase: incident.phase,
    reason: incident.reason,
    stream: incident.stream,
    details: incident.details,
    detectedAt: now,
    updatedAt: now,
    recoveredAt: null,
    occurrences: 1,
    revision: 0,
  };
  // Announce immediately; the strict IndexedDB commit below remains the
  // authority for reload recovery but must not delay accessible degraded UX.
  emit(provisional);
  try {
    const record = await writeSyncRecovery(ownerId, incident);
    emit(record);
    return record;
  } catch {
    // A failed diagnostic write must not hide the degraded state from the
    // current window. It also must not trigger destructive cache cleanup.
    return provisional;
  }
}

export async function reportSyncRecovered(
  ownerId: string,
  previous?: SyncRecoveryRecord | null,
  streams?: readonly SyncStream[],
): Promise<SyncRecoveryRecord | null> {
  if (!ownerId) return null;
  const incident = previous ?? await syncRecoveryState(ownerId);
  if (!incident || incident.phase === "recovered") return incident;
  if (streams && !streams.includes(incident.stream)) return incident;
  try {
    const record = await resolveSyncRecovery(ownerId, incident.revision);
    if (record?.phase === "recovered") emit(record);
    else if (!record && incident.revision === 0) {
      const now = Date.now();
      const recovered: SyncRecoveryRecord = {
        ...incident,
        phase: "recovered",
        updatedAt: now,
        recoveredAt: now,
        revision: 1,
      };
      emit(recovered);
      return recovered;
    }
    return record;
  } catch {
    if (incident.revision === 0) {
      const now = Date.now();
      const recovered: SyncRecoveryRecord = {
        ...incident,
        phase: "recovered",
        updatedAt: now,
        recoveredAt: now,
        revision: 1,
      };
      emit(recovered);
      return recovered;
    }
    return null;
  }
}
