/**
 * Keep the authoritative stream order for the visible conversation.
 *
 * A run anchor describes which Carbon event caused a Stemcell run, but it must
 * not move a later Silicon event ahead of messages that were accepted first.
 * Doing so made a second Carbon message appear below the response it preceded.
 */
export function preserveCanonicalTimelineOrder<T>(
  canonical: readonly T[],
): T[] {
  return [...canonical];
}
