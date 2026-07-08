import { ALL_EMOJI_TUPLES } from "./emoji-data";

export interface EmojiEntry {
  /** Display glyph. */
  emoji: string;
  /** Short slug + searchable terms. */
  name: string;
  /** Alternate keywords ("happy", "lol"). */
  keywords?: string[];
}

// Keep the empty `:` picker fast and familiar: popular chat emojis first.
// Search uses the full Unicode emoji list below, so obscure emoji like orca,
// trombone, flags, families, and skin-tone variants are still discoverable.
export const POPULAR_EMOJI_LIST: EmojiEntry[] = [
  { emoji: "😀", name: "grinning", keywords: ["happy", "smile"] },
  { emoji: "😄", name: "smile", keywords: ["happy"] },
  { emoji: "😁", name: "beaming", keywords: ["grin"] },
  { emoji: "😆", name: "laughing", keywords: ["lol", "haha"] },
  { emoji: "😂", name: "joy", keywords: ["lol", "haha", "tears"] },
  { emoji: "🤣", name: "rofl", keywords: ["lol", "haha"] },
  { emoji: "😊", name: "blush", keywords: ["happy", "smile"] },
  { emoji: "🙂", name: "slight_smile" },
  { emoji: "😉", name: "wink" },
  { emoji: "😍", name: "heart_eyes", keywords: ["love"] },
  { emoji: "🥰", name: "smiling_with_hearts", keywords: ["love"] },
  { emoji: "😘", name: "kiss" },
  { emoji: "😎", name: "sunglasses", keywords: ["cool"] },
  { emoji: "🤩", name: "star_struck" },
  { emoji: "🥳", name: "party", keywords: ["birthday", "celebrate"] },
  { emoji: "😋", name: "yum" },
  { emoji: "🤔", name: "thinking" },
  { emoji: "🤨", name: "raised_brow" },
  { emoji: "😐", name: "neutral" },
  { emoji: "😑", name: "expressionless" },
  { emoji: "😶", name: "no_mouth" },
  { emoji: "😏", name: "smirk" },
  { emoji: "😒", name: "unamused" },
  { emoji: "🙄", name: "rolling_eyes" },
  { emoji: "😬", name: "grimace" },
  { emoji: "🥺", name: "pleading" },
  { emoji: "😢", name: "cry", keywords: ["sad"] },
  { emoji: "😭", name: "sob", keywords: ["sad", "cry"] },
  { emoji: "😡", name: "angry", keywords: ["mad"] },
  { emoji: "🤬", name: "cursing" },
  { emoji: "🥲", name: "smile_tear" },
  { emoji: "😴", name: "sleeping" },
  { emoji: "🤯", name: "mind_blown" },
  { emoji: "👍", name: "thumbs_up", keywords: ["yes", "ok"] },
  { emoji: "👎", name: "thumbs_down", keywords: ["no"] },
  { emoji: "👌", name: "ok_hand" },
  { emoji: "🤌", name: "pinched_fingers" },
  { emoji: "🤏", name: "pinch" },
  { emoji: "✌️", name: "peace" },
  { emoji: "🤞", name: "crossed_fingers", keywords: ["luck"] },
  { emoji: "🤝", name: "handshake" },
  { emoji: "🙏", name: "pray", keywords: ["thanks"] },
  { emoji: "👏", name: "clap" },
  { emoji: "💪", name: "muscle" },
  { emoji: "🫡", name: "salute" },
  { emoji: "👋", name: "wave", keywords: ["hi", "hello"] },
  { emoji: "🫶", name: "heart_hands" },
  { emoji: "❤️", name: "heart", keywords: ["love"] },
  { emoji: "🧡", name: "orange_heart" },
  { emoji: "💛", name: "yellow_heart" },
  { emoji: "💚", name: "green_heart" },
  { emoji: "💙", name: "blue_heart" },
  { emoji: "💜", name: "purple_heart" },
  { emoji: "🖤", name: "black_heart" },
  { emoji: "🤍", name: "white_heart" },
  { emoji: "🤎", name: "brown_heart" },
  { emoji: "💔", name: "broken_heart" },
  { emoji: "❣️", name: "heart_exclamation" },
  { emoji: "💖", name: "sparkling_heart" },
  { emoji: "💕", name: "two_hearts" },
  { emoji: "💞", name: "revolving_hearts" },
  { emoji: "🔥", name: "fire", keywords: ["lit"] },
  { emoji: "✨", name: "sparkles" },
  { emoji: "💫", name: "dizzy" },
  { emoji: "⭐", name: "star" },
  { emoji: "🌟", name: "glowing_star" },
  { emoji: "🎉", name: "tada", keywords: ["party", "celebrate"] },
  { emoji: "🎊", name: "confetti" },
  { emoji: "🚀", name: "rocket", keywords: ["ship", "launch"] },
  { emoji: "✅", name: "check", keywords: ["ok", "done"] },
  { emoji: "❌", name: "cross", keywords: ["no"] },
  { emoji: "❓", name: "question" },
  { emoji: "❗", name: "exclamation" },
  { emoji: "☕", name: "coffee" },
  { emoji: "🍵", name: "tea" },
  { emoji: "🍺", name: "beer" },
  { emoji: "🍷", name: "wine" },
  { emoji: "🍕", name: "pizza" },
  { emoji: "🍔", name: "burger" },
  { emoji: "🍣", name: "sushi" },
  { emoji: "🍩", name: "donut" },
  { emoji: "🍪", name: "cookie" },
  { emoji: "💻", name: "laptop", keywords: ["computer"] },
  { emoji: "📱", name: "phone" },
  { emoji: "🤖", name: "robot", keywords: ["silicon", "ai"] },
  { emoji: "🧠", name: "brain" },
];

