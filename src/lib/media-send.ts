"use client";

import { api } from "./api";
import { uploadMediaResumable } from "./media-upload";
import {
  listOwnerMediaUploads,
  patchMediaUpload,
  readMediaUpload,
  removeMediaUpload,
  stageMediaUpload,
} from "./media-upload-store";
import {
  ackOutbox,
  cancelPendingOutbox,
  commitOutboxCorrection,
  discardOutbox,
  enqueueOutbox,
  listOutbox,
  outboxTerminalState,
  updateOutbox,
  type OutboxEntry,
} from "./outbox";
import { reportStorageIssue } from "./storage-health";
import type { Event } from "./types";

export const MEDIA_OUTBOX_STAGED_EVENT = "silicon:media-outbox-staged";
export const MEDIA_OUTBOX_ACKNOWLEDGED_EVENT = "silicon:media-outbox-acknowledged";

export interface StageMediaSendInput {
  outboxOwnerId: string;
  mediaOwnerId: string;
  roomId: string;
  clientId: string;
  /** Optional only when this client ID already owns a durable upload row. */
  blob?: Blob;
  kind: "image" | "file" | "voice";
  type: string;
  filename: string;
  mime: string;
  optimisticContent: Record<string, unknown>;
  eventContent?: Record<string, unknown>;
  completionMeta?: Record<string, unknown>;
  transcribe?: boolean;
  replyTo?: string;
  at?: number;
}

export interface StageUploadedMediaSendInput {
  outboxOwnerId: string;
  mediaOwnerId: string;
  roomId: string;
  clientId: string;
  mediaId: string;
  size: number;
  kind: "image" | "file";
  type: string;
  filename: string;
  mime: string;
  optimisticContent: Record<string, unknown>;
  eventContent?: Record<string, unknown>;
  replyTo?: string;
  at?: number;
}

interface StageDependencies {
  read: typeof readMediaUpload;
  stage: typeof stageMediaUpload;
  enqueue: typeof enqueueOutbox;
}

const stageDefaults: StageDependencies = {
  read: readMediaUpload,
  stage: stageMediaUpload,
  enqueue: enqueueOutbox,
};

/** Transfer a media object that already crossed object-storage completion into
 * the durable event outbox. The composer already owns the immutable media id,
 * byte size, and retained recovery row, so this path deliberately performs no
 * Blob/IndexedDB read and no second upload preparation. */
export async function stageUploadedMediaSendIntent(
  input: StageUploadedMediaSendInput,
  enqueue: typeof enqueueOutbox = enqueueOutbox,
): Promise<OutboxEntry> {
  if (!input.outboxOwnerId || input.mediaOwnerId !== `carbon:${input.outboxOwnerId}`) {
    throw new Error("A bound owner is required for a durable media send");
  }
  if (!input.mediaId || !Number.isFinite(input.size) || input.size < 0) {
    throw new Error("uploaded media identity is incomplete");
  }
  const entry: OutboxEntry = {
    roomId: input.roomId,
    clientId: input.clientId,
    operation: "media",
    type: input.type,
    body: "",
    content: {
      ...input.optimisticContent,
      media_id: input.mediaId,
    },
    replyTo: input.replyTo,
    at: input.at ?? Date.now(),
    media: {
      ownerId: input.mediaOwnerId,
      sourceClientId: input.clientId,
      uploadClientId: input.clientId,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      size: input.size,
      eventContent: input.eventContent,
      uploadedMediaId: input.mediaId,
      phase: "staged",
    },
  };
  return enqueue(input.outboxOwnerId, entry);
}

/** Commit bytes first, then the immutable send intent. Callers may only add an
 * optimistic bubble, close a picker, or start network work after this resolves.
 * If the second commit fails the staged Blob is intentionally retained. */
