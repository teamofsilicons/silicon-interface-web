"use client";

import * as React from "react";
import { Gif, MagnifyingGlass, Smiley } from "@phosphor-icons/react/dist/ssr";

import { GifPicker } from "@/components/chat/gif-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ALL_EMOJI_LIST,
  searchEmoji,
  type EmojiEntry,
} from "@/lib/emoji";
import type { GifResult } from "@/lib/giphy";

const RECENT_EMOJI_KEY = "silicon-interface:composer-recent-emoji";
const MAX_RECENT_EMOJI = 24;

function readRecentEmoji(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_EMOJI_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_EMOJI)
      : [];
  } catch {
    return [];
  }
}

function writeRecentEmoji(emoji: string, current: string[]): string[] {
  const next = [emoji, ...current.filter((item) => item !== emoji)].slice(0, MAX_RECENT_EMOJI);
  try {
    window.localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience; private/disabled storage must not block pick.
  }
  return next;
}

export function buildEmojiPickerEntries(recent: string[]): EmojiEntry[] {
  const byGlyph = new Map(ALL_EMOJI_LIST.map((entry) => [entry.emoji, entry] as const));
  const seen = new Set<string>();
  const entries: EmojiEntry[] = [];
  for (const glyph of recent) {
    const entry = byGlyph.get(glyph);
    if (entry && !seen.has(entry.emoji)) {
      seen.add(entry.emoji);
      entries.push(entry);
    }
  }
  for (const entry of ALL_EMOJI_LIST) {
    if (!seen.has(entry.emoji)) {
      seen.add(entry.emoji);
      entries.push(entry);
    }
  }
  return entries;
}

export function ComposerExpressionPicker({
  onPickEmoji,
  onPickGif,
}: {
  onPickEmoji: (emoji: string) => void;
  onPickGif: (gif: GifResult) => void;
}) {
  const [tab, setTab] = React.useState<"emoji" | "gif">("emoji");
  const [emojiQuery, setEmojiQuery] = React.useState("");
  const [recentEmoji, setRecentEmoji] = React.useState<string[]>(readRecentEmoji);

  const emoji = React.useMemo(
    () =>
      emojiQuery.trim()
        ? searchEmoji(emojiQuery, ALL_EMOJI_LIST.length)
        : buildEmojiPickerEntries(recentEmoji),
    [emojiQuery, recentEmoji],
  );

  const pickEmoji = (glyph: string) => {
    setRecentEmoji(writeRecentEmoji(glyph, recentEmoji));
    onPickEmoji(glyph);
  };

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as "emoji" | "gif")}
      className="flex h-[min(70dvh,430px)] w-[min(92vw,420px)] flex-col bg-background"
    >
      <div className="border-b p-2">
        <TabsList className="grid w-full grid-cols-2 rounded-none">
          <TabsTrigger value="emoji" className="gap-1.5 rounded-none">
            <Smiley className="h-4 w-4" /> emoji
          </TabsTrigger>
          <TabsTrigger value="gif" className="gap-1.5 rounded-none">
            <Gif className="h-4 w-4" /> GIFs
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="emoji" className="!mt-0 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <MagnifyingGlass className="h-4 w-4 shrink-0" />
          <input
            autoFocus
            value={emojiQuery}
            onChange={(event) => setEmojiQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              const first = event.currentTarget
                .closest("[data-expression-picker]")
                ?.querySelector<HTMLButtonElement>("[data-emoji-index='0']");
              if (first) {
                event.preventDefault();
                first.focus();
              }
            }}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {!emojiQuery.trim() && (
          <div className="label-mono px-3 pt-2 text-[10px] text-muted-foreground">
            {recentEmoji.length > 0 ? "recent & all emojis" : "all emojis"}
          </div>
        )}
        {emoji.length > 0 ? (
          <div
            data-expression-picker
            className="grid min-h-0 flex-1 grid-cols-7 content-start gap-1 overflow-y-auto p-2 sm:grid-cols-8"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                return;
              }
              const current = (event.target as HTMLElement).closest<HTMLButtonElement>(
                "[data-emoji-index]",
              );
              if (!current) return;
              const index = Number(current.dataset.emojiIndex);
              const columns = window.matchMedia("(min-width: 640px)").matches ? 8 : 7;
              const delta =
                event.key === "ArrowLeft"
                  ? -1
                  : event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -columns
                      : columns;
              const next = Math.max(0, Math.min(emoji.length - 1, index + delta));
              const target = event.currentTarget.querySelector<HTMLButtonElement>(
                `[data-emoji-index='${next}']`,
              );
              if (target) {
                event.preventDefault();
                target.focus();
              }
            }}
          >
            {emoji.map((entry, index) => (
              <button
                key={`${entry.emoji}-${entry.name}`}
                data-emoji-index={index}
                type="button"
                onClick={() => pickEmoji(entry.emoji)}
                title={entry.name}
                aria-label={entry.name}
                className="inline-flex aspect-square min-h-9 items-center justify-center border border-transparent text-xl transition-colors hover:border-border hover:bg-accent focus-visible:border-foreground focus-visible:bg-accent"
              >
                {entry.emoji}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground" role="status">
            No emoji found.
          </div>
        )}
      </TabsContent>

      <TabsContent value="gif" className="!mt-0 min-h-0 flex-1">
        <GifPicker onPick={onPickGif} className="h-full w-full" />
      </TabsContent>
    </Tabs>
  );
}
