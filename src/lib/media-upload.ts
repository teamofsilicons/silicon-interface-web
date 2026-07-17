import { api, ApiError } from "./api";
import { authStore } from "./auth";
import {
  beginMediaTransfer,
  beginMediaDurability,
  endMediaTransfer,
  endMediaDurability,
  markMediaDurabilityFailure,
  patchMediaUpload,
  readMediaUpload,
  resolveMediaDurabilityFailure,
  stageMediaUpload,
} from "./media-upload-store";
import { sendTimeoutMs } from "./send-timeout";
import {
  missingMultipartParts,
  verifiedMultipartCompletionParts,
} from "./multipart-resume";

/**
 * Upload to a presigned URL via XHR (fetch can't report upload progress).
 * Reports 0–100% and supports abort; rejects with an AbortError when the user
 * cancels so callers can distinguish it from a real failure.
 *
 * Extracted from the composer so the composer and the annotation studio share
 * one upload path (no fork).
 */
export function xhrUpload(
  url: string,
  form: FormData,
  onProgress: (pct: number, loaded: number) => void,
  xhrRef: { current: XMLHttpRequest | null },
  timeoutMs?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", url);
    if (timeoutMs && timeoutMs > 0) xhr.timeout = timeoutMs;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100), e.loaded);
    };
    const clear = () => {
      xhrRef.current = null;
    };
    xhr.onload = () => {
      clear();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload failed (${xhr.status})`));
    };
    xhr.onerror = () => {
      clear();
      reject(new Error("upload failed"));
    };
    xhr.ontimeout = () => {
      clear();
      reject(new Error("upload timed out - retry to try again"));
    };
    xhr.onabort = () => {
      clear();
      reject(new DOMException("aborted", "AbortError"));
    };
    xhr.send(form);
  });
}

/**
 * Full presign → upload → mark-ready round-trip for a File/Blob. Returns the
 * `media_id` the caller then references in an event's content. Dev presigns are
 * already handled server-side, so they skip the external object-store upload.
 */
export async function uploadMediaBlob(opts: {
  clientId?: string;
  file: Blob;
  filename: string;
  mime: string;
  kind: "image" | "file";
  roomId: string;
  onProgress?: (pct: number, loaded: number) => void;
  xhrRef?: { current: XMLHttpRequest | null };
  meta?: Parameters<typeof api.mediaComplete>[1];
}): Promise<string> {
  return uploadMediaResumable({
    clientId: opts.clientId ?? window.crypto.randomUUID(),
    file: opts.file,
    filename: opts.filename,
    mime: opts.mime,
    kind: opts.kind,
    roomId: opts.roomId,
    onProgress: opts.onProgress,
    xhrRef: opts.xhrRef,
    meta: opts.meta,
  });
}

function digestHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function digestBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return window.btoa(binary);
}

async function sha256(blob: Blob): Promise<{ hex: string; base64: string }> {
  const digest = await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return { hex: digestHex(digest), base64: digestBase64(digest) };
}

export type MediaSafetyState = "scanning" | "ready" | "blocked";

/** Collapse the server's finite media lifecycle into the three client safety
 * states. Unknown future values fail closed as blocked. */
export function mediaSafetyState(status: string): MediaSafetyState {
  if (status === "pending") return "scanning";
  if (status === "ready") return "ready";
  return "blocked";
}

async function markMediaTransferComplete(
  ownerId: string,
  sourceClientId: string,
  mediaId: string,
  retainSourceUntilEventAck: boolean,
): Promise<void> {
  await patchMediaUpload(ownerId, sourceClientId, {
    state: "completed",
    mediaId,
    ...(!retainSourceUntilEventAck ? { blob: null } : {}),
  });
}

export function mediaSafetyError(safety: Exclude<MediaSafetyState, "ready">): ApiError {
  const pending = safety === "scanning";
  const code = pending ? "media_not_ready" : "media_missing";
  return new ApiError(
    409,
    {
      failure: {
        domain: "chat.operation",
        code,
        retryable: pending,
        automatic: pending,
        correction_actions: pending ? [] : ["replace_attachment", "discard_local"],
        ...(pending ? { retry_after_seconds: 1 } : {}),
      },
    },
    pending
      ? "Attachment safety scanning is still finishing."
      : "Attachment was blocked by the safety pipeline.",
    pending ? 1_000 : null,
  );
}

function xhrPutPart(
  url: string,
  part: Blob,
  checksum: string,
  onProgress: (loaded: number) => void,
  xhrRef: { current: XMLHttpRequest | null },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("PUT", url);
    xhr.timeout = sendTimeoutMs(part.size);
    xhr.setRequestHeader("x-amz-checksum-sha256", checksum);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    const clear = () => { xhrRef.current = null; };
    xhr.onload = () => {
      clear();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`upload part failed (${xhr.status})`));
    };
    xhr.onerror = () => { clear(); reject(new Error("upload part failed")); };
    xhr.ontimeout = () => { clear(); reject(new Error("upload part timed out")); };
    xhr.onabort = () => { clear(); reject(new DOMException("aborted", "AbortError")); };
    xhr.send(part);
  });
}

/** Durable, resumable upload used by every chat attachment and voice note. */
type MediaUploadOptions = {
  clientId: string;
  /** Durable source generation; server upload identity remains clientId. */
  sourceClientId?: string;
  /** Logical event outbox ID when uploadClientId is a replacement generation. */
  outboxClientId?: string;
  /** Omit on recovery: the strictly staged IndexedDB Blob is the source. */
  file?: Blob;
  filename: string;
  mime: string;
  kind: "image" | "file" | "voice";
  roomId: string;
  onProgress?: (pct: number, loaded: number) => void;
  xhrRef?: { current: XMLHttpRequest | null };
  /** Cancels hashing/session negotiation as well as the active part XHR. */
  signal?: AbortSignal;
  meta?: Parameters<typeof api.mediaComplete>[1];
  /** A send-intent upload retains its source bytes until the event outbox has
   * a durable authoritative acknowledgement. */
  retainSourceUntilEventAck?: boolean;
};

function uploadAbortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw uploadAbortError();
}

/** Keep a tab-close guard active for the complete upload, including hashing,
 * multipart transfer, completion, and metadata commit. */
export async function uploadMediaResumable(opts: MediaUploadOptions): Promise<string> {
  const carbonId = authStore.getCarbon()?.carbon_id;
  if (!carbonId) throw new Error("A signed-in owner is required for a durable media send");
  const ownerId = `carbon:${carbonId}`;
  const sourceClientId = opts.sourceClientId ?? opts.clientId;
  beginMediaTransfer(ownerId, sourceClientId);
  try {
    return await uploadMediaResumableInternal(opts);
  } finally {
    endMediaTransfer(ownerId, sourceClientId);
  }
}

async function uploadMediaResumableInternal(opts: MediaUploadOptions): Promise<string> {
  const { clientId, file, filename, mime, kind, roomId, onProgress, meta } = opts;
  const sourceClientId = opts.sourceClientId ?? clientId;
  const carbonId = authStore.getCarbon()?.carbon_id;
  if (!carbonId) throw new Error("A signed-in owner is required for a durable media send");
  const ownerId = `carbon:${carbonId}`;
  const xhrRef = opts.xhrRef ?? { current: null };
  const signal = opts.signal;
  throwIfUploadAborted(signal);
  beginMediaDurability(ownerId, sourceClientId);
  let durable;
  try {
    durable = await readMediaUpload(ownerId, sourceClientId);
    if (!durable) {
      if (!file) throw new Error("durable media source is missing");
      durable = await stageMediaUpload({
        ownerId,
        roomId,
        clientId: sourceClientId,
        ...(opts.retainSourceUntilEventAck
          ? { outboxClientId: opts.outboxClientId ?? clientId }
          : {}),
        name: filename,
        mime,
        kind,
        size: file.size,
        blob: file,
      });
    } else if (
      (file && durable.size !== file.size) ||
      durable.mime !== mime ||
      durable.roomId !== roomId
    ) {
      throw new Error("media client id was reused with a different payload");
    }
    resolveMediaDurabilityFailure(ownerId, sourceClientId);
  } catch (error) {
    if (!durable) markMediaDurabilityFailure(ownerId, sourceClientId);
    throw error;
  } finally {
    endMediaDurability(ownerId, sourceClientId);
  }
  if (durable.state === "cleanup" && durable.mediaId) {
    return durable.mediaId;
  }
  if (
    (durable.state === "completed" || durable.state === "scanning" || durable.state === "failed") &&
    durable.mediaId
  ) {
    // Object storage completion is enough to release the composer. If Glass is
    // still processing the object, the durable event outbox handles its
    // media_not_ready response without making the user restart the upload.
    await markMediaTransferComplete(
      ownerId,
      sourceClientId,
      durable.mediaId,
      Boolean(opts.retainSourceUntilEventAck),
    );
    return durable.mediaId;
  }
  const source = durable.blob ?? file;
  if (!source) throw new Error("durable media source is missing");
  const whole = await sha256(source);
  throwIfUploadAborted(signal);
  const session = await api.createMultipartUpload({
    client_id: clientId, mime, size: source.size, kind, filename,
    room_id: roomId, sha256: whole.hex,
  });
  if (signal?.aborted) {
    await api.cancelMultipartUpload(session.session_id).catch(() => undefined);
    throw uploadAbortError();
  }
  await patchMediaUpload(ownerId, sourceClientId, {
    state: session.state === "completed" ? "completed" : "uploading",
    sessionId: session.session_id,
    mediaId: session.state === "completed" ? session.media.media_id : null,
  });
  if (session.dev_mode || session.state === "completed") {
    throwIfUploadAborted(signal);
    if (meta) await api.mediaComplete(session.media.media_id, meta);
    await markMediaTransferComplete(
      ownerId,
      sourceClientId,
      session.media.media_id,
      Boolean(opts.retainSourceUntilEventAck),
    );
    return session.media.media_id;
  }

  throwIfUploadAborted(signal);
  const current = await api.multipartUpload(session.session_id);
  throwIfUploadAborted(signal);
  const expectedPartChecksums = new Map<number, string>();
  const expectedChecksum = async (number: number): Promise<string> => {
    const cached = expectedPartChecksums.get(number);
    if (cached) return cached;
    const start = (number - 1) * session.part_size;
    const part = source.slice(start, Math.min(start + session.part_size, source.size));
    const checksum = (await sha256(part)).base64;
    expectedPartChecksums.set(number, checksum);
    return checksum;
  };
  const currentByNumber = new Map(
    (current.uploaded_parts ?? [])
      .filter((part) => part.part_number >= 1 && part.part_number <= session.part_count)
      .map((part) => [part.part_number, part] as const),
  );
  let committedBytes = [...currentByNumber.values()].reduce((sum, part) => sum + part.size, 0);
  for (const number of missingMultipartParts(session.part_count, [...currentByNumber.keys()])) {
    throwIfUploadAborted(signal);
    const start = (number - 1) * session.part_size;
    const part = source.slice(start, Math.min(start + session.part_size, source.size));
    const checksum = await expectedChecksum(number);
    const signed = await api.signMultipartParts(session.session_id, [
      { part_number: number, checksum_sha256: checksum },
    ]);
    throwIfUploadAborted(signal);
    const target = signed.parts[0];
    if (!target) throw new Error(`missing signed URL for part ${number}`);
    await xhrPutPart(
      target.url, part, checksum,
      (partLoaded) => {
        const loaded = committedBytes + partLoaded;
        onProgress?.(Math.min(99, Math.round((loaded / source.size) * 100)), loaded);
      },
      xhrRef,
    );
    throwIfUploadAborted(signal);
    committedBytes += part.size;
  }
  throwIfUploadAborted(signal);
  const uploadedState = await api.multipartUpload(session.session_id);
  throwIfUploadAborted(signal);
  if (uploadedState.state === "completed") {
    if (meta) await api.mediaComplete(uploadedState.media.media_id, meta);
    await markMediaTransferComplete(
      ownerId,
      sourceClientId,
      uploadedState.media.media_id,
      Boolean(opts.retainSourceUntilEventAck),
    );
    onProgress?.(100, source.size);
    return uploadedState.media.media_id;
  }
  for (let number = 1; number <= session.part_count; number += 1) {
    await expectedChecksum(number);
  }
  let completedParts = verifiedMultipartCompletionParts(
    session.part_count,
    uploadedState.uploaded_parts ?? [],
    expectedPartChecksums,
  );
  let completed;
  try {
    completed = await api.completeMultipartUpload(session.session_id, {
      sha256: whole.hex,
      parts: completedParts,
    });
  } catch (error) {
    if (signal?.aborted) throw uploadAbortError();
    const body = error instanceof ApiError && error.body && typeof error.body === "object"
      ? error.body as { code?: unknown; failure?: { code?: unknown } }
      : null;
    const code = body?.failure?.code ?? body?.code;
    if (!(error instanceof ApiError) || error.status !== 409 || code !== "upload_checksum_mismatch") {
      throw error;
    }
    // Another tab may have uploaded the same retained bytes after our first
    // listing, replacing only the provider ETag. Re-read once, verify the
    // provider checksum against our bytes, and finalize with that latest ETag.
    const reconciled = await api.multipartUpload(session.session_id);
    throwIfUploadAborted(signal);
    if (reconciled.state === "completed") {
      completed = reconciled;
    } else {
      completedParts = verifiedMultipartCompletionParts(
        session.part_count,
        reconciled.uploaded_parts ?? [],
        expectedPartChecksums,
      );
      completed = await api.completeMultipartUpload(session.session_id, {
        sha256: whole.hex,
        parts: completedParts,
      });
    }
  }
  throwIfUploadAborted(signal);
  if (meta) await api.mediaComplete(completed.media.media_id, meta);
  await markMediaTransferComplete(
    ownerId,
    sourceClientId,
    completed.media.media_id,
    Boolean(opts.retainSourceUntilEventAck),
  );
  onProgress?.(100, source.size);
  return completed.media.media_id;
}
