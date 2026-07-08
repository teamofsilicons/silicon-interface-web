"use client";

import * as React from "react";

import type { CodeLanguage } from "@/lib/programmatic-files";

export function SourceCodeViewer({
  source,
  language,
}: {
  source: string;
  language: { id: CodeLanguage; label: string } | null;
}) {
  const lang = language?.id ?? "text";
  const formatted = React.useMemo(() => formatSource(source, lang), [source, lang]);
  const lines = React.useMemo(() => formatted.split("\n"), [formatted]);

  return (
    <div className="min-h-[40vh] w-full overflow-auto bg-[var(--terminal-bg)] text-[var(--terminal-fg)]">
      <div className="min-w-max px-0 py-4 font-mono text-xs leading-5">
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid grid-cols-[3.25rem_minmax(0,1fr)]"
          >
            <span className="select-none pr-3 text-right text-[var(--terminal-accent)] opacity-55">
              {index + 1}
            </span>
            <code className="block whitespace-pre pr-6">
              {line ? highlightLine(line, lang) : " "}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatSource(source: string, language: CodeLanguage): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (language === "json") {
    try {
      return `${JSON.stringify(JSON.parse(normalized), null, 2)}\n`;
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function highlightLine(line: string, language: CodeLanguage): React.ReactNode[] {
  if (language === "html" || language === "xml" || language === "svg") {
    return highlightWithPattern(line, MARKUP_TOKEN, (token) =>
      markupTokenClass(token),
    );
  }
  if (language === "css") {
    return highlightWithPattern(line, CSS_TOKEN, (token) =>
      cssTokenClass(token),
    );
  }
  if (language === "json") {
    return highlightWithPattern(line, JSON_TOKEN, (token) =>
      jsonTokenClass(token),
    );
  }
  if (language === "markdown") {
    return highlightWithPattern(line, MARKDOWN_TOKEN, (token) =>
      markdownTokenClass(token),
    );
  }
  return highlightWithPattern(line, CODE_TOKEN, (token) =>
    codeTokenClass(token, language),
  );
}

function highlightWithPattern(
  line: string,
  pattern: RegExp,
  classForToken: (token: string) => string | null,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(line.slice(cursor, index));
    const className = classForToken(token);
    nodes.push(
      className ? (
        <span key={`${index}-${token}`} className={className}>
          {token}
        </span>
      ) : (
        token
      ),
    );
    cursor = index + token.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

const MARKUP_TOKEN =
  /<!--.*?-->|<!\[CDATA\[.*?\]\]>|<\/?[\w:.-]+|\/?>|=|"[^"]*"|'[^']*'|[\w:.-]+(?=\s*=)|&[#\w]+;/g;
const CSS_TOKEN =
  /\/\*.*?\*\/|#[\da-fA-F]{3,8}\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|--?[\w-]+(?=\s*:)|[\w-]+(?=\s*:)|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b|[{}()[\].,;:+\-*/%<>=!&|?~^@]|\b[a-zA-Z_-][\w-]*\b/g;
const JSON_TOKEN =
  /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|true|false|null|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[{}[\],:]/gi;
const MARKDOWN_TOKEN =
  /(`{1,3}[^`]*`{1,3}|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|~~[^~]+~~|[>`*_~-])/g;
const CODE_TOKEN =
  /\/\/.*|#.*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\].,;:+\-*/%<>=!&|?~^@]+/g;

const KEYWORDS = new Set([
  "abstract",
  "and",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "defer",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "go",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "let",
  "match",
  "module",
  "mut",
  "new",
  "nil",
  "null",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "select",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "undefined",
  "use",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const SQL_KEYWORDS = new Set([
  "alter",
  "and",
  "as",
  "by",
  "case",
  "create",
  "delete",
  "desc",
  "distinct",
  "drop",
  "else",
  "end",
  "from",
  "group",
  "having",
  "in",
  "insert",
  "into",
  "join",
  "left",
  "limit",
  "not",
  "null",
  "on",
  "or",
  "order",
  "right",
  "select",
  "set",
  "table",
  "then",
  "update",
  "values",
  "when",
  "where",
]);

function markupTokenClass(token: string): string | null {
  if (token.startsWith("<!--")) return "text-[var(--terminal-accent)] opacity-60";
  if (token.startsWith("<")) return "font-semibold text-[var(--terminal-accent)]";
  if (token === "=" || token === ">" || token === "/>") {
    return "text-[var(--terminal-fg)] opacity-65";
  }
  if (isQuoted(token)) return "text-[var(--terminal-fg)] opacity-90";
  if (/^[\w:.-]+$/.test(token)) return "text-[var(--terminal-accent)] opacity-85";
  return null;
}

function cssTokenClass(token: string): string | null {
  if (token.startsWith("/*")) return "text-[var(--terminal-accent)] opacity-60";
  if (token.startsWith("#")) return "text-[var(--terminal-accent)]";
  if (isQuoted(token)) return "text-[var(--terminal-fg)] opacity-90";
  if (/^--?[\w-]+$/.test(token) || /^[\w-]+$/.test(token)) {
    return token.startsWith("--")
      ? "text-[var(--terminal-accent)]"
      : "text-[var(--terminal-fg)]";
  }
  if (/^\d/.test(token)) return "text-[var(--terminal-accent)]";
  if (/^[{}()[\].,;:+\-*/%<>=!&|?~^@]+$/.test(token)) {
    return "text-[var(--terminal-fg)] opacity-65";
  }
  return null;
}

function jsonTokenClass(token: string): string | null {
  if (token.startsWith("\"") && /"\s*$/.test(token)) {
    return "text-[var(--terminal-fg)]";
  }
  if (isQuoted(token)) return "text-[var(--terminal-fg)] opacity-85";
  if (/^(true|false|null)$/i.test(token)) return "font-semibold text-[var(--terminal-accent)]";
  if (/^-?\d/.test(token)) return "text-[var(--terminal-accent)]";
  if (/^[{}[\],:]$/.test(token)) return "text-[var(--terminal-fg)] opacity-65";
  return null;
}

function markdownTokenClass(token: string): string | null {
  if (/^#{1,6}\s$/.test(token) || /^>\s*$/.test(token)) {
    return "font-semibold text-[var(--terminal-accent)]";
  }
  if (token.startsWith("`")) return "text-[var(--terminal-accent)]";
  if (/^!?\[[^\]]/.test(token)) return "text-[var(--terminal-fg)] underline";
  return "text-[var(--terminal-accent)]";
}

function codeTokenClass(token: string, language: CodeLanguage): string | null {
  if (
    token.startsWith("//") ||
    token.startsWith("/*") ||
    (token.startsWith("#") && (language === "python" || language === "shell" || language === "ruby"))
  ) {
    return "text-[var(--terminal-accent)] opacity-60";
  }
  if (isQuoted(token)) return "text-[var(--terminal-fg)] opacity-90";
  if (/^\d/.test(token)) return "text-[var(--terminal-accent)]";
  if (/^[{}()[\].,;:+\-*/%<>=!&|?~^@]+$/.test(token)) {
    return "text-[var(--terminal-fg)] opacity-65";
  }
  const normalized = token.toLowerCase();
  if (language === "sql" && SQL_KEYWORDS.has(normalized)) {
    return "font-semibold uppercase text-[var(--terminal-accent)]";
  }
  if (KEYWORDS.has(normalized)) return "font-semibold text-[var(--terminal-accent)]";
  if (/^[A-Z][\w$]*$/.test(token)) return "text-[var(--terminal-fg)] font-semibold";
  return null;
}

function isQuoted(token: string): boolean {
  return (
    (token.startsWith("\"") && token.endsWith("\"")) ||
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith("`") && token.endsWith("`"))
  );
}
