import * as React from "react";

import { cn } from "@/lib/utils";

export interface MentionTarget {
  kind: "carbon" | "silicon";
  handle: string;
  name?: string;
}

export type MentionLookup = Map<string, MentionTarget>;

export interface MentionRenderOptions {
  mentions?: MentionTarget[];
  mentionLookup?: MentionLookup;
  onMentionClick?: (target: MentionTarget) => void;
  mentionInverted?: boolean;
}

type MentionPiece =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string; target: MentionTarget };

const MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_.-]+)/g;
const TRAILING_PUNCT_RE = /[.,!?;:)\]}]$/;
const MENTION_LABEL_RE = /^[A-Za-z0-9_.-]+$/;

function normalizeMention(value: string): string {
  return value.replace(/^@/, "").toLowerCase();
}

export function buildMentionLookup(mentions: MentionTarget[] | undefined): MentionLookup {
  const lookup: MentionLookup = new Map();
  for (const mention of mentions ?? []) {
    const add = (value: string | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed || !MENTION_LABEL_RE.test(trimmed)) return;
      const key = normalizeMention(trimmed);
      if (!lookup.has(key)) lookup.set(key, mention);
    };
    add(mention.handle);
    add(mention.name);
  }
  return lookup;
}

export function mentionHref(target: MentionTarget): string {
  return `mention://${target.kind}/${encodeURIComponent(target.handle)}`;
}

export function mentionFromHref(
  href: string | undefined,
  lookup: MentionLookup,
): MentionTarget | null {
  if (!href?.startsWith("mention://")) return null;
  const match = href.match(/^mention:\/\/(carbon|silicon)\/(.+)$/);
  if (!match) return null;
  const handle = decodeURIComponent(match[2] ?? "");
  return lookup.get(normalizeMention(handle)) ?? null;
}

function resolveToken(
  token: string,
  lookup: MentionLookup,
): { mentionText: string; suffix: string; target: MentionTarget } | null {
  let candidate = token;
  let suffix = "";
  while (candidate) {
    const target = lookup.get(normalizeMention(candidate));
    if (target) return { mentionText: candidate, suffix, target };
    if (!TRAILING_PUNCT_RE.test(candidate)) return null;
    suffix = candidate.slice(-1) + suffix;
    candidate = candidate.slice(0, -1);
  }
  return null;
}

export function splitMentionText(text: string, lookup: MentionLookup): MentionPiece[] {
  if (!text || lookup.size === 0) return [{ kind: "text", value: text }];
  const pieces: MentionPiece[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const at = match.index + prefix.length;
    if (match.index > cursor) {
      pieces.push({ kind: "text", value: text.slice(cursor, match.index) });
    }
    if (prefix) pieces.push({ kind: "text", value: prefix });

    const resolved = resolveToken(token, lookup);
    if (resolved) {
      pieces.push({
        kind: "mention",
        value: `@${resolved.mentionText}`,
        target: resolved.target,
      });
      if (resolved.suffix) pieces.push({ kind: "text", value: resolved.suffix });
    } else {
      pieces.push({ kind: "text", value: `@${token}` });
    }
    cursor = at + 1 + token.length;
  }
  if (cursor < text.length) pieces.push({ kind: "text", value: text.slice(cursor) });
  return pieces;
}

export function MentionLink({
  target,
  children,
  inverted = false,
  onMentionClick,
}: {
  target: MentionTarget;
  children: React.ReactNode;
  inverted?: boolean;
  onMentionClick?: (target: MentionTarget) => void;
}) {
  return (
    <a
      href={mentionHref(target)}
      onClick={(event) => {
        if (!onMentionClick) return;
        event.preventDefault();
        event.stopPropagation();
        onMentionClick(target);
      }}
      className={cn(
        "rounded px-0.5 font-medium underline underline-offset-2 transition-opacity hover:opacity-80",
        inverted ? "bg-primary-foreground/15 text-primary-foreground" : "bg-primary/10 text-primary",
      )}
    >
      {children}
    </a>
  );
}

export function renderTextWithMentions(
  text: string,
  options: MentionRenderOptions | undefined,
  keyBase: string,
): React.ReactNode[] {
  const lookup = options?.mentionLookup ?? buildMentionLookup(options?.mentions);
  return splitMentionText(text, lookup).map((piece, index) => {
    if (piece.kind === "text") return piece.value;
    return (
      <MentionLink
        key={`${keyBase}-mention-${index}`}
        target={piece.target}
        inverted={options?.mentionInverted}
        onMentionClick={options?.onMentionClick}
      >
        {piece.value}
      </MentionLink>
    );
  });
}
