// Ultra-minimal inline markdown.
//
// We render `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` ``,
// auto-link bare URLs, and keep newlines. Anything else is treated as plain
// text. No HTML injection — every output node is either a literal string or
// one of the wrappers below, and React escapes children itself.

import * as React from "react";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

// The single regex matches every supported token. Order matters: bold
// before italic so `**` doesn't get eaten by the single-asterisk rule.
const TOKEN_RE =
  /(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\bhttps?:\/\/[^\s<>"']+)/g;

/** Returns an array of React nodes (and bare strings) rendered from `text`. */
export function renderMarkdown(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // §2.8 — pull out ```fenced``` blocks first so a silicon's multi-line code
  // dump keeps its monospace + horizontal scroll instead of collapsing into
  // inline text. Odd-indexed split segments are the code between fences.
  const segments = text.split("```");
  segments.forEach((seg, segIdx) => {
    if (segIdx % 2 === 1) {
      const lines = seg.replace(/^\n/, "").replace(/\n$/, "").split("\n");
      // Drop a leading language hint line (e.g. ```ts) when present.
      if (lines.length > 1 && /^[a-zA-Z0-9_+-]{1,20}$/.test(lines[0])) lines.shift();
      out.push(
        React.createElement(
          "pre",
          {
            key: `pre-${segIdx}`,
            className:
              "my-1 max-w-full overflow-x-auto rounded bg-foreground/10 p-2 font-mono text-[0.85em] leading-snug",
          },
          React.createElement("code", null, lines.join("\n")),
        ),
      );
      return;
    }
    // Normal text: split on newlines so we can preserve them as <br /> nodes.
    const lines = seg.split("\n");
    lines.forEach((line, i) => {
      out.push(...inline(line, `${segIdx}-${i}`));
      if (i < lines.length - 1) out.push(React.createElement("br", { key: `br-${segIdx}-${i}` }));
    });
  });
  return out;
}

function inline(text: string, base: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  let n = 0;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const raw = match[0];
    const key = `${base}-${n++}`;
    if (raw.startsWith("**") && raw.endsWith("**")) {
      nodes.push(React.createElement("strong", { key }, raw.slice(2, -2)));
    } else if (raw.startsWith("__") && raw.endsWith("__")) {
      nodes.push(React.createElement("strong", { key }, raw.slice(2, -2)));
    } else if (raw.startsWith("~~") && raw.endsWith("~~")) {
      nodes.push(React.createElement("del", { key }, raw.slice(2, -2)));
    } else if (raw.startsWith("`") && raw.endsWith("`")) {
      nodes.push(
        React.createElement(
          "code",
          {
            key,
            // §2.8 — break-all so a long unbroken token in backticks wraps
            // inside the bubble instead of overflowing it.
            className:
              "rounded bg-foreground/10 px-1 font-mono text-[0.9em] [overflow-wrap:anywhere] break-all",
          },
          raw.slice(1, -1),
        ),
      );
    } else if (raw.startsWith("*") && raw.endsWith("*")) {
      nodes.push(React.createElement("em", { key }, raw.slice(1, -1)));
    } else if (raw.startsWith("_") && raw.endsWith("_")) {
      nodes.push(React.createElement("em", { key }, raw.slice(1, -1)));
    } else if (URL_RE.test(raw)) {
      URL_RE.lastIndex = 0;
      // §2.8 — the URL regex greedily swallows trailing punctuation; pull it
      // back out of the href so "(see https://x.com)." links cleanly and the
      // ")." renders as text. break-all stops a long URL overflowing the bubble.
      const trail = raw.match(/[).,;:!?'"]+$/)?.[0] ?? "";
      const href = trail ? raw.slice(0, raw.length - trail.length) : raw;
      nodes.push(
        React.createElement(
          "a",
          {
            key,
            href,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "underline underline-offset-2 hover:opacity-80 [overflow-wrap:anywhere] break-all",
          },
          href,
        ),
      );
      if (trail) nodes.push(trail);
    } else {
      nodes.push(raw);
    }
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

// A draft/message is "markdown" worth a full render only once it has a
// block-level construct (heading, list, blockquote, fenced code, table) or a
// link/image — a stray "*" in a normal sentence shouldn't trigger it.
const MD_BLOCK_RE = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|)/;
export function looksLikeMarkdown(s: string): boolean {
  if (!s || s.length < 2) return false;
  if (s.includes("```")) return true;
  if (MD_BLOCK_RE.test(s)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(s)) return true; // [text](url) / ![alt](src)
  return false;
}

/** Extract every URL from a chunk of text — used for link previews. */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE);
  if (!found) return [];
  // Strip trailing punctuation the regex swallowed so previews resolve cleanly.
  const cleaned = found.map((u) => u.replace(/[).,;:!?'"]+$/, ""));
  return Array.from(new Set(cleaned));
}
