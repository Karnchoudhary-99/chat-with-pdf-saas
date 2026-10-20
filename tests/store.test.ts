import { describe, expect, it } from "vitest";
import { HashEmbedder } from "../src/embeddings.js";
import { VectorStore, cosineSimilarity } from "../src/store.js";
import type { Chunk } from "../src/types.js";

const mkChunk = (docId: string, index: number, text: string): Chunk => ({
  chunkId: `${docId}#${index}`,
  docId,
  index,
  text,
  charStart: 0,
  charEnd: text.length,
  section: null,
  tokenEstimate: Math.round(text.length / 4),
});

describe("cosineSimilarity", () => {
  it("is 1 for identical unit vectors, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  it("rejects dimension mismatches", () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/mismatch/);
  });
});

describe("HashEmbedder", () => {
  it("is deterministic and L2-normalized", async () => {
    const e = new HashEmbedder(128);
    const [a] = await e.embed(["hello world"]);
    const [b] = await e.embed(["hello world"]);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1);
  });

  it("puts related texts closer than unrelated ones", async () => {
    const e = new HashEmbedder(256);
    const [q, near, far] = await e.embed([
      "refund policy thirty days",
      "refunds issued within 30 days of purchase",
      "quantum entanglement photon spin",
    ]);
    expect(cosineSimilarity(q!, near!)).toBeGreaterThan(
      cosineSimilarity(q!, far!),
    );
  });

  it("handles empty text without NaN", async () => {
    const e = new HashEmbedder(64);
    const [v] = await e.embed([""]);
    expect(v!.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("VectorStore", () => {
  const setup = async () => {
    const embedder = new HashEmbedder(128);
    const store = new VectorStore();
    const chunks = [
      mkChunk("doc_a", 0, "refunds are issued within thirty days of purchase"),
      mkChunk("doc_a", 1, "plans start at nine dollars per month"),
      mkChunk("doc_b", 0, "the server restarts every sunday at midnight"),
    ];
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    store.addDocument("doc_a", "Manual A", chunks.slice(0, 2), vectors.slice(0, 2));
    store.addDocument("doc_b", "Manual B", chunks.slice(2), vectors.slice(2));
    return { store, embedder };
  };

  it("ranks the most relevant chunk first", async () => {
    const { store, embedder } = await setup();
    const [q] = await embedder.embed(["how do refunds work, thirty days?"]);
    const hits = store.search(q!, 2);
    expect(hits[0]!.chunk.text).toContain("refunds");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("scopes search to requested docIds", async () => {
    const { store, embedder } = await setup();
    const [q] = await embedder.embed(["server restarts sunday"]);
    const hits = store.search(q!, 5, ["doc_a"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.chunk.docId === "doc_a")).toBe(true);
  });

  it("round-trips through JSON persistence", async () => {
    const { store, embedder } = await setup();
    await store.save("/tmp/cwp-store.json");
    const loaded = await VectorStore.load("/tmp/cwp-store.json");
    expect(loaded.docCount).toBe(2);
    expect(loaded.chunkCount).toBe(3);
    const [q] = await embedder.embed(["nine dollars per month"]);
    const hits = loaded.search(q!, 1);
    expect(hits[0]!.chunk.text).toContain("nine dollars");
  });

  it("rejects mixed dimensions and empty adds", async () => {
    const { store } = await setup();
    expect(() =>
      store.addDocument("doc_c", "C", [mkChunk("doc_c", 0, "x")], [[1, 2, 3]]),
    ).toThrow(/dimension/);
    expect(() => store.addDocument("doc_c", "C", [], [])).toThrow(/empty/);
  });

  it("removeDocument drops the doc and lists the rest", async () => {
    const { store } = await setup();
    expect(store.removeDocument("doc_b")).toBe(true);
    expect(store.removeDocument("doc_b")).toBe(false);
    expect(store.listDocuments().map((d) => d.docId)).toEqual(["doc_a"]);
  });
});
