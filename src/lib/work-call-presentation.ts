export interface WorkCallPreviewInput {
  summary?: string;
  transcript: readonly { body: string }[];
}

/**
 * Prefer the latest spoken content for the collapsed call row. The event
 * summary remains a useful fallback while a transcript is not available yet.
 */
export function workCallPreviewContent(call: WorkCallPreviewInput): string | null {
  for (let index = call.transcript.length - 1; index >= 0; index -= 1) {
    const body = call.transcript[index]?.body.trim();
    if (body) return body;
  }
  const summary = call.summary?.trim();
  return summary || null;
}
