import type { Event } from "./types";

export interface ReactionSetResult {
  active: boolean;
  event: Event | null;
}

export class ReactionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReactionContractError";
  }
}

export function normalizeReactionEmoji(emoji: string): string {
  return emoji.normalize("NFC");
}

export function reactionIntentKey(targetEventId: string, emoji: string): string {
  return `${targetEventId}\u0000${normalizeReactionEmoji(emoji)}`;
}

function isOwnReaction(
  event: Event,
  targetEventId: string,
  emoji: string,
  senderHandle: string,
): boolean {
  return event.type === "m.reaction" &&
    event.reply_to_event_id === targetEventId &&
    event.sender_handle === senderHandle &&
    normalizeReactionEmoji(String(event.content.emoji ?? "")) === normalizeReactionEmoji(emoji);
}

export function ownReactionIsActive(
  events: readonly Event[],
  targetEventId: string,
  emoji: string,
  senderHandle: string,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  return events.some(
    (event) => !event.redacted_at && isOwnReaction(event, targetEventId, emoji, senderHandle),
  );
}

/** Resolve the next click from the latest synchronous intent, not merely the
 * last rendered server projection. This makes two rapid clicks add then remove
 * even when React has not had a chance to commit between them. */
export function nextOwnReactionIntent(
  events: readonly Event[],
  targetEventId: string,
  emoji: string,
  senderHandle: string,
  currentIntent?: boolean,
): boolean {
  return !ownReactionIsActive(
    events,
    targetEventId,
    emoji,
    senderHandle,
    currentIntent,
  );
}

/** Fold an authoritative desired-state response into the event collection
 * before an optimistic override is removed, preventing a one-frame flicker. */
export function reconcileReactionResult<T extends Event>(
  events: readonly T[],
  targetEventId: string,
  emoji: string,
  senderHandle: string,
  desired: boolean,
  result: ReactionSetResult,
  now = new Date().toISOString(),
): T[] {
  if (result.active !== desired) {
    throw new ReactionContractError("reaction response did not match desired state");
  }
  if (desired) {
    const event = result.event;
    if (
      !event ||
      !event.event_id ||
      event.event_id.startsWith("local-") ||
      event.event_id.startsWith("temp-") ||
      event.redacted_at ||
      !isOwnReaction(event, targetEventId, emoji, senderHandle)
    ) {
      throw new ReactionContractError("invalid authoritative reaction response");
    }
  } else if (result.event) {
    throw new ReactionContractError("inactive reaction response included an event");
  }

  let foundAuthoritative = false;
  const next = events.map((event) => {
    if (result.event && event.event_id === result.event.event_id) {
      foundAuthoritative = true;
      return result.event as T;
    }
    if (!isOwnReaction(event, targetEventId, emoji, senderHandle)) return event;
    if (desired && result.event) {
      // A semantic retry can resolve to a pre-existing row. Suppress any stale
      // duplicate projection until the next canonical sync compacts it.
      return event.redacted_at
        ? event
        : ({ ...event, redacted_at: now, redaction_reason: "duplicate_reaction" } as T);
    }
    return event.redacted_at
      ? event
      : ({ ...event, redacted_at: now, redaction_reason: "unreact" } as T);
  });
  if (desired && result.event && !foundAuthoritative) {
    next.push(result.event as T);
  }
  return next;
}

export function applyOwnReactionOverride(
  handles: readonly string[],
  senderHandle: string,
  desired: boolean,
): string[] {
  const withoutSender = handles.filter((handle) => handle !== senderHandle);
  return desired ? [...withoutSender, senderHandle] : withoutSender;
}

/** Aggregate the complete loaded event window. Reaction rows may arrive on a
 * different history page than their target; identity is target-based, so page
 * order never affects the bundle. Duplicate echoes from one sender count once. */
export function aggregateReactions(
  events: readonly Event[],
): Map<string, Record<string, string[]>> {
  const map = new Map<string, Record<string, string[]>>();
  for (const event of events) {
    if (event.type !== "m.reaction" || event.redacted_at) continue;
    const target = event.reply_to_event_id;
    const emoji = normalizeReactionEmoji(String(event.content.emoji ?? ""));
    const sender = event.sender_handle ||
      `${event.sender_kind}:${event.sender_id ?? event.event_id}`;
    if (!target || !emoji || !sender) continue;
    const bucket = map.get(target) ?? {};
    const senders = bucket[emoji] ?? [];
    if (!senders.includes(sender)) senders.push(sender);
    bucket[emoji] = senders;
    map.set(target, bucket);
  }
  return map;
}

export async function retryReactionMutation<T>(
  perform: () => Promise<T>,
  options: {
    attempts?: number;
    shouldRetry?: (error: unknown) => boolean;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const shouldRetry = options.shouldRetry ?? (() => true);
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await perform();
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !shouldRetry(error)) throw error;
      await wait(200 * 2 ** attempt);
    }
  }
  throw lastError;
}
