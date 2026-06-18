import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Full markdown renderer (GFM: tables, task lists, strikethrough, autolinks)
 * for previewing .md files. We don't use @tailwindcss/typography (not
 * installed), so every element is styled by hand via the components map below.
 * react-markdown does not render raw HTML, so this is XSS-safe by default.
 */
export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-relaxed text-foreground", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-6 border-b pb-1 text-2xl font-bold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-5 border-b pb-1 text-xl font-bold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-3 text-base font-semibold first:mt-0">{children}</h4>
          ),
          h5: ({ children }) => (
            <h5 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h5>
          ),
          h6: ({ children }) => (
            <h6 className="mb-1 mt-3 text-sm font-semibold text-muted-foreground first:mt-0">
              {children}
            </h6>
          ),
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
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
            <ul className="my-3 list-disc space-y-1 pl-6 first:mt-0 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1 pl-6 first:mt-0 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-foreground/30 pl-4 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-border" />,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className: c, children }) => {
            // Inline code has no language class; fenced blocks come wrapped in
            // <pre> (styled below), so here we only style the inline variant.
            const isBlock = /language-/.test(c || "");
            if (isBlock) {
              return <code className={cn("font-mono text-[13px]", c)}>{children}</code>;
            }
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto border bg-muted p-3 font-mono text-[13px] leading-relaxed first:mt-0 last:mb-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b">{children}</thead>,
          th: ({ children }) => (
            <th className="border px-3 py-1.5 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border px-3 py-1.5 align-top">{children}</td>,
          // eslint-disable-next-line @next/next/no-img-element -- markdown remote image
          img: ({ src, alt }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={typeof src === "string" ? src : ""} alt={alt || ""} className="my-3 max-w-full" />
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
