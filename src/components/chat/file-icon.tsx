import type { Icon } from "@phosphor-icons/react";
import {
  File,
  FileAudio,
  FileC,
  FileCode,
  FileCpp,
  FileCss,
  FileCsv,
  FileDoc,
  FileHtml,
  FileImage,
  FileIni,
  FileJs,
  FileJsx,
  FileMd,
  FilePdf,
  FilePpt,
  FilePy,
  FileRs,
  FileSql,
  FileSvg,
  FileText,
  FileTs,
  FileTsx,
  FileVideo,
  FileVue,
  FileXls,
  FileZip,
} from "@phosphor-icons/react/dist/ssr";

// Extension → glyph. Covers the common cases; everything else falls back to a
// type-family guess from the mime, then the generic File.
const BY_EXT: Record<string, Icon> = {
  pdf: FilePdf,
  zip: FileZip,
  rar: FileZip,
  "7z": FileZip,
  tar: FileZip,
  gz: FileZip,
  tgz: FileZip,
  bz2: FileZip,
  doc: FileDoc,
  docx: FileDoc,
  rtf: FileDoc,
  odt: FileDoc,
  xls: FileXls,
  xlsx: FileXls,
  ods: FileXls,
  ppt: FilePpt,
  pptx: FilePpt,
  odp: FilePpt,
  csv: FileCsv,
  md: FileMd,
  markdown: FileMd,
  mdx: FileMd,
  txt: FileText,
  text: FileText,
  log: FileText,
  epub: FileText,
  html: FileHtml,
  htm: FileHtml,
  css: FileCss,
  scss: FileCss,
  js: FileJs,
  mjs: FileJs,
  cjs: FileJs,
  jsx: FileJsx,
  ts: FileTs,
  tsx: FileTsx,
  json: FileCode,
  yml: FileCode,
  yaml: FileCode,
  toml: FileIni,
  ini: FileIni,
  cfg: FileIni,
  conf: FileIni,
  py: FilePy,
  rs: FileRs,
  c: FileC,
  h: FileC,
  cpp: FileCpp,
  cc: FileCpp,
  hpp: FileCpp,
  sql: FileSql,
  svg: FileSvg,
  vue: FileVue,
};

const PREVIEWABLE_EXT = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif",
  "mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "aac", "flac",
  "md", "markdown", "mdx", "txt", "text", "log", "csv", "json", "html", "htm",
]);

/** Can MediaPreviewer render this inline? If not, a click should just download. */
export function isPreviewable(name?: string | null, mime?: string | null): boolean {
  const m = (mime || "").toLowerCase();
  if (
    m.startsWith("image/") ||
    m.startsWith("video/") ||
    m.startsWith("audio/") ||
    m.includes("pdf") ||
    m.includes("markdown") ||
    m.startsWith("text/") ||
    m.includes("json")
  ) {
    return true;
  }
  const ext = (name || "").toLowerCase().split(".").pop() || "";
  return PREVIEWABLE_EXT.has(ext);
}

/** Pick the most specific Phosphor glyph for a file, by extension then mime. */
export function fileGlyph(name?: string | null, mime?: string | null): Icon {
  const ext = (name || "").toLowerCase().split(".").pop() || "";
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return FileImage;
  if (m.startsWith("video/")) return FileVideo;
  if (m.startsWith("audio/")) return FileAudio;
  if (m.includes("pdf")) return FilePdf;
  if (m.includes("zip") || m.includes("compressed") || m.includes("tar")) return FileZip;
  if (m.includes("json") || m.includes("xml") || m.startsWith("text/")) return FileText;
  return File;
}
