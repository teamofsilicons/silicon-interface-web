"use client";

import * as React from "react";

/**
 * Fetches a small head of a text/markdown file's contents for a mini preview on
 * the attachment card (like a document thumbnail). Cached per key (media_id)
 * for the session so scrolling never re-fetches.
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** Is this a text-ish file we can show a content peek for? */
export function isTextLike(name?: string | null, mime?: string | null): boolean {
  const m = (mime || "").toLowerCase();
  if (
    m.startsWith("text/") ||
    m.includes("markdown") ||
    m.includes("json") ||
    m.includes("xml") ||
    m.includes("csv")
  ) {
    return true;
  }
  const ext = (name || "").toLowerCase().split(".").pop() || "";
  return [
    "md", "markdown", "mdx", "txt", "text", "log", "csv", "json", "yml", "yaml",
    "ini", "toml", "html", "htm", "css", "js", "ts", "tsx", "jsx", "py", "rs",
    "c", "h", "cpp", "sql", "sh", "env",
  ].includes(ext);
}

function fetchSnippet(url: string, key: string, maxChars: number): Promise<string | null> {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = fetch(url, { mode: "cors" })
    .then((r) => {
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.text();
    })
    .then((t) => {
      const snippet = t.slice(0, maxChars);
      cache.set(key, snippet);
      inflight.delete(key);
      return snippet;
    })
    .catch(() => {
      inflight.delete(key);
      return null;
    });
  inflight.set(key, p);
  return p;
}

/** Hook: returns a text head (or null until ready / on failure). */
export function useTextSnippet(
  url: string | null | undefined,
  key: string,
  enabled = true,
  maxChars = 1500,
): string | null {
  const [snippet, setSnippet] = React.useState<string | null>(() =>
    key ? cache.get(key) ?? null : null,
  );
  React.useEffect(() => {
    if (!enabled || !url) return;
    if (snippet != null) return;
    let alive = true;
    void fetchSnippet(url, key, maxChars).then((t) => {
      if (alive && t != null) setSnippet(t);
    });
    return () => {
      alive = false;
    };
  }, [url, key, enabled, maxChars, snippet]);
  return snippet;
}
