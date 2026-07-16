import { ApiError } from "./api";
import type { Event } from "./types";

/** Accept only the authoritative current projection for the event being edited. */
export function authoritativeEditConflict(
  error: unknown,
  targetEventId: string,
): Event | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (!error.body || typeof error.body !== "object") return null;
  const current = (error.body as { current?: unknown }).current;
  if (!current || typeof current !== "object") return null;
  const event = current as Partial<Event>;
  if (
    event.event_id !== targetEventId ||
    typeof event.edit_version !== "number" ||
    !Number.isSafeInteger(event.edit_version) ||
    event.edit_version < 0 ||
    !event.content ||
    typeof event.content !== "object"
  ) {
    return null;
  }
  return current as Event;
}