export async function stageMediaSendIntent(
  input: StageMediaSendInput,
  dependencies: StageDependencies = stageDefaults,
): Promise<OutboxEntry> {
  if (!input.outboxOwnerId || input.mediaOwnerId !== `carbon:${input.outboxOwnerId}`) {
    throw new Error("A bound owner is required for a durable media send");
  }
  const existing = await dependencies.read(input.mediaOwnerId, input.clientId).catch(() => null);
  if (existing) {
    if (
      existing.roomId !== input.roomId ||
      existing.name !== input.filename ||
      existing.mime !== input.mime ||
      existing.kind !== input.kind ||
      (input.blob && existing.size !== input.blob.size)
    ) {
      throw new Error("media client id was reused with a different payload");
    }
  } else {
    if (!input.blob) throw new Error("durable media source is missing");
    await dependencies.stage({
      ownerId: input.mediaOwnerId,
      roomId: input.roomId,
      clientId: input.clientId,
      outboxClientId: input.clientId,
      name: input.filename,
      mime: input.mime,
      kind: input.kind,
      size: input.blob.size,
      blob: input.blob,
    });
  }
  const size = existing?.size ?? input.blob?.size;
  if (size == null) throw new Error("durable media source is missing");
  const uploadedMediaId = existing?.mediaId ?? (
    typeof input.optimisticContent.media_id === "string"
      ? input.optimisticContent.media_id
      : null
  );
  const entry: OutboxEntry = {
    roomId: input.roomId,
    clientId: input.clientId,
    operation: "media",
    type: input.type,
    body: "",
    content: {
      ...input.optimisticContent,
      ...(uploadedMediaId ? { media_id: uploadedMediaId } : {}),
    },
    replyTo: input.replyTo,
    at: input.at ?? Date.now(),
    media: {
      ownerId: input.mediaOwnerId,
      sourceClientId: input.clientId,
      uploadClientId: input.clientId,
      kind: input.kind,
      filename: input.filename,
      mime: input.mime,
      size,
      eventContent: input.eventContent,
      completionMeta: input.completionMeta,
      transcribe: input.transcribe,
      ...(uploadedMediaId ? { uploadedMediaId } : {}),
      phase: "staged",
    },
  };
  return dependencies.enqueue(input.outboxOwnerId, entry);
}

export interface JournalRemoteGifInput {
  outboxOwnerId: string;
  mediaOwnerId: string;
  roomId: string;
  clientId: string;
  gifId: string;
  sourceUrl: string;
  title: string;
  filename: string;
  width: number;
  height: number;
  replyTo?: string;
  at?: number;
}

/** The click itself is durable before source acquisition. A renderer killed
 * during fetch/Blob decode restarts from this exact provider URL and metadata. */
export async function journalRemoteGifIntent(
  input: JournalRemoteGifInput,
): Promise<OutboxEntry> {
  if (!input.outboxOwnerId || input.mediaOwnerId !== `carbon:${input.outboxOwnerId}`) {
    throw new Error("A bound owner is required for a durable GIF send");
  }
  const entry: OutboxEntry = {
    roomId: input.roomId,
    clientId: input.clientId,
    operation: "media",
    type: "m.image",
    body: "",
    content: {
      acquiring: true,
      mime: "image/gif",
      filename: input.filename,
      width: input.width,
      height: input.height,
    },
    replyTo: input.replyTo,
    at: input.at ?? Date.now(),
    media: {
      ownerId: input.mediaOwnerId,
      sourceClientId: input.clientId,
      uploadClientId: input.clientId,
      kind: "image",
      filename: input.filename,
      mime: "image/gif",
      size: 0,
      eventContent: { width: input.width, height: input.height },
      completionMeta: { width: input.width, height: input.height },
      phase: "acquiring",
      acquisition: {
        provider: "giphy",
        id: input.gifId,
        url: input.sourceUrl,
        title: input.title,
        width: input.width,
        height: input.height,
      },
    },
  };
  return enqueueOutbox(input.outboxOwnerId, entry);
}

interface AcquisitionDependencies {
  read: typeof readMediaUpload;
  stage: typeof stageMediaUpload;
  update: typeof updateOutbox;
  fetchSource: (url: string) => Promise<Blob>;
}

async function fetchRemoteSource(url: string): Promise<Blob> {
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`GIF download failed (${response.status})`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("GIF source returned an empty file");
  return blob.type === "image/gif" ? blob : new Blob([blob], { type: "image/gif" });
}

const acquisitionDefaults: AcquisitionDependencies = {
  read: readMediaUpload,
  stage: stageMediaUpload,
  update: updateOutbox,
  fetchSource: fetchRemoteSource,
};

/** Crash-safe two-phase handoff. Bytes commit first. Only then does the
 * outbox revision move from acquiring to staged. If that second commit fails,
 * the original acquisition intent remains replayable and the staged bytes are
 * retained, so there is no state in which both recovery authorities disappear. */
