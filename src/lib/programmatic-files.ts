export type CodeLanguage =
  | "c"
  | "cpp"
  | "css"
  | "csv"
  | "env"
  | "go"
  | "html"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "jsx"
  | "markdown"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "svg"
  | "svelte"
  | "text"
  | "toml"
  | "tsx"
  | "typescript"
  | "vue"
  | "xml"
  | "yaml";

export interface CodeFileInfo {
  id: CodeLanguage;
  label: string;
}

const EXT_TO_LANGUAGE: Record<string, CodeFileInfo> = {
  c: { id: "c", label: "C" },
  cc: { id: "cpp", label: "C++" },
  conf: { id: "ini", label: "Config" },
  cpp: { id: "cpp", label: "C++" },
  cs: { id: "java", label: "C#" },
  css: { id: "css", label: "CSS" },
  csv: { id: "csv", label: "CSV" },
  env: { id: "env", label: "ENV" },
  go: { id: "go", label: "Go" },
  h: { id: "c", label: "C" },
  htm: { id: "html", label: "HTML" },
  html: { id: "html", label: "HTML" },
  hpp: { id: "cpp", label: "C++" },
  ini: { id: "ini", label: "INI" },
  java: { id: "java", label: "Java" },
  js: { id: "javascript", label: "JavaScript" },
  json: { id: "json", label: "JSON" },
  jsonc: { id: "json", label: "JSON" },
  jsx: { id: "jsx", label: "JSX" },
  log: { id: "text", label: "Text" },
  markdown: { id: "markdown", label: "Markdown" },
  md: { id: "markdown", label: "Markdown" },
  mdx: { id: "markdown", label: "MDX" },
  mjs: { id: "javascript", label: "JavaScript" },
  php: { id: "php", label: "PHP" },
  py: { id: "python", label: "Python" },
  rb: { id: "ruby", label: "Ruby" },
  rs: { id: "rust", label: "Rust" },
  scss: { id: "css", label: "SCSS" },
  sh: { id: "shell", label: "Shell" },
  sql: { id: "sql", label: "SQL" },
  svg: { id: "svg", label: "SVG" },
  svelte: { id: "svelte", label: "Svelte" },
  text: { id: "text", label: "Text" },
  toml: { id: "toml", label: "TOML" },
  ts: { id: "typescript", label: "TypeScript" },
  tsx: { id: "tsx", label: "TSX" },
  txt: { id: "text", label: "Text" },
  vue: { id: "vue", label: "Vue" },
  xml: { id: "xml", label: "XML" },
  yaml: { id: "yaml", label: "YAML" },
  yml: { id: "yaml", label: "YAML" },
  zsh: { id: "shell", label: "Shell" },
};

export function fileExtension(name?: string | null): string {
  const clean = (name || "").toLowerCase().split(/[?#]/, 1)[0];
  const last = clean.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  return dot >= 0 ? last.slice(dot + 1) : "";
}

export function languageForFile(
  name?: string | null,
  mime?: string | null,
): CodeFileInfo | null {
  const ext = fileExtension(name);
  if (ext && EXT_TO_LANGUAGE[ext]) return EXT_TO_LANGUAGE[ext];

  const m = (mime || "").toLowerCase();
  if (!m) return null;
  if (m.includes("svg")) return { id: "svg", label: "SVG" };
  if (m.includes("html")) return { id: "html", label: "HTML" };
  if (m.includes("markdown")) return { id: "markdown", label: "Markdown" };
  if (m.includes("javascript") || m.includes("ecmascript")) {
    return { id: "javascript", label: "JavaScript" };
  }
  if (m.includes("typescript")) return { id: "typescript", label: "TypeScript" };
  if (m.includes("json")) return { id: "json", label: "JSON" };
  if (m.includes("xml")) return { id: "xml", label: "XML" };
  if (m.includes("yaml") || m.includes("yml")) return { id: "yaml", label: "YAML" };
  if (m.includes("toml")) return { id: "toml", label: "TOML" };
  if (m.includes("css")) return { id: "css", label: "CSS" };
  if (m.includes("csv")) return { id: "csv", label: "CSV" };
  if (m.startsWith("text/")) return { id: "text", label: "Text" };
  return null;
}

export function isTextLikeFile(name?: string | null, mime?: string | null): boolean {
  if (languageForFile(name, mime)) return true;
  const m = (mime || "").toLowerCase();
  return (
    m.startsWith("text/") ||
    m.includes("json") ||
    m.includes("xml") ||
    m.includes("javascript") ||
    m.includes("typescript")
  );
}

export function hasRenderedSourcePreview(
  name?: string | null,
  mime?: string | null,
): boolean {
  const lang = languageForFile(name, mime)?.id;
  return lang === "csv" || lang === "html" || lang === "markdown" || lang === "svg";
}
