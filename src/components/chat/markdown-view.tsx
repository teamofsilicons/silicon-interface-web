import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Markdown renderer (GFM: tables, task lists, strikethrough, autolinks). We
 * don't use @tailwindcss/typography, so every element is styled by hand below.
 * react-markdown never renders raw HTML, so this is XSS-safe by default.
 *
 * `compact` tunes it for a chat bubble: modest heading sizes, no heavy rule
 * lines, tighter vertical rhythm — so a markdown message reads like a message,
 * not a document. The full (non-compact) styling is used in the file previewer.
 */
export function MarkdownView({
  source,
  className,
  compact = false,
}: {
  source: string;
  className?: string;
  compact?: boolean;
}) {
  const c = compact;
  return (
    <div className={cn("text-sm leading-relaxed text-foreground", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className={cn(
                "font-bold first:mt-0",
                c ? "mb-1 mt-3 text-[15px]" : "mb-3 mt-6 border-b pb-1 text-2xl",
              )}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className={cn(
                "font-semibold first:mt-0",
                c ? "mb-1 mt-3 text-sm" : "mb-2 mt-5 border-b pb-1 text-xl font-bold",
              )}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className={cn(
                "font-semibold first:mt-0",
                c ? "mb-0.5 mt-2.5 text-sm" : "mb-2 mt-4 text-lg",
              )}
            >
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className={cn("font-semibold first:mt-0", c ? "mb-0.5 mt-2 text-sm" : "mb-1 mt-3 text-base")}>
              {children}
            </h4>
          ),
          h5: ({ children }) => (
            <h5 className={cn("font-semibold first:mt-0", c ? "mb-0.5 mt-2 text-sm" : "mb-1 mt-3 text-sm")}>
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6
              className={cn(
                "font-semibold text-muted-foreground first:mt-0",
                c ? "mb-0.5 mt-2 text-sm" : "mb-1 mt-3 text-sm",
              )}
            >
              {children}
            </h6>
          ),
          p: ({ children }) => (
            <p className={cn("first:mt-0 last:mb-0", c ? "my-1.5" : "my-3")}>{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul
              className={cn(
                "list-disc pl-5 first:mt-0 last:mb-0",
                c ? "my-1.5 space-y-0.5" : "my-3 space-y-1 pl-6",
              )}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={cn(
                "list-decimal pl-5 first:mt-0 last:mb-0",
                c ? "my-1.5 space-y-0.5" : "my-3 space-y-1 pl-6",
              )}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              className={cn(
                "border-l-2 border-foreground/25 pl-3 text-muted-foreground",
                c ? "my-1.5" : "my-3 pl-4 italic",
              )}
            >
              {children}
            </blockquote>
          ),
          hr: () => <hr className={cn("border-border", c ? "my-3" : "my-6")} />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className: cls, children }) => {
            const isBlock = /language-/.test(cls || "");
            if (isBlock) return <code className={cn("font-mono text-[13px]", cls)}>{children}</code>;
            return (
              <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre
              className={cn(
                "overflow-x-auto border bg-foreground/5 p-3 font-mono text-[13px] leading-relaxed first:mt-0 last:mb-0",
                c ? "my-2" : "my-3",
              )}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className={cn("overflow-x-auto", c ? "my-2" : "my-3")}>
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b">{children}</thead>,
          th: ({ children }) => (
            <th className="border px-2.5 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border px-2.5 py-1 align-top">{children}</td>,
          img: ({ src, alt }) => (
            // eslint-disable-next-line @next/next/no-img-element -- markdown remote image
            <img
              src={typeof src === "string" ? src : ""}
              alt={alt || ""}
              className={cn("max-w-full", c ? "my-2" : "my-3")}
            />
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