export async function ensureMediaOutboxStaged(
  outboxOwnerId: string,
  entry: OutboxEntry,
  dependencies: AcquisitionDependencies = acquisitionDefaults,
): Promise<OutboxEntry> {
  if (entry.operation !== "media" || !entry.media) {
    throw new Error("outbox row is not a durable media send");
  }
  const sourceClientId = entry.media.sourceClientId ?? entry.clientId;
  let stored = await dependencies.read(entry.media.ownerId, sourceClientId).catch(() => null);
  let media = entry.media;
  if (!stored) {
    const acquisition = media.acquisition;
    if (!acquisition) throw new Error("durable media source is missing");
    const blob = await dependencies.fetchSource(acquisition.url);
    stored = await dependencies.stage({
      ownerId: media.ownerId,
      roomId: entry.roomId,
      clientId: sourceClientId,
      outboxClientId: entry.clientId,
      name: media.filename,
      mime: blob.type || media.mime,
      kind: media.kind,
      size: blob.size,
      blob,
    });
  }
  // Recovery may find bytes from a crash/abort between the two phases. Finish
  // the outbox handoff from those exact stored bytes instead of fetching again
  // or comparing them against the acquiring placeholder's size=0.
  if (media.phase === "acquiring" || media.size === 0) {
    if (!stored) throw new Error("durable media source is missing");
    if (
      stored.roomId !== entry.roomId ||
      stored.name !== media.filename ||
      stored.kind !== media.kind
    ) {
      throw new Error("durable media source does not match its acquisition intent");
    }
    media = {
      ...media,
      mime: stored.mime,
      size: stored.size,
      phase: "staged",
    };
    const content = {
      ...(entry.content ?? {}),
      acquiring: false,
      mime: stored.mime,
      filename: stored.name,
    };
    const committed = await dependencies.update(outboxOwnerId, entry.clientId, {
      media,
      content,
      state: "queued",
      nextAttemptAt: Date.now(),
      lastError: undefined,
    });
    if (!committed) {
      throw new Error("GIF bytes were saved, but their send handoff is waiting for storage recovery");
    }
    entry = { ...entry, media, content, state: "queued", lastError: undefined };
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(MEDIA_OUTBOX_STAGED_EVENT, {
          detail: { ownerId: outboxOwnerId, entry },
        }),
      );
    }
  }
  if (
    stored.roomId !== entry.roomId ||
    stored.name !== media.filename ||
    stored.kind !== media.kind ||
    (media.size > 0 && stored.size !== media.size)
  ) {
    throw new Error("durable media source does not match its outbox intent");
  }
  return entry;
}

export interface PreparedMediaPayload {
  type: string;
  content: Record<string, unknown>;
  reply_to_event_id?: string;
}

/** Build the final event directly from an upload that already crossed the
 * object-storage completion boundary. The stable media id is journaled; short-
 * lived S3 presigns remain a presentation concern and are never persisted. */
export function preparedUploadedMediaPayload(
  entry: OutboxEntry,
): PreparedMediaPayload | null {
  if (entry.operation !== "media" || !entry.media) return null;
  const mediaId = entry.media.uploadedMediaId ?? (
    typeof entry.content?.media_id === "string" ? entry.content.media_id : null
  );
  if (!mediaId) return null;
  return {
    type: entry.type ?? (
      entry.media.kind === "image"
        ? "m.image"
        : entry.media.kind === "voice"
          ? "m.voice"
          : "m.file"
    ),
    content: {
      ...(entry.media.eventContent ?? {}),
      ...(entry.content ?? {}),
      media_id: mediaId,
      mime: entry.media.mime,
      filename: entry.media.filename,
    },
    ...(entry.replyTo ? { reply_to_event_id: entry.replyTo } : {}),
  };
}

interface PrepareDependencies {
  ensure: typeof ensureMediaOutboxStaged;
  read: typeof readMediaUpload;
  upload: typeof uploadMediaResumable;
  transcribe: (mediaId: string) => Promise<string>;
}

