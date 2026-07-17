"use client";

import * as React from "react";

import { api } from "@/lib/api";
import { isTextLikeFile } from "@/lib/programmatic-files";

/**
 * Fetches a small head of a text/markdown file's contents for a mini preview on
 * the attachment card (like a document thumbnail). Cached per key (media_id)
 * for the session so scrolling never re-fetches.
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** Is this a text-ish file we can show a content peek for? */
export function isTextLike(name?: string | null, mime?: string | null): boolean {
  return isTextLikeFile(name, mime);
}

function fetchSnippet(url: string, key: string, maxChars: number): Promise<string | null> {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = inflight.get(key);
  if (existing) return existing;
  const mediaId = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(key) ? key : null;
  const authenticatedHead = mediaId
    ? api.mediaTextPreview(mediaId, Math.max(64 * 1024, maxChars * 4))
    : Promise.reject(new Error("not a durable media id"));
  const directHead = () => fetch(url, { mode: "cors" }).then((r) => {
    if (!r.ok) throw new Error(`status ${r.status}`);
    return r.text();
  });
  // Historical events often carry an object-storage grant that has naturally
  // expired. Prefer Glass's authenticated stable route, retaining the direct
  // fetch only for local/blob URLs and older non-ULID fixtures.
  const p = authenticatedHead
    .catch(directHead)
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
  return useTextSnippetState(url, key, enabled, maxChars).text;
}

export interface TextSnippetState {
  text: string | null;
  loading: boolean;
  error: boolean;
}

/** Like useTextSnippet, but exposes enough state for a stable inline loader. */
export function useTextSnippetState(
  url: string | null | undefined,
  key: string,
  enabled = true,
  maxChars = 1500,
): TextSnippetState {
  const [result, setResult] = React.useState<{
    key: string;
    text: string | null;
    error: boolean;
  }>(() => ({ key, text: key ? cache.get(key) ?? null : null, error: false }));
  const cached = key ? cache.get(key) ?? null : null;
  const current = result.key === key ? result : { key, text: cached, error: false };
  const text = cached ?? current.text;
  React.useEffect(() => {
    if (!enabled || !url) return;
    if (cache.has(key)) return;
    let alive = true;
    void fetchSnippet(url, key, maxChars).then((t) => {
      if (!alive) return;
      setResult({ key, text: t, error: t == null });
    });
    return () => {
      alive = false;
    };
  }, [url, key, enabled, maxChars]);
  const error = enabled && Boolean(url) && current.error && text == null;
  return {
    text,
    loading: enabled && Boolean(url) && text == null && !error,
    error,
  };
}
