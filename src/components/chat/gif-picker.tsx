"use client";

import * as React from "react";
import { CircleNotch, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";

import { fetchGifs, giphyConfigured, type GifResult } from "@/lib/giphy";

export function GifPicker({ onPick }: { onPick: (gif: GifResult) => void }) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<GifResult[]>([]);
  const [loading, setLoading] = React.useState(giphyConfigured());
  const [error, setError] = React.useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  React.useEffect(() => {
    if (!giphyConfigured()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetchGifs(query, controller.signal)
        .then(setResults)
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

  return (
    <div className="flex h-[min(70dvh,430px)] w-[min(92vw,420px)] flex-col bg-background">
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
        <div className="grid min-h-0 flex-1 auto-rows-[110px] grid-cols-2 gap-1 overflow-y-auto p-1 sm:grid-cols-3">
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
        </div>
      )}
      <div className="label-mono flex h-7 shrink-0 items-center justify-end border-t px-3 text-[10px] text-muted-foreground">
        Powered by GIPHY
      </div>
    </div>
  );
}