async function transcribeVoice(mediaId: string): Promise<string> {
  await api.stt({ media_id: mediaId });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const detail = await api.mediaDetail(mediaId);
    if (detail.media.transcription_status === "ready") return detail.media.transcript;
    if (detail.media.transcription_status === "failed") {
      throw new Error("voice transcription failed - tap retry to try again");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  throw new Error("voice transcription is taking longer than usual - tap retry shortly");
}

const prepareDefaults: PrepareDependencies = {
  ensure: ensureMediaOutboxStaged,
  read: readMediaUpload,
  upload: uploadMediaResumable,
  transcribe: transcribeVoice,
};

/** Resume the staged transfer and deterministically build the event payload.
 * The source row is not removed here; it remains the recovery authority until
 * acknowledgeMediaSend confirms that an outbox tombstone committed. */
export async function prepareMediaOutboxPayload(
  outboxOwnerId: string,
  entry: OutboxEntry,
  dependencies: PrepareDependencies = prepareDefaults,
  onProgress?: (pct: number, loaded: number) => void,
  xhrRef?: { current: XMLHttpRequest | null },
  signal?: AbortSignal,
): Promise<PreparedMediaPayload> {
  entry = await dependencies.ensure(outboxOwnerId, entry);
  if (entry.operation !== "media" || !entry.media) {
    throw new Error("outbox row is not a durable media send");
  }
  const spec = entry.media;
  const sourceClientId = spec.sourceClientId ?? entry.clientId;
  const stored = await dependencies.read(spec.ownerId, sourceClientId);
  if (!stored) throw new Error("durable media source is missing");
  if (
    stored.roomId !== entry.roomId ||
    stored.name !== spec.filename ||
    stored.mime !== spec.mime ||
    stored.kind !== spec.kind ||
    stored.size !== spec.size
  ) {
    throw new Error("durable media source does not match its outbox intent");
  }
  const uploadedPayload = preparedUploadedMediaPayload(entry);
  const uploadedMediaId = uploadedPayload?.content.media_id;
  if (
    uploadedPayload &&
    typeof uploadedMediaId === "string" &&
    stored.mediaId === uploadedMediaId &&
    (stored.state === "completed" || stored.state === "cleanup")
  ) {
    return uploadedPayload;
  }
  const mediaId = await dependencies.upload({
    clientId: spec.uploadClientId ?? entry.clientId,
    outboxClientId: entry.clientId,
    sourceClientId,
    file: stored.blob ?? undefined,
    filename: spec.filename,
    mime: spec.mime,
    kind: spec.kind,
    roomId: entry.roomId,
    meta: spec.completionMeta,
    retainSourceUntilEventAck: true,
    onProgress,
    xhrRef,
    signal,
  });
  // Voice delivery is authoritative once its bytes reach Glass. Older durable
  // outbox rows may still carry the retired `transcribe: true` flag; ignore it
  // for voice so retrying a pre-release failure cannot be blocked by STT.
  const transcript = spec.transcribe && spec.kind !== "voice"
    ? await dependencies.transcribe(mediaId)
    : null;
  return {
    type: entry.type ?? (spec.kind === "image" ? "m.image" : spec.kind === "voice" ? "m.voice" : "m.file"),
    content: {
      ...(spec.eventContent ?? {}),
      media_id: mediaId,
      mime: spec.mime,
      filename: spec.filename,
      ...(transcript != null ? { transcript } : {}),
    },
    ...(entry.replyTo ? { reply_to_event_id: entry.replyTo } : {}),
  };
}

interface AcknowledgeDependencies {
  markCleanup: typeof patchMediaUpload;
  acknowledge: typeof ackOutbox;
  remove: typeof removeMediaUpload;
  report: typeof reportStorageIssue;
}

const acknowledgeDefaults: AcknowledgeDependencies = {
  markCleanup: patchMediaUpload,
  acknowledge: ackOutbox,
  remove: removeMediaUpload,
  report: reportStorageIssue,
};

/** Metadata and retained bytes are deleted only after at least one strict
 * acknowledgement tombstone commits. Cleanup failure is non-destructive. */
export async function acknowledgeMediaSend(
  outboxOwnerId: string,
  entry: OutboxEntry,
  dependencies: AcknowledgeDependencies = acknowledgeDefaults,
  accepted?: { roomId: string; event: Event },
): Promise<boolean> {
  if (entry.operation !== "media" || !entry.media) {
    return dependencies.acknowledge(outboxOwnerId, entry.clientId, accepted);
  }
  try {
    const sourceClientId = entry.media.sourceClientId ?? entry.clientId;
    await dependencies.markCleanup(entry.media.ownerId, sourceClientId, { state: "cleanup" });
  } catch {
    dependencies.report({
      severity: "degraded",
      area: "media",
      message:
        "The message was accepted, but media cleanup could not be journaled. Its idempotent event remains queued until storage recovers.",
    });
    return false;
  }
  const acknowledged = await dependencies.acknowledge(
    outboxOwnerId,
    entry.clientId,
    accepted,
  );
  if (!acknowledged) return false;
  try {
    await dependencies.remove(
      entry.media.ownerId,
      entry.media.sourceClientId ?? entry.clientId,
    );
  } catch {
    dependencies.report({
      severity: "degraded",
      area: "media",
      message:
        "Sent media is waiting for local cleanup. It will not be uploaded or sent again.",
    });
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(
      new CustomEvent(MEDIA_OUTBOX_ACKNOWLEDGED_EVENT, {
        detail: { ownerId: outboxOwnerId, clientId: entry.clientId },
      }),
    );
  }
  return true;
}

/** A user discard is committed as its own terminal outbox fact before source
 * bytes are touched. A cleanup failure is recoverable and can never resurrect
 * the send intent or hide it before the tombstone exists. */
export async function discardMediaSend(
  outboxOwnerId: string,
  entry: OutboxEntry,
): Promise<boolean> {
  if (!(await discardOutbox(outboxOwnerId, entry.clientId))) return false;
  if (entry.operation !== "media" || !entry.media) return true;
  const sourceClientId = entry.media.sourceClientId ?? entry.clientId;
  try {
    await patchMediaUpload(entry.media.ownerId, sourceClientId, { state: "cleanup" });
    await removeMediaUpload(entry.media.ownerId, sourceClientId);
  } catch {
    reportStorageIssue({
      severity: "degraded",
      area: "media",
      message: "Discarded media is waiting for local storage cleanup.",
    });
  }
  return true;
}

/** Waiting media can be cancelled before it becomes a blocked correction.
 * The outbox tombstone still commits before retained bytes are removed. */
export async function cancelPendingMediaSend(
  outboxOwnerId: string,
  entry: OutboxEntry,
): Promise<boolean> {
  if (!(await cancelPendingOutbox(outboxOwnerId, entry.clientId))) return false;
  if (entry.operation !== "media" || !entry.media) return true;
  const sourceClientId = entry.media.sourceClientId ?? entry.clientId;
  try {
    await patchMediaUpload(entry.media.ownerId, sourceClientId, { state: "cleanup" });
    await removeMediaUpload(entry.media.ownerId, sourceClientId);
  } catch {
    reportStorageIssue({
      severity: "degraded",
      area: "media",
      message: "Cancelled media is waiting for local storage cleanup.",
    });
  }
  return true;
}

const ATTACHMENT_CONTENT_KEYS = new Set([
  "acquiring",
  "duration_ms",
  "filename",
  "height",
  "local_url",
  "media_id",
  "mime",
  "size",
  "waveform",
  "width",
]);

function withoutAttachmentFields(value?: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([key]) => !ATTACHMENT_CONTENT_KEYS.has(key)),
  );
}

