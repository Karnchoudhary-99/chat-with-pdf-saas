/**
 * Extractive answer composer: retrieve top chunks, pick the sentences with
 * the strongest query-term overlap, and stitch them into a cited answer.
 * Refuses to hallucinate: low retrieval confidence -> escalation.
 */
import type { Embedder } from "./embeddings.js";
import { VectorStore, type ScoredChunk } from "./store.js";

export interface Citation {
  docId: string;
  title: string;
  section: string | null;
  chunkIndex: number;
  excerpt: string;
}

export interface Answer {
  text: string;
  citations: Citation[];
  /** 0..1 — mean score of the cited chunks, normalized. */
  confidence: number;
  /** True when the corpus has no good evidence for the question. */
  escalated: boolean;
}

export interface ComposerOptions {
  topK?: number;
  /**
   * Permissive retrieval floor (default 0.05). Precision comes from the
   * sentence term-overlap gate below, not the score: the offline hash
   * embedder is a weak ranker, so the score only filters pure noise.
   * With a strong embedder (OpenAIEmbedder), raise this.
   */
  minScore?: number;
  /** Max sentences in the composed answer. Default 3. */
  maxSentences?: number;
}

const STOPWORDS = new Set(
  "a,an,the,is,are,was,were,be,been,of,in,on,at,to,for,with,by,from,as,and,or,not,do,does,did,what,when,where,which,who,whom,how,much,many,can,could,should,would,it,its,this,that,these,those,i,you,he,she,we,they,my,your,his,her,our,their,me,him,us,them".split(
    ",",
  ),
);

function queryTerms(question: string): Set<string> {
  return new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function sentences(text: string): string[] {
  const all = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
  // Prefer complete sentences; a trailing fragment is usually a chunk-boundary
  // cut and reads badly as an answer.
  const complete = all.filter((s) => /[.!?]$/.test(s));
  return complete.length > 0 ? complete : all;
}

export class AnswerComposer {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    private readonly opts: ComposerOptions = {},
  ) {}

  async answer(
    question: string,
    docIds?: string[],
  ): Promise<Answer> {
    const topK = this.opts.topK ?? 5;
    const minScore = this.opts.minScore ?? 0.05;
    const maxSentences = this.opts.maxSentences ?? 3;

    if (!question.trim()) {
      return {
        text: "Please ask a question.",
        citations: [],
        confidence: 0,
        escalated: true,
      };
    }

    const [qVec] = await this.embedder.embed([question]);
    const hits = this.store.search(qVec!, topK, docIds);
    const evidence = hits.filter((h) => h.score >= minScore);
    if (evidence.length === 0) {
      return {
        text:
          "I couldn't find anything about that in the uploaded documents. " +
          "Try rephrasing, or upload a document that covers the topic.",
        citations: [],
        confidence: 0,
        escalated: true,
      };
    }

    const terms = queryTerms(question);
    // Best sentence per chunk (max query-term overlap), one citation per chunk.
    const picked: { sentence: string; hit: ScoredChunk; overlap: number }[] = [];
    for (const hit of evidence) {
      let best: { sentence: string; overlap: number } | null = null;
      for (const s of sentences(hit.chunk.text)) {
        const words = new Set(s.toLowerCase().split(/[^a-z0-9]+/));
        let overlap = 0;
        for (const t of terms) if (words.has(t)) overlap++;
        if (overlap > 0 && (!best || overlap > best.overlap)) {
          best = { sentence: s, overlap };
        }
      }
      if (best) picked.push({ sentence: best.sentence, hit, overlap: best.overlap });
      if (picked.length >= maxSentences) break;
    }
    // Order by evidence strength, then overlap.
    picked.sort((a, b) => b.hit.score - a.hit.score || b.overlap - a.overlap);

    if (picked.length === 0) {
      return {
        text:
          "I found related sections but nothing that directly answers that. " +
          "Try rephrasing, or upload a document that covers the topic.",
        citations: [],
        confidence: 0,
        escalated: true,
      };
    }

    const citations: Citation[] = picked.map((p) => ({
      docId: p.hit.chunk.docId,
      title:
        this.store
          .listDocuments()
          .find((d) => d.docId === p.hit.chunk.docId)?.title ??
        p.hit.chunk.docId,
      section: p.hit.chunk.section,
      chunkIndex: p.hit.chunk.index,
      excerpt: p.sentence,
    }));

    const confidence =
      evidence.slice(0, picked.length).reduce((s, h) => s + h.score, 0) /
      Math.max(1, picked.length);
    const text =
      picked.map((p) => p.sentence).join(" ") +
      "\n\nSources: " +
      citations
        .map(
          (c, i) =>
            `[${i + 1}] ${c.title}${c.section ? ` — ${c.section}` : ""} (chunk ${c.chunkIndex})`,
        )
        .join("; ");

    return { text, citations, confidence, escalated: false };
  }
}
