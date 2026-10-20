/**
 * DocumentLibrary: the full RAG pipeline in one place.
 * upload(pdf) -> ingest -> chunk -> embed -> store (persisted to disk).
 * Used by both the HTTP API and the CLI.
 */
import { ingestPdf } from "./ingest.js";
import { chunkText, type ChunkerOptions } from "./chunker.js";
import { HashEmbedder, type Embedder } from "./embeddings.js";
import { VectorStore } from "./store.js";
import type { DocumentMeta } from "./types.js";

export interface LibraryOptions {
  embedder?: Embedder;
  chunker?: ChunkerOptions;
  persistPath?: string;
}

export interface UploadResult {
  meta: DocumentMeta;
  chunks: number;
}

export class DocumentLibrary {
  readonly store = new VectorStore();
  private readonly embedder: Embedder;
  private readonly chunkerOpts: ChunkerOptions;
  private readonly persistPath: string | null;
  private readonly metas = new Map<string, DocumentMeta>();

  constructor(opts: LibraryOptions = {}) {
    this.embedder = opts.embedder ?? new HashEmbedder(384);
    this.chunkerOpts = opts.chunker ?? {};
    this.persistPath = opts.persistPath ?? null;
  }

  static async open(opts: LibraryOptions = {}): Promise<DocumentLibrary> {
    const lib = new DocumentLibrary(opts);
    if (opts.persistPath) {
      try {
        const store = await VectorStore.load(opts.persistPath);
        for (const d of store.entries()) {
          lib.store.addDocument(d.docId, d.title, d.chunks, d.vectors);
          lib.metas.set(d.docId, {
            docId: d.docId,
            title: d.title,
            source: d.title,
            pageCount: 0,
            charCount: d.chunks.reduce((s, c) => s + c.text.length, 0),
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return lib;
  }

  async upload(pdf: Buffer, source: string): Promise<UploadResult> {
    const ingested = await ingestPdf(pdf, source);
    const chunks = chunkText(
      ingested.meta.docId,
      ingested.text,
      ingested.sections,
      this.chunkerOpts,
    );
    if (chunks.length === 0) {
      throw new Error(`upload: no chunks produced for ${source}`);
    }
    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    this.store.addDocument(
      ingested.meta.docId,
      ingested.meta.title,
      chunks,
      vectors,
    );
    this.metas.set(ingested.meta.docId, ingested.meta);
    await this.persist();
    return { meta: ingested.meta, chunks: chunks.length };
  }

  remove(docId: string): boolean {
    const ok = this.store.removeDocument(docId);
    this.metas.delete(docId);
    void this.persist();
    return ok;
  }

  list(): (DocumentMeta & { chunks: number })[] {
    return this.store.listDocuments().map((d) => ({
      ...(this.metas.get(d.docId) ?? {
        docId: d.docId,
        title: d.title,
        source: d.title,
        pageCount: 0,
        charCount: 0,
      }),
      chunks: d.chunks,
    }));
  }

  private async persist(): Promise<void> {
    if (this.persistPath) await this.store.save(this.persistPath);
  }
}
