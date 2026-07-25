import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseCsvPreview } from "../../src/lib/csv-preview.ts";
import { compactUrlLabel, linkifyHttpText } from "../../src/lib/link-display.ts";
import {
  hasRenderedSourcePreview,
  isTextLikeFile,
  languageForFile,
} from "../../src/lib/programmatic-files.ts";

test("CSV files select the rendered table preview by extension or MIME", () => {
  assert.equal(hasRenderedSourcePreview("report.CSV", "application/octet-stream"), true);
  assert.equal(hasRenderedSourcePreview("report", "text/csv; charset=utf-8"), true);
});

test("historical CSV previews use the stable authenticated media route", async () => {
  const [previewSource, apiSource] = await Promise.all([
    readFile(new URL("../../src/lib/text-preview.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/lib/api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(previewSource, /api\.mediaTextPreview\(mediaId/);
  assert.match(apiSource, /\/content\?head=\$\{bounded\}/);
  assert.match(previewSource, /\.catch\(directHead\)/);
});

test("TXT and JSON files open as authenticated source previews", async () => {
  assert.equal(isTextLikeFile("notes.txt", "application/octet-stream"), true);
  assert.equal(languageForFile("notes.txt")?.id, "text");
  assert.equal(isTextLikeFile("payload.json", "application/octet-stream"), true);
  assert.equal(languageForFile("payload.json")?.id, "json");

  const previewer = await readFile(
    new URL("../../src/components/chat/media-previewer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(previewer, /api\.mediaTextPreview\(sourceMediaId, 256 \* 1024\)/);
  assert.match(previewer, /\.catch\(directText\)/);
});

test("CSV preview parses quoted separators, escaped quotes, and record breaks", () => {
  const preview = parseCsvPreview(
    '\uFEFFname,notes,total\r\nAda,"line one\r\nline two",10\r\nLin,"said ""hello""",20',
  );

  assert.deepEqual(preview.headers, ["name", "notes", "total"]);
  assert.deepEqual(preview.rows, [
    ["Ada", "line one\nline two", "10"],
    ["Lin", 'said "hello"', "20"],
  ]);
  assert.equal(preview.truncatedRows, false);
});

test("CSV preview pads short headers and bounds rows, columns, and cells", () => {
  const preview = parseCsvPreview("a\n1,toolong,hidden\n2,b,c\n3,d,e", {
    maxRows: 2,
    maxColumns: 2,
    maxCellCharacters: 3,
  });

  assert.deepEqual(preview.headers, ["a", ""]);
  assert.deepEqual(preview.rows, [["1", "too…"], ["2", "b"]]);
  assert.equal(preview.truncatedRows, true);
  assert.equal(preview.truncatedColumns, true);
  assert.equal(preview.truncatedCells, true);
});

test("CSV preview does not invent a row for a trailing record break", () => {
  const preview = parseCsvPreview("a,b\n1,2\n");
  assert.deepEqual(preview.rows, [["1", "2"]]);
});

test("CSV cells linkify safe URLs while keeping compact readable labels", () => {
  const destination =
    "https://www.linkedin.com/sales/search/company?query=(filters%3AList((type%3AANNUAL_REVENUE)))&sessionId=secret";
  const segments = linkifyHttpText(`Profile: ${destination}.`);
  const link = segments.find((segment) => segment.href);

  assert.equal(link?.href, destination);
  assert.match(link?.text ?? "", /^linkedin\.com\/sales\/search\/company\?…$/);
  assert.equal(segments.at(-1)?.text, ".");
  assert.ok((link?.text.length ?? 1000) < destination.length);
});

test("compact URL labels preserve useful paths but bound very long ones", () => {
  const label = compactUrlLabel(
    "https://www.example.com/a/very/long/path/that/keeps/going/for/a/while?tracking=1",
    36,
  );
  assert.equal(label.length, 36);
  assert.match(label, /^example\.com\//);
  assert.match(label, /…/);
});
