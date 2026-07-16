"use client";

import * as React from "react";
import { CircleNotch, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";

import {
  fetchGifs,
  GIPHY_PAGE_SIZE,
  giphyConfigured,
  type GifResult,
} from "@/lib/giphy";
import { cn } from "@/lib/utils";

export function GifPicker({
  onPick,
  className,
}: {
  onPick: (gif: GifResult) => void;
  className?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<GifResult[]>([]);
  const [loading, setLoading] = React.useState(giphyConfigured());
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [nextOffset, setNextOffset] = React.useState(GIPHY_PAGE_SIZE);
  const [hasMore, setHasMore] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = React.useState(false);
  const [reduceMotion, setReduceMotion] = React.useState(false);
  const loadMoreControllerRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  React.useEffect(() => {
    if (!giphyConfigured()) return;
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      setLoadMoreError(false);
      setResults([]);
      setNextOffset(GIPHY_PAGE_SIZE);
      setHasMore(true);
      void fetchGifs(query, controller.signal, 0)
        .then((items) => {
          setResults(items);
          setHasMore(items.length >= GIPHY_PAGE_SIZE);
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError("Couldn’t load GIFs. Try again.");
        })
        .finally(() => setLoading(false));
    }, query ? 250 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const loadMore = React.useCallback(() => {
    if (
      !giphyConfigured() ||
      loading ||
      loadingMore ||
      !hasMore ||
      loadMoreControllerRef.current
    ) return;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    const requestedQuery = query;
    const requestedOffset = nextOffset;
    setLoadMoreError(false);
    setLoadingMore(true);
    void fetchGifs(requestedQuery, controller.signal, requestedOffset)
      .then((items) => {
        setResults((current) => {
          const ids = new Set(current.map((gif) => gif.id));
          return [...current, ...items.filter((gif) => !ids.has(gif.id))];
        });
        setNextOffset(requestedOffset + GIPHY_PAGE_SIZE);
        setHasMore(items.length >= GIPHY_PAGE_SIZE);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setLoadMoreError(true);
      })
      .finally(() => {
        if (loadMoreControllerRef.current === controller) {
          loadMoreControllerRef.current = null;
          setLoadingMore(false);
        }
      });
  }, [hasMore, loading, loadingMore, nextOffset, query]);

  React.useEffect(
    () => () => loadMoreControllerRef.current?.abort(),
    [],
  );

  return (
    <div
      className={cn(
        "flex h-[min(70dvh,430px)] w-[min(92vw,420px)] flex-col bg-background",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MagnifyingGlass className="h-4 w-4 shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search GIPHY"
          aria-label="Search GIFs"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {!giphyConfigured() ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          GIF search needs a GIPHY API key configured for Interface.
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive" role="status">
          {error}
        </div>
      ) : loading && results.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <CircleNotch className="h-4 w-4 animate-spin" /> loading GIFs…
        </div>
      ) : results.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          No GIFs found.
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 auto-rows-[110px] grid-cols-2 gap-1 overflow-y-auto p-1 sm:grid-cols-3"
          onScroll={(event) => {
            const target = event.currentTarget;
            if (target.scrollHeight - target.scrollTop - target.clientHeight < 260) loadMore();
          }}
        >
          {results.map((gif) => (
            <button
              key={gif.id}
              type="button"
              onClick={() => onPick(gif)}
              title={gif.title}
              className="relative overflow-hidden bg-transparent focus-visible:z-10"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- GIPHY CDN rendition */}
              <img
                src={reduceMotion ? gif.stillUrl : gif.previewUrl}
                alt={gif.title}
                draggable={false}
                loading="lazy"
                className="sdr-media h-full w-full object-cover"
              />
            </button>
          ))}
          {loadingMore && (
            <div className="col-span-full flex h-12 items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
              <CircleNotch className="h-3.5 w-3.5 animate-spin" /> loading more…
            </div>
          )}
          {loadMoreError && !loadingMore && (
            <button
              type="button"
              onClick={loadMore}
              className="col-span-full h-12 text-xs text-muted-foreground hover:text-foreground"
            >
              couldn’t load more — retry
            </button>
          )}
        </div>
      )}
      <div className="label-mono flex h-7 shrink-0 items-center justify-end border-t px-3 text-[10px] text-muted-foreground">
        Powered by GIPHY
      </div>
    </div>
  );
}