interface ReplaceSourceDependencies {
  stage: typeof stageMediaUpload;
  commit: typeof commitOutboxCorrection;
  markSuperseded: typeof patchMediaUpload;
  remove: typeof removeMediaUpload;
  sourceId: () => string;
}

const replaceSourceDefaults: ReplaceSourceDependencies = {
  stage: stageMediaUpload,
  commit: commitOutboxCorrection,
  markSuperseded: patchMediaUpload,
  remove: removeMediaUpload,
  sourceId: () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
};

/** Copy-on-write attachment replacement. New bytes get a fresh durable source
 * generation; only a verified outbox revision switches ownership, after which
 * the old generation is best-effort garbage-collected. */
export async function replaceMediaOutboxSource(
  outboxOwnerId: string,
  entry: OutboxEntry,
  input: {
    blob: Blob;
    filename: string;
    mime: string;
    kind: "image" | "file" | "voice";
  },
  dependencies: ReplaceSourceDependencies = replaceSourceDefaults,
): Promise<OutboxEntry> {
  if (entry.operation !== "media" || !entry.media) {
    throw new Error("The saved attachment is unavailable");
  }
  const oldSourceClientId = entry.media.sourceClientId ?? entry.clientId;
  const sourceClientId = `${entry.clientId}:source:${dependencies.sourceId()}`;
  await dependencies.stage({
    ownerId: entry.media.ownerId,
    roomId: entry.roomId,
    clientId: sourceClientId,
    outboxClientId: entry.clientId,
    name: input.filename,
    mime: input.mime,
    kind: input.kind,
    size: input.blob.size,
    blob: input.blob,
  });
  const content = {
    ...withoutAttachmentFields(entry.content),
    filename: input.filename,
    mime: input.mime,
  };
  const committed = await dependencies.commit(
    outboxOwnerId,
    entry.clientId,
    "replace_attachment",
    {
      type:
        input.kind === "image"
          ? "m.image"
          : input.kind === "voice"
            ? "m.voice"
            : "m.file",
      // Captions/body/reply and every non-attachment field remain unchanged.
      body: entry.body,
      content,
      media: {
        ownerId: entry.media.ownerId,
        sourceClientId,
        uploadClientId: sourceClientId,
        kind: input.kind,
        filename: input.filename,
        mime: input.mime,
        size: input.blob.size,
        eventContent: withoutAttachmentFields(entry.media.eventContent),
        completionMeta: withoutAttachmentFields(entry.media.completionMeta),
        transcribe: input.kind === "voice" && entry.media.transcribe,
        phase: "staged",
      },
      state: "queued",
      nextAttemptAt: Date.now(),
      failure: undefined,
      challenge: undefined,
      lastError: undefined,
    },
  );
  if (oldSourceClientId !== sourceClientId) {
    await dependencies.markSuperseded(entry.media.ownerId, oldSourceClientId, {
      state: "cleanup",
      supersededBySourceClientId: sourceClientId,
    }).catch(() => undefined);
    await dependencies.remove(entry.media.ownerId, oldSourceClientId).catch(() => undefined);
  }
  return committed;
}