// Backwards-compatible export used by any callers that expect the default set.
export const EMOJI_LIST: EmojiEntry[] = POPULAR_EMOJI_LIST;

const popularByEmoji = new Map(POPULAR_EMOJI_LIST.map((entry) => [entry.emoji, entry]));

export const ALL_EMOJI_LIST: EmojiEntry[] = ALL_EMOJI_TUPLES.map(([emoji, unicodeName]) => {
  const popular = popularByEmoji.get(emoji);
  return {
    emoji,
    name: popular?.name ?? unicodeName,
    keywords: popular ? [unicodeName, ...(popular.keywords ?? [])] : undefined,
  };
});

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_+\-]+/g, " ")
    .replace(/\s+/g, " ");
}

function searchableText(entry: EmojiEntry): string {
  return normalizeSearchText([entry.name, ...(entry.keywords ?? [])].join(" "));
}

function matchScore(entry: EmojiEntry, query: string): number | null {
  const name = normalizeSearchText(entry.name);
  const text = searchableText(entry);

  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (text.split(" ").some((word) => word.startsWith(query))) return 2;
  if (text.includes(query)) return 3;
  return null;
}

/** Match an entry by Unicode name, shortcode-ish name, or keyword. */
export function searchEmoji(q: string, limit = 40): EmojiEntry[] {
  const s = normalizeSearchText(q);
  if (!s) return ALL_EMOJI_LIST.slice(0, limit);

  return ALL_EMOJI_LIST.map((entry, index) => ({ entry, index, score: matchScore(entry, s) }))
    .filter((result): result is { entry: EmojiEntry; index: number; score: number } => result.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((result) => result.entry);
}

// U+20E3 COMBINING ENCLOSING KEYCAP — the tail of keycap sequences like 1-keycap.
const KEYCAP = /⃣/u;
// A grapheme cluster is an emoji if it's a flag (regional-indicator pair), a
// keycap, or contains an Extended_Pictographic base (covers plain emoji, ZWJ
// sequences, skin-tone and variation-selector variants).
function isEmojiCluster(cluster: string): boolean {
  if (!cluster) return false;
  if (KEYCAP.test(cluster)) return true;
  if (/\p{Regional_Indicator}/u.test(cluster)) return true;
  return /\p{Extended_Pictographic}/u.test(cluster);
}

// Split a string into grapheme clusters. Uses Intl.Segmenter when available
// (correctly groups ZWJ families, flags, keycaps, skin tones); otherwise a
// manual pass that merges the same sequences off the code-point stream.
function toGraphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    try {
      const seg = new Segmenter("en", { granularity: "grapheme" });
      return Array.from(seg.segment(text), (s) => s.segment);
    } catch {
      // fall through to the manual splitter
    }
  }
  const cps = Array.from(text);
  const isRI = (ch: string) => /\p{Regional_Indicator}/u.test(ch);
  // Variation selector (FE0F), keycap (20E3), and skin-tone modifiers cling to
  // the preceding base; ZWJ (200D) joins the following base into one glyph.
  const isTrailer = (ch: string) => /[️⃣\u{1F3FB}-\u{1F3FF}]/u.test(ch);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    let cur = cps[i];
    if (isRI(cur) && i + 1 < cps.length && isRI(cps[i + 1])) {
      cur += cps[++i];
      out.push(cur);
      continue;
    }
    let j = i + 1;
    while (j < cps.length && (isTrailer(cps[j]) || cps[j] === "‍")) {
      cur += cps[j];
      if (cps[j] === "‍" && j + 1 < cps.length) cur += cps[++j];
      j++;
    }
    i = j - 1;
    out.push(cur);
  }
  return out;
}

/**
 * Is `text` nothing but emoji? Interior whitespace is ignored, so "😎 😎"
 * still counts. `count` is the number of emoji grapheme clusters — a ZWJ family
 * (👨‍👩‍👧), a flag (🇮🇳), and a keycap (1️⃣) each count as one. Returns ok=false the
 * moment any non-whitespace cluster is a normal letter/number/symbol/punct.
 */
export function emojiOnly(text: string): { ok: boolean; count: number } {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ok: false, count: 0 };
  let count = 0;
  for (const cluster of toGraphemes(trimmed)) {
    if (/^\s+$/u.test(cluster)) continue; // interior whitespace between emoji
    if (!isEmojiCluster(cluster)) return { ok: false, count: 0 };
    count += 1;
  }
  return { ok: count > 0, count };
}
