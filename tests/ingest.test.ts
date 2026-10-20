import { describe, expect, it } from "vitest";
import {
  extractTextFromPdf,
  ingestPdf,
  makeDocId,
  normalizeText,
  splitSections,
} from "../src/ingest.js";
import { sampleManualPdf } from "./fixtures.js";

describe("normalizeText", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeText("  hello   \n\n\n world\r\n")).toBe("hello\n\nworld");
  });
});

describe("splitSections", () => {
  it("splits on markdown headings", () => {
    const secs = splitSections("# Intro\nbody one\n## Details\nbody two");
    expect(secs.map((s) => s.heading)).toEqual(["Intro", "Details"]);
    expect(secs[0]!.text).toBe("body one");
  });

  it("treats ALL-CAPS short lines as headings", () => {
    const secs = splitSections("BILLING\nPlans start at $9.\nREFUNDS\nWithin 30 days.");
    expect(secs.map((s) => s.heading)).toEqual(["BILLING", "REFUNDS"]);
  });

  it("keeps one section when there are no headings", () => {
    const secs = splitSections("just some plain text here");
    expect(secs).toHaveLength(1);
    expect(secs[0]!.heading).toBeNull();
  });
});

describe("makeDocId", () => {
  it("is unique per call but stable in shape", () => {
    const a = makeDocId("x");
    const b = makeDocId("x");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^doc_[0-9a-f]{8}_[0-9a-f]{6}$/);
  });
});

describe("extractTextFromPdf", () => {
  it("extracts text and page count from a generated PDF", async () => {
    const { text, pageCount } = await extractTextFromPdf(sampleManualPdf());
    expect(pageCount).toBe(2);
    expect(text).toContain("ACME Cloud");
    expect(text).toContain("Refunds are issued within 30 days");
  });

  it("rejects empty buffers", async () => {
    await expect(extractTextFromPdf(Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it("rejects non-PDF bytes", async () => {
    await expect(
      extractTextFromPdf(Buffer.from("definitely not a pdf")),
    ).rejects.toThrow();
  });
});

describe("ingestPdf", () => {
  it("produces meta, text and sections end to end", async () => {
    const doc = await ingestPdf(sampleManualPdf(), "manual.pdf");
    expect(doc.meta.source).toBe("manual.pdf");
    expect(doc.meta.pageCount).toBe(2);
    expect(doc.meta.charCount).toBeGreaterThan(50);
    expect(doc.meta.docId).toMatch(/^doc_/);
    expect(doc.sections.length).toBeGreaterThanOrEqual(2);
    expect(doc.text).toContain("ACME Cloud");
  });

  it("throws when the PDF has no extractable text", async () => {
    const empty = Buffer.from("not a pdf at all");
    await expect(ingestPdf(empty, "empty.pdf")).rejects.toThrow();
  });
});
