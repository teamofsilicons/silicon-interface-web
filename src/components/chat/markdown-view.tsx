import * as React from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  buildMentionLookup,
  mentionFromHref,
  mentionHref,
  MentionLink,
  splitMentionText,
  type MentionTarget,
} from "@/lib/mentions";
import { cn } from "@/lib/utils";

// Minimal mdast node shape we touch — enough to walk children and split text.
interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

function childrenOf(node: unknown): MdastNode[] | null {
  if (!node || typeof node !== "object") return null;
  const children = (node as MdastNode).children;
  return Array.isArray(children) ? children : null;
}

// Rewrite every soft line break (a lone "\n" inside a `text` node) into a hard
// `break` node, so a chat message written as
//     hello
//     world
// renders on two visible lines instead of collapsing to "hello world" — the
// same soft-break behavior WhatsApp/Signal/etc. use, and what the plain-text
// renderer (lib/markdown.ts) already does. This is the `remark-breaks` behavior
// implemented locally (no dependency): it only ever touches `text` nodes, so
// fenced code and inline code (`code`/`inlineCode` nodes — no `text` children),
// list/table structure, and blank-line paragraph splits are all left intact.
function splitSoftBreaks(node: MdastNode): void {
  const children = childrenOf(node);
  if (!children) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
      const parts = child.value.split("\n");
      parts.forEach((part, i) => {
        if (part) next.push({ type: "text", value: part });
        if (i < parts.length - 1) next.push({ type: "break" });
      });
    } else {
      splitSoftBreaks(child);
      next.push(child);
    }
  }
  node.children = next;
}

function remarkSoftBreaks() {
  return (tree: unknown) => {
    if (tree) splitSoftBreaks(tree as MdastNode);
  };
}

function linkMentions(node: MdastNode, lookup: ReturnType<typeof buildMentionLookup>): void {
  const children = childrenOf(node);
  if (!children || node.type === "link" || node.type === "linkReference") return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    if (child.type === "text" && typeof child.value === "string") {
      for (const piece of splitMentionText(child.value, lookup)) {
        if (piece.kind === "text") {
          if (piece.value) next.push({ type: "text", value: piece.value });
        } else {
          next.push({
            type: "link",
            url: mentionHref(piece.target),
            children: [{ type: "text", value: piece.value }],
          });
        }
      }
    } else {
      linkMentions(child, lookup);
      next.push(child);
    }
  }
  node.children = next;
}

function createRemarkMentions(mentions: MentionTarget[] | undefined) {
  const lookup = buildMentionLookup(mentions);
  return function remarkMentions() {
    return (tree: unknown) => {
      if (lookup.size > 0 && tree) linkMentions(tree as MdastNode, lookup);
    };
  };
}

interface MarkdownRenderContextValue {
  compact: boolean;
  mentionLookup: ReturnType<typeof buildMentionLookup>;
  mentionInverted: boolean;
  onMentionClick?: (target: MentionTarget) => void;
}

const MarkdownRenderContext = React.createContext<MarkdownRenderContextValue>({
  compact: false,
  mentionLookup: new Map(),
  mentionInverted: false,
});