interface RestartUploadDependencies {
  reset: typeof patchMediaUpload;
  commit: typeof commitOutboxCorrection;
  uploadId: () => string;
}

const restartUploadDefaults: RestartUploadDependencies = {
  reset: patchMediaUpload,
  commit: commitOutboxCorrection,
  uploadId: () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
};

/** Restart keeps the exact retained bytes but allocates a fresh multipart
 * idempotency identity. The logical event client ID and timeline identity do
 * not change. */
export async function restartMediaUploadGeneration(
  outboxOwnerId: string,
  entry: OutboxEntry,
  dependencies: RestartUploadDependencies = restartUploadDefaults,
): Promise<OutboxEntry> {
  if (entry.operation !== "media" || !entry.media) {
    throw new Error("The retained attachment is unavailable");
  }
  const sourceClientId = entry.media.sourceClientId ?? entry.clientId;
  await dependencies.reset(entry.media.ownerId, sourceClientId, {
    state: "staged",
    sessionId: null,
    mediaId: null,
  });
  return dependencies.commit(
    outboxOwnerId,
    entry.clientId,
    "restart_upload",
    {
      content: {
        ...withoutAttachmentFields(entry.content),
        filename: entry.media.filename,
        mime: entry.media.mime,
      },
      media: {
        ...entry.media,
        uploadClientId: `${entry.clientId}:upload:${dependencies.uploadId()}`,
        uploadedMediaId: undefined,
      },
      state: "queued",
      nextAttemptAt: Date.now(),
      failure: undefined,
      challenge: undefined,
      lastError: undefined,
    },
  );
}

/** Retry cleanup rows left by a crash/quota failure. The cleanup marker alone
 * never authorizes deletion: the independent outbox acknowledgement must also
 * be present, so a crash between marker and ack cannot lose send bytes. */
export async function sweepAcknowledgedMediaCleanup(outboxOwnerId: string): Promise<number> {
  const mediaOwnerId = `carbon:${outboxOwnerId}`;
  const rows = await listOwnerMediaUploads(mediaOwnerId).catch(() => []);
  let removed = 0;
  for (const row of rows) {
    const terminal = await outboxTerminalState(
      outboxOwnerId,
      row.outboxClientId ?? row.clientId,
    );
    if (terminal === "accepted" && row.state !== "cleanup") continue;
    if (terminal == null) {
      if (!row.supersededBySourceClientId || !row.outboxClientId) continue;
      const current = (await listOutbox(outboxOwnerId).catch(() => []))
        .find((entry) => entry.clientId === row.outboxClientId);
      if (current?.media?.sourceClientId !== row.supersededBySourceClientId) continue;
    }
    try {
      await removeMediaUpload(mediaOwnerId, row.clientId);
      removed += 1;
    } catch {
      reportStorageIssue({
        severity: "degraded",
        area: "media",
        message: "Sent media is still waiting for local cleanup. Retry storage access to reclaim it.",
      });
    }
  }
  return removed;
}
