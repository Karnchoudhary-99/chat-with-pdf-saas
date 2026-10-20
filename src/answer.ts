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
    // Best sentence per chunk, but chunks are ranked by sentence-level
    // evidence (query-term overlap + section-heading bonus), NOT by chunk
    // cosine score: the hash embedder is a weak ranker, so a keyword mention
    // in the intro must not outrank the actual answer under "REFUNDS".
    interface Picked {
      sentence: string;
      hit: ScoredChunk;
      score: number;
    }
    const perChunk: Picked[] = [];
    for (const hit of evidence) {
      const section = (hit.chunk.section ?? "").toLowerCase();
      const sectionBonus = [...terms].some(
        (t) => section.length > 0 && section.includes(t),
      )
        ? 1
        : 0;
      let best: Picked | null = null;
      let bestDensity = 0;
      for (const s of sentences(hit.chunk.text)) {
        const words = new Set(s.toLowerCase().split(/[^a-z0-9]+/));
        let overlap = 0;
        for (const t of terms) if (words.has(t)) overlap++;
        const score = overlap + sectionBonus;
        // Tie-break: query-term density. When two sentences match the same
        // terms, the shorter, more focused one usually holds the answer
        // (e.g. "Refunds are issued within 30 days." beats a long intro
        // sentence that merely mentions refunds among other topics).
        const density = overlap / Math.max(1, words.size);
        if (
          overlap > 0 &&
          (!best || score > best.score || (score === best.score && density > bestDensity))
        ) {
          best = { sentence: s, hit, score };
          bestDensity = density;
        }
      }
      if (best) perChunk.push(best);
    }
    // Rank chunks by sentence evidence first, chunk score second. Dedupe
    // identical sentences that can appear in overlapping chunks.
    perChunk.sort((a, b) => b.score - a.score || b.hit.score - a.hit.score);
    const seen = new Set<string>();
    const picked: Picked[] = [];
    for (const c of perChunk) {
      const key = c.sentence.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(c);
      if (picked.length >= maxSentences) break;
    }

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
      picked.reduce((s, p) => s + p.hit.score, 0) / Math.max(1, picked.length);
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
