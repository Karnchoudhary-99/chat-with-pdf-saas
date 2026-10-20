/**
 * In-memory vector store: per-document chunk vectors with cosine search
 * and JSON persistence. Small-scale by design (the SaaS tier shards by
 * docId); brute-force scan keeps the code honest and testable.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Chunk } from "./types.js";

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dimension mismatch ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // callers store L2-normalized vectors
}

interface StoredDoc {
  docId: string;
  title: string;
  chunks: Chunk[];
  vectors: number[][];
}

export class VectorStore {
  private docs = new Map<string, StoredDoc>();
  private dimension: number | null = null;

  get docCount(): number {
    return this.docs.size;
  }
  get chunkCount(): number {
    let n = 0;
    for (const d of this.docs.values()) n += d.chunks.length;
    return n;
  }
  get vectorDimension(): number | null {
    return this.dimension;
  }

  addDocument(
    docId: string,
    title: string,
    chunks: Chunk[],
    vectors: number[][],
  ): void {
    if (chunks.length !== vectors.length) {
      throw new Error("VectorStore.addDocument: chunks/vectors length mismatch");
    }
    if (chunks.length === 0) throw new Error("VectorStore.addDocument: empty");
    const dim = vectors[0]!.length;
    if (this.dimension === null) this.dimension = dim;
    else if (this.dimension !== dim) {
      throw new Error(
        `VectorStore.addDocument: dimension ${dim} != store dimension ${this.dimension}`,
      );
    }
    this.docs.set(docId, { docId, title, chunks, vectors });
  }

  removeDocument(docId: string): boolean {
    const ok = this.docs.delete(docId);
    if (this.docs.size === 0) this.dimension = null;
    return ok;
  }

  listDocuments(): { docId: string; title: string; chunks: number }[] {
    return [...this.docs.values()].map((d) => ({
      docId: d.docId,
      title: d.title,
      chunks: d.chunks.length,
    }));
  }

  /** Internal rehydration support: iterate stored documents with vectors. */
  entries(): { docId: string; title: string; chunks: Chunk[]; vectors: number[][] }[] {
    return [...this.docs.values()];
  }

  /** Restore the store dimension when rehydrating from a snapshot. */
  setDimension(dim: number | null): void {
    this.dimension = dim;
  }

  getDimension(): number | null {
    return this.dimension;
  }

  /** Cosine search over all docs, or a subset when docIds is given. */
  search(
    queryVector: number[],
    topK: number,
    docIds?: string[],
  ): ScoredChunk[] {
    if (this.dimension !== null && queryVector.length !== this.dimension) {
      throw new Error("VectorStore.search: query dimension mismatch");
    }
    const docs = docIds
      ? docIds.flatMap((id) => {
          const d = this.docs.get(id);
          return d ? [d] : [];
        })
      : [...this.docs.values()];
    const scored: ScoredChunk[] = [];
    for (const d of docs) {
      for (let i = 0; i < d.chunks.length; i++) {
        scored.push({
          chunk: d.chunks[i]!,
          score: cosineSimilarity(queryVector, d.vectors[i]!),
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, topK));
  }

  async save(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const payload = {
      version: 1,
      dimension: this.dimension,
      docs: [...this.docs.values()],
    };
    await writeFile(filePath, JSON.stringify(payload));
  }

  static async load(filePath: string): Promise<VectorStore> {
    const raw = await readFile(filePath, "utf8");
    const payload = JSON.parse(raw) as {
      version: number;
      dimension: number | null;
      docs: StoredDoc[];
    };
    if (payload.version !== 1) {
      throw new Error(`VectorStore.load: unsupported version ${payload.version}`);
    }
    const store = new VectorStore();
    store.dimension = payload.dimension;
    for (const d of payload.docs) store.docs.set(d.docId, d);
    return store;
  }
}
