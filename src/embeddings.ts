/**
 * Embedders: turn chunk text into dense vectors.
 *
 * HashEmbedder is a deterministic, dependency-free baseline (signed token
 * hashing into a fixed dimension + L2 normalization) so the whole pipeline
 * runs offline. OpenAIEmbedder speaks the OpenAI-compatible /v1/embeddings
 * HTTP API for production quality.
 */
import { createHash } from "node:crypto";

export interface Embedder {
  readonly dimension: number;
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(stem);
}

/** Tiny deterministic stemmer so "refunds" matches "refund". */
function stem(t: string): string {
  if (t.length <= 3) return t;
  if (t.endsWith("ies") && t.length > 5) return t.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("es") && t.length > 4 && !t.endsWith("aes")) return t.slice(0, -1);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Deterministic signed hash of a token -> [0, dim). */
function hashToken(token: string, dim: number): { idx: number; sign: 1 | -1 } {
  const h = createHash("sha256").update(token).digest();
  const idx = h.readUInt32BE(0) % dim;
  const sign = h[4]! % 2 === 0 ? 1 : -1;
  return { idx, sign };
}

export class HashEmbedder implements Embedder {
  readonly name = "hash";
  constructor(readonly dimension: number = 384) {
    if (dimension <= 0) throw new Error("HashEmbedder: dimension must be > 0");
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const vec = new Array<number>(this.dimension).fill(0);
      for (const tok of tokenize(t)) {
        const { idx, sign } = hashToken(tok, this.dimension);
        vec[idx]! += sign;
      }
      // L2-normalize; fall back to a uniform unit vector for empty text.
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm === 0) {
        return new Array<number>(this.dimension).fill(
          1 / Math.sqrt(this.dimension),
        );
      }
      return vec.map((v) => v / norm);
    });
  }
}

export interface OpenAIEmbedderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  batchSize?: number;
}

/** OpenAI-compatible embeddings client (OpenAI, Azure, Ollama, vLLM, ...). */
export class OpenAIEmbedder implements Embedder {
  readonly name: string;
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize: number;

  constructor(opts: OpenAIEmbedderOptions & { dimension: number }) {
    this.dimension = opts.dimension;
    this.model = opts.model ?? "text-embedding-3-small";
    this.name = `openai:${this.model}`;
    this.baseUrl =
      opts.baseUrl ?? process.env.EMBEDDINGS_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = opts.apiKey ?? process.env.EMBEDDINGS_API_KEY ?? "";
    this.batchSize = opts.batchSize ?? 64;
    if (!this.apiKey) {
      throw new Error(
        "OpenAIEmbedder: set EMBEDDINGS_API_KEY or pass apiKey",
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!res.ok) {
        throw new Error(
          `OpenAIEmbedder: HTTP ${res.status} ${await res.text().catch(() => "")}`,
        );
      }
      const json = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) {
        if (d.embedding.length !== this.dimension) {
          throw new Error(
            `OpenAIEmbedder: expected dim ${this.dimension}, got ${d.embedding.length}`,
          );
        }
        out.push(d.embedding);
      }
    }
    return out;
  }
}
