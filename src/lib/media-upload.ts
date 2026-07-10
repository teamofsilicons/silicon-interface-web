import { api } from "./api";

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
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", url);
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
  file: Blob;
  filename: string;
  mime: string;
  kind: "image" | "file";
  roomId: string;
  onProgress?: (pct: number, loaded: number) => void;
  xhrRef?: { current: XMLHttpRequest | null };
  meta?: Parameters<typeof api.mediaComplete>[1];
}): Promise<string> {
  const { file, filename, mime, kind, roomId, onProgress, xhrRef, meta } = opts;
  const r = await api.presignUpload({ mime, size: file.size, kind, filename, room_id: roomId });
  const mediaId = r.media.media_id;
  if (!r.upload.dev_mode) {
    const form = new FormData();
    for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
    form.append("file", file, filename);
    await xhrUpload(r.upload.url, form, onProgress ?? (() => {}), xhrRef ?? { current: null });
    await api.mediaComplete(mediaId, meta ?? {});
  }
  return mediaId;
}