// Keep every renderer component type stable for the lifetime of the app.
// Defining these functions inline in MarkdownView made React see a brand-new
// component tree on every room heartbeat. It consequently detached and rebuilt
// the markdown DOM, which collapses (or retargets) a live browser text Range.
// Context lets dynamic styling and mention data update without replacing nodes.
const MARKDOWN_COMPONENTS: Components = {
  h1: function MarkdownHeading1({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <h1
        className={cn(
          "font-bold first:mt-0",
          compact ? "mb-1 mt-3 text-[15px]" : "mb-3 mt-6 border-b pb-1 text-2xl",
        )}
      >
        {children}
      </h1>
    );
  },
  h2: function MarkdownHeading2({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <h2
        className={cn(
          "font-semibold first:mt-0",
          compact ? "mb-1 mt-3 text-sm" : "mb-2 mt-5 border-b pb-1 text-xl font-bold",
        )}
      >
        {children}
      </h2>
    );
  },
  h3: function MarkdownHeading3({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <h3
        className={cn(
          "font-semibold first:mt-0",
          compact ? "mb-0.5 mt-2.5 text-sm" : "mb-2 mt-4 text-lg",
        )}
      >
        {children}
      </h3>
    );
  },
  h4: function MarkdownHeading4({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <h4 className={cn("font-semibold first:mt-0", compact ? "mb-0.5 mt-2 text-sm" : "mb-1 mt-3 text-base")}>
        {children}
      </h4>
    );
  },
  h5: function MarkdownHeading5({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <h5 className={cn("font-semibold first:mt-0", compact ? "mb-0.5 mt-2 text-sm" : "mb-1 mt-3 text-sm")}>
        {children}
      </h5>
    );
  },
  h6: function MarkdownHeading6({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <h6
        className={cn(
          "font-semibold text-muted-foreground first:mt-0",
          compact ? "mb-0.5 mt-2 text-sm" : "mb-1 mt-3 text-sm",
        )}
      >
        {children}
      </h6>
    );
  },
  p: function MarkdownParagraph({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <p className={cn("min-w-0 break-words first:mt-0 last:mb-0 [overflow-wrap:anywhere]", compact ? "my-1.5" : "my-3")}>
        {children}
      </p>
    );
  },
  a: function MarkdownAnchor({ href, children }) {
    const { mentionLookup, mentionInverted, onMentionClick } = React.useContext(MarkdownRenderContext);
    const mention = mentionFromHref(typeof href === "string" ? href : undefined, mentionLookup);
    if (mention) {
      return (
        <MentionLink
          target={mention}
          inverted={mentionInverted}
          onMentionClick={onMentionClick}
        >
          {children}
        </MentionLink>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    );
  },
  ul: function MarkdownUnorderedList({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <ul
        className={cn(
          "list-disc pl-5 first:mt-0 last:mb-0",
          compact ? "my-1.5 space-y-0.5" : "my-3 space-y-1 pl-6",
        )}
      >
        {children}
      </ul>
    );
  },
  ol: function MarkdownOrderedList({ children, start, type }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <ol
        start={start}
        type={type}
        style={{ paddingInlineStart: "2rem" }}
        className={cn(
          // Decimal markers sit outside the list item's content box. Reserve a
          // full marker column so 10+ does not clip at the bubble boundary.
          "list-decimal first:mt-0 last:mb-0",
          compact ? "my-1.5 space-y-0.5" : "my-3 space-y-1",
        )}
      >
        {children}
      </ol>
    );
  },
  li: function MarkdownListItem({ children }) {
    return <li className="pl-0.5">{children}</li>;
  },
  blockquote: function MarkdownBlockquote({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <blockquote
        className={cn(
          "border-l-2 border-foreground/25 pl-3 text-muted-foreground",
          compact ? "my-1.5" : "my-3 pl-4 italic",
        )}
      >
        {children}
      </blockquote>
    );
  },
  hr: function MarkdownRule() {
    const { compact } = React.useContext(MarkdownRenderContext);
    return <hr className={cn("border-border", compact ? "my-3" : "my-6")} />;
  },
  strong: function MarkdownStrong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
  em: function MarkdownEmphasis({ children }) {
    return <em className="italic">{children}</em>;
  },
  code: function MarkdownCode({ className, children }) {
    const isBlock = /language-/.test(className || "");
    if (isBlock) return <code className={cn("font-mono text-[13px]", className)}>{children}</code>;
    return (
      <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
  pre: function MarkdownPreformatted({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <pre
        className={cn(
          "max-w-full touch-pan-x overflow-x-auto overscroll-x-contain border bg-foreground/5 p-3 font-mono text-[13px] leading-relaxed first:mt-0 last:mb-0 [-webkit-overflow-scrolling:touch]",
          compact ? "my-2" : "my-3",
        )}
      >
        {children}
      </pre>
    );
  },
  table: function MarkdownTable({ children }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      <div className={cn("max-w-full touch-pan-x overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]", compact ? "my-2" : "my-3")}>
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  thead: function MarkdownTableHead({ children }) {
    return <thead className="border-b">{children}</thead>;
  },
  th: function MarkdownTableHeading({ children }) {
    return <th className="border px-2.5 py-1 text-left font-semibold">{children}</th>;
  },
  td: function MarkdownTableCell({ children }) {
    return <td className="border px-2.5 py-1 align-top">{children}</td>;
  },
  img: function MarkdownImage({ src, alt }) {
    const { compact } = React.useContext(MarkdownRenderContext);
    return (
      // eslint-disable-next-line @next/next/no-img-element -- markdown remote image
      <img
        src={typeof src === "string" ? src : ""}
        alt={alt || ""}
        className={cn("sdr-media max-w-full", compact ? "my-2" : "my-3")}
      />
    );
  },
};

/**
 * Markdown renderer (GFM: tables, task lists, strikethrough, autolinks). We
 * don't use @tailwindcss/typography, so every element is styled by hand below.
 * react-markdown never renders raw HTML, so this is XSS-safe by default.
 *
 * `compact` tunes it for a chat bubble: modest heading sizes, no heavy rule
 * lines, tighter vertical rhythm — so a markdown message reads like a message,
 * not a document. The full (non-compact) styling is used in the file previewer.
 */
interface MarkdownViewProps {
  source: string;
  className?: string;
  compact?: boolean;
  mentions?: MentionTarget[];
  onMentionClick?: (target: MentionTarget) => void;
  mentionInverted?: boolean;
}

export const MarkdownView = React.memo(function MarkdownView({
  source,
  className,
  compact = false,
  mentions,
  onMentionClick,
  mentionInverted = false,
}: MarkdownViewProps) {
  const mentionLookup = React.useMemo(() => buildMentionLookup(mentions), [mentions]);
  const mentionPlugin = React.useMemo(() => createRemarkMentions(mentions), [mentions]);
  const remarkPlugins = React.useMemo(
    () => [remarkGfm, remarkSoftBreaks, mentionPlugin],
    [mentionPlugin],
  );
  const renderContext = React.useMemo<MarkdownRenderContextValue>(
    () => ({ compact, mentionLookup, mentionInverted, onMentionClick }),
    [compact, mentionInverted, mentionLookup, onMentionClick],
  );
  return (
    <div
      data-selectable-text="true"
      style={{ overflowX: "clip", overflowY: "visible" }}
      className={cn(
        // Hiding only horizontal overflow makes CSS compute the
        // otherwise-visible Y axis to `auto`. List/paragraph margin overflow
        // can then give a long message its own tiny vertical scroll range,
        // trapping the first part of a trackpad gesture before it jumps to the
        // room timeline. `clip` contains wide inline content without creating a
        // nested scroller; preformatted blocks and tables retain their explicit
        // X scrollers.
        "min-w-0 max-w-full select-text break-words text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      <MarkdownRenderContext.Provider value={renderContext}>
        <Markdown remarkPlugins={remarkPlugins} components={MARKDOWN_COMPONENTS}>
          {source}
        </Markdown>
      </MarkdownRenderContext.Provider>
    </div>
  );
});
