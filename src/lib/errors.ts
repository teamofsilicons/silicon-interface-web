import { toast } from "sonner";

import { ApiError } from "./api";

// Delights §5b / §5d — error voice.
//
// Failures should read like terminal output, not a stack trace: lowercase,
// no exclamation marks, prefixed `stderr:`. This keeps the brand voice
// (warm, terminal/ASCII soul) consistent across auth flows and turns raw
// `TypeError: Failed to fetch`-style noise into something legible and human.

/** Network/fetch failures surface as `TypeError: Failed to fetch` (or similar)
 *  which is meaningless to a person. Detect them so we can humanize. */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /failed to fetch|networkerror|load failed|network request failed/i.test(
    msg,
  );
}

/** Pull a human message out of whatever was thrown, in the brand voice. */
function humanize(e: unknown): string {
  if (isNetworkError(e)) return "can't reach the network. check your connection.";
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e ?? "something went wrong");
}

/** Format any message as a mono `stderr: <lowercased message>` line. The
 *  trailing period/exclamation is trimmed so it doesn't fight the prefix. */
export function stderr(message: string): string {
  const clean = message
    .trim()
    .replace(/[.!]+$/, "")
    .replace(/!/g, "")
    .toLowerCase();
  return `stderr: ${clean}`;
}

/** Drop-in for `toast.error(...)` that formats API/network errors as
 *  `stderr: …` in the brand voice. Pass a thrown value or a raw string. */
export function toastError(e: unknown): void {
  const message = typeof e === "string" ? e : humanize(e);
  toast.error(stderr(message), {
    className: "font-mono",
  });
}
