const HTTP_URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION_RE = /[).,;:!?'"]+$/;

export interface LinkTextSegment {
  text: string;
  href?: string;
}

/** Only HTTP(S) destinations are linkified on chat surfaces. */
export function safeHttpUrl(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Human-sized URL label: remove protocol/www, keep the useful path, and
 * collapse query strings and fragments so a tracking/search URL cannot take
 * over a panel or a CSV cell. The full destination remains in href/title.
 */
export function compactUrlLabel(raw: string, maxLength = 64): string {
  const safe = safeHttpUrl(raw);
  if (!safe) return raw;
  try {
    const parsed = new URL(safe);
    const host = parsed.host.replace(/^www\./i, "");
    let pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // A malformed escape should not prevent a safe, compact label.
    }
    const suffix = parsed.search ? "?…" : parsed.hash ? "#…" : "";
    const label = `${host}${pathname}${suffix}` || host;
    if (label.length <= maxLength) return label;
    const roomForTail = Math.min(18, Math.max(8, Math.floor(maxLength / 3)));
    const roomForHead = Math.max(8, maxLength - roomForTail - 1);
    return `${label.slice(0, roomForHead)}…${label.slice(-roomForTail)}`;
  } catch {
    return raw;
  }
}

/** Split arbitrary cell text into literal and safe clickable URL segments. */
export function linkifyHttpText(value: string): LinkTextSegment[] {
  const segments: LinkTextSegment[] = [];
  let cursor = 0;
  HTTP_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTTP_URL_RE.exec(value)) !== null) {
    if (match.index > cursor) segments.push({ text: value.slice(cursor, match.index) });
    const raw = match[0];
    const trailing = raw.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    const href = safeHttpUrl(candidate);
    if (href) segments.push({ text: compactUrlLabel(href), href });
    else segments.push({ text: candidate });
    if (trailing) segments.push({ text: trailing });
    cursor = match.index + raw.length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor) });
  return segments.length > 0 ? segments : [{ text: value }];
}
