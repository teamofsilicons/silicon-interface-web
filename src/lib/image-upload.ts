// Shared guard for user-selected profile/contact images.
//
// QA §7.5: both the profile editor and the save-contact dialog passed the
// chosen file straight to `presignUpload` with `mime: file.type || "image/png"`.
// That has two problems:
//   1. No size cap — a multi-hundred-MB or multi-GB file is attempted, hanging
//      the upload and risking OOM on the presign/complete round-trip.
//   2. `file.type || "image/png"` silently relabels a file with an empty MIME
//      (common for HEIC, or files dragged from some apps) as a PNG, so a
//      non-renderable image is uploaded and later shows broken everywhere.
//
// `validateImageFile` enforces a real image MIME and a sane byte cap up front,
// returning a human-readable error instead of a developer-y one. It does NOT
// fall back to "image/png" for an empty type — an unknown type is rejected so
// we never upload something we can't render.

/** Max profile/contact image size. Generous for photos, fatal for stray dumps. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

/** MIME types we can actually render in an <img>. */
const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export interface ImageValidation {
  ok: boolean;
  /** Present only when `ok` is false — safe to surface directly to the user. */
  error?: string;
}

export function validateImageFile(file: File): ImageValidation {
  if (file.size === 0) {
    return { ok: false, error: "that file is empty" };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
    return { ok: false, error: `image is too large - keep it under ${mb} MB` };
  }
  // Reject an empty/unknown type rather than guessing "image/png": an empty
  // type usually means a format we can't render (e.g. HEIC), and guessing PNG
  // ships a broken image to every viewer.
  const type = file.type.toLowerCase();
  if (!type) {
    return { ok: false, error: "unsupported image type" };
  }
  if (!ALLOWED_IMAGE_MIME.has(type)) {
    return { ok: false, error: "use a PNG, JPEG, WebP, or GIF image" };
  }
  return { ok: true };
}
