/**
 * PDF ingestion: extract text + metadata from PDF bytes using pdf.js.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createHash, randomBytes } from "node:crypto";
import type { DocumentMeta, TextSection } from "./types.js";

export interface IngestedDocument {
  meta: DocumentMeta;
  /** Full normalized document text. */
  text: string;
  /** Text split into heading-delimited sections. */
  sections: TextSection[];
}

/** Normalize whitespace: collapse runs, trim, unify newlines. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split normalized text into sections on markdown-style headings
 * (`# .. ######`) or ALL-CAPS short lines (common in PDFs).
 */
export function splitSections(text: string): TextSection[] {
  const lines = text.split("\n");
  const sections: TextSection[] = [];
  let current: { heading: string | null; buf: string[] } = {
    heading: null,
    buf: [],
  };

  const isHeading = (line: string): boolean => {
    if (/^#{1,6}\s+\S/.test(line)) return true;
    const t = line.trim();
    return (
      t.length > 0 &&
      t.length <= 80 &&
      t === t.toUpperCase() &&
      /[A-Z]/.test(t) &&
      !/[.!?]$/.test(t)
    );
  };

  for (const line of lines) {
    if (isHeading(line)) {
      if (current.buf.length > 0 || current.heading !== null) {
        sections.push({
          heading: current.heading,
          text: current.buf.join("\n").trim(),
          page: null,
        });
      }
      current = { heading: line.replace(/^#{1,6}\s+/, "").trim(), buf: [] };
    } else {
      current.buf.push(line);
    }
  }
  if (current.buf.length > 0 || current.heading !== null) {
    sections.push({
      heading: current.heading,
      text: current.buf.join("\n").trim(),
      page: null,
    });
  }
  return sections.filter((s) => s.text.length > 0 || s.heading !== null);
}

export function makeDocId(seed: string): string {
  return (
    "doc_" +
    createHash("sha256").update(seed).digest("hex").slice(0, 8) +
    "_" +
    randomBytes(3).toString("hex")
  );
}

/** Extract per-page text from raw PDF bytes. Throws on invalid input. */
export async function extractTextFromPdf(
  buffer: Buffer,
  opts: { maxPages?: number } = {},
): Promise<{ text: string; pageCount: number; title: string | null }> {
  if (!buffer || buffer.length === 0) {
    throw new Error("extractTextFromPdf: empty buffer");
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pageCount = doc.numPages;
  const limit =
    opts.maxPages && opts.maxPages > 0
      ? Math.min(opts.maxPages, pageCount)
      : pageCount;
  const pageTexts: string[] = [];
  for (let p = 1; p <= limit; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Reconstruct lines from glyph y-coordinates (transform[5]): a drop of
    // more than ~2pt means a new line. Keeps headings on their own lines.
    const lines: string[] = [];
    let line = "";
    let lastY: number | null = null;
    for (const item of tc.items) {
      if (!("str" in item) || !("transform" in item)) continue;
      const y = (item.transform as number[])[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        if (line.trim().length > 0) lines.push(line.trim());
        line = "";
      }
      lastY = y;
      line += (line.length > 0 && !line.endsWith(" ") ? " " : "") + (item.str as string);
    }
    if (line.trim().length > 0) lines.push(line.trim());
    pageTexts.push(lines.join("\n"));
    page.cleanup();
  }
  let title: string | null = null;
  try {
    const metadata = await doc.getMetadata();
    const infoTitle = (metadata?.info as Record<string, unknown> | undefined)
      ?.Title;
    if (typeof infoTitle === "string" && infoTitle.length > 0) title = infoTitle;
  } catch {
    // metadata is best-effort
  }
  await doc.destroy();
  return {
    text: normalizeText(pageTexts.join("\n\n")),
    pageCount,
    title,
  };
}

/** Full ingest pipeline for one PDF: parse -> normalize -> section-split. */
export async function ingestPdf(
  buffer: Buffer,
  source: string,
): Promise<IngestedDocument> {
  const { text, pageCount, title } = await extractTextFromPdf(buffer);
  if (text.length === 0) {
    throw new Error(`ingestPdf: no extractable text in ${source}`);
  }
  const docId = makeDocId(source + "|" + text.length + "|" + text.slice(0, 64));
  const sections = splitSections(text);
  return {
    meta: {
      docId,
      title: title ?? source.replace(/\.[^.]+$/, ""),
      source,
      pageCount,
      charCount: text.length,
    },
    text,
    sections,
  };
}
