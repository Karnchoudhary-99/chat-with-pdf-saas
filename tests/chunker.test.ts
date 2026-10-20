import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunker.js";
import { splitSections } from "../src/ingest.js";

const lorem = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("chunkText", () => {
  it("packs words into token-budgeted chunks with overlap", () => {
    const text = lorem(2000); // ~2000 words ≈ 1600+ tokens of ~6-char words
    const chunks = chunkText("doc_1", text, [], {
      targetTokens: 200,
      overlapTokens: 40,
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(800);
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.chunkId).toBe(`doc_1#${c.index}`);
    }
    // Overlap: consecutive chunks share words.
    const w0 = new Set(chunks[0]!.text.split(" "));
    const shared = chunks[1]!.text.split(" ").filter((w) => w0.has(w));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("assigns section headings and correct char offsets", () => {
    const text = "# Setup\ninstall the thing\n# Billing\npay the bill\n";
    const sections = splitSections(text);
    const chunks = chunkText("doc_2", text, sections, { targetTokens: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      // Offsets must round-trip to the chunk text.
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
      expect(["Setup", "Billing"]).toContain(c.section);
    }
    // First chunk starts at offset 0.
    expect(chunks[0]!.charStart).toBe(0);
  });

  it("never loses words across chunk boundaries", () => {
    const text = lorem(500);
    const chunks = chunkText("doc_3", text, [], {
      targetTokens: 100,
      overlapTokens: 10,
    });
    const all = new Set(text.split(" "));
    const covered = new Set<string>();
    for (const c of chunks) for (const w of c.text.split(" ")) covered.add(w);
    expect(covered).toEqual(all);
  });

  it("keeps a single huge word intact instead of looping forever", () => {
    const text = "a".repeat(5000);
    const chunks = chunkText("doc_4", text, [], { targetTokens: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
  });

  it("returns an empty array for empty text", () => {
    expect(chunkText("doc_5", "", [], {})).toEqual([]);
  });
});
