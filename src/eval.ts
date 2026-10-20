#!/usr/bin/env node
/**
 * Eval harness: measures RAG answer quality on a fixed gold set so retrieval
 * regressions show up locally and in CI (`npm run eval`).
 *
 * Metrics:
 *  - groundedness (headline): mean over answerable cases of
 *      (keywordRecall + citedRecall) / 2 — how much of the expected answer
 *      appears in the answer text and in the citations backing it.
 *  - citationPrecision: fraction of citations whose excerpt contains at least
 *      one expected phrase (mean over answerable cases).
 *  - retrievalRecall: fraction of answerable cases where at least one of the
 *      top-K retrieved chunks contains an expected phrase.
 *  - escalationAccuracy: fraction of all cases where the escalate/don't
 *      decision matches the gold label.
 *
 * Exit code is non-zero when groundedness < 0.5, so CI fails on a broken
 * pipeline instead of silently shipping bad answers.
 */
import { DocumentLibrary } from "./library.js";
import { AnswerComposer } from "./answer.js";
import { HashEmbedder, type Embedder } from "./embeddings.js";
import { sampleManualPdf } from "../tests/fixtures.js";

export interface EvalCase {
  id: string;
  question: string;
  /** Lowercased phrases the correct answer must contain. */
  expectedPhrases: string[];
  /** Substring the cited documents' titles must contain (case-insensitive). */
  expectedDocTitle?: string;
  /** True when the corpus has no answer and the bot must escalate. */
  shouldEscalate?: boolean;
}

export interface CaseResult {
  id: string;
  question: string;
  escalated: boolean;
  confidence: number;
  citationCount: number;
  /** Fraction of expectedPhrases found in the answer text. */
  keywordRecall: number;
  /** Fraction of expectedPhrases found in the citation excerpts. */
  citedRecall: number;
  /** Fraction of citations whose excerpt contains >= 1 expected phrase. */
  citationPrecision: number;
  /** Any top-K chunk text contains an expected phrase. */
  retrievalHit: boolean;
  escalatedCorrectly: boolean;
  /** (keywordRecall + citedRecall) / 2 for answerable cases, NaN otherwise. */
  groundedness: number;
}

export interface EvalMetrics {
  groundedness: number;
  citationPrecision: number;
  retrievalRecall: number;
  escalationAccuracy: number;
  n: number;
  nAnswerable: number;
  nEscalation: number;
}

export interface EvalReport {
  cases: CaseResult[];
  metrics: EvalMetrics;
}

export const DEFAULT_GOLD_SET: EvalCase[] = [
  {
    id: "pricing-pro",
    question: "How much does the Pro tier cost per month?",
    expectedPhrases: ["$49", "pro"],
    expectedDocTitle: "manual",
  },
  {
    id: "pricing-starter",
    question: "How much does the Starter tier cost?",
    expectedPhrases: ["$9", "starter"],
    expectedDocTitle: "manual",
  },
  {
    id: "refund-window",
    question: "Within how many days of purchase are refunds issued?",
    expectedPhrases: ["30 days", "refund"],
    expectedDocTitle: "manual",
  },
  {
    id: "cli-install",
    question: "How do I install the command line tool?",
    expectedPhrases: ["npm install -g acme-cli"],
    expectedDocTitle: "manual",
  },
  {
    id: "api-base-url",
    question: "What is the base URL for the developer API?",
    expectedPhrases: ["https://api.acme.example/v1"],
    expectedDocTitle: "manual",
  },
  {
    id: "rate-limits",
    question: "What are the API rate limits?",
    expectedPhrases: ["100 requests per minute"],
    expectedDocTitle: "manual",
  },
  {
    id: "billing-contact",
    question: "Who do I contact about billing questions?",
    expectedPhrases: ["billing@acme.example"],
    expectedDocTitle: "manual",
  },
  {
    id: "status-page",
    question: "Where can I see live incidents?",
    expectedPhrases: ["status.acme.example"],
    expectedDocTitle: "manual",
  },
  {
    id: "invoice-day",
    question: "When are invoices emailed?",
    expectedPhrases: ["first day"],
    expectedDocTitle: "manual",
  },
  {
    id: "auth-errors",
    question: "The CLI reports authentication errors. What should I do?",
    expectedPhrases: ["rotate your api token"],
    expectedDocTitle: "manual",
  },
  {
    id: "escalate-ceo",
    question: "What is the CEO's favorite color?",
    expectedPhrases: [],
    shouldEscalate: true,
  },
  {
    id: "escalate-fridge",
    question: "How do I defrost a chest freezer?",
    expectedPhrases: [],
    shouldEscalate: true,
  },
];

/** Fraction of phrases (case-insensitive) found in text. */
export function phraseRecall(text: string, phrases: string[]): number {
  if (phrases.length === 0) return 1;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const p of phrases) if (lower.includes(p.toLowerCase())) hits++;
  return hits / phrases.length;
}

export interface RunEvalOptions {
  topK?: number;
}

export async function runEval(
  lib: DocumentLibrary,
  embedder: Embedder,
  cases: EvalCase[],
  opts: RunEvalOptions = {},
): Promise<EvalReport> {
  const topK = opts.topK ?? 5;
  const composer = new AnswerComposer(embedder, lib.store, { topK });
  const results: CaseResult[] = [];

  for (const c of cases) {
    const answer = await composer.answer(c.question);
    const escalatedCorrectly = answer.escalated === !!c.shouldEscalate;

    let keywordRecall = 0;
    let citedRecall = 0;
    let citationPrecision = 0;
    let retrievalHit = false;
    let groundedness = NaN;

    if (!c.shouldEscalate) {
      keywordRecall = phraseRecall(answer.text, c.expectedPhrases);
      const excerpts = answer.citations.map((ct) => ct.excerpt).join("\n");
      citedRecall = phraseRecall(excerpts, c.expectedPhrases);
      groundedness = (keywordRecall + citedRecall) / 2;

      if (answer.citations.length > 0) {
        let precise = 0;
        for (const ct of answer.citations) {
          const excerpt = ct.excerpt.toLowerCase();
          const titleOk = c.expectedDocTitle
            ? ct.title.toLowerCase().includes(c.expectedDocTitle.toLowerCase())
            : true;
          if (
            titleOk &&
            c.expectedPhrases.some((p) => excerpt.includes(p.toLowerCase()))
          ) {
            precise++;
          }
        }
        citationPrecision = precise / answer.citations.length;
      }

      const [qVec] = await embedder.embed([c.question]);
      const hits = lib.store.search(qVec!, topK);
      retrievalHit = hits.some((h) =>
        c.expectedPhrases.some((p) =>
          h.chunk.text.toLowerCase().includes(p.toLowerCase()),
        ),
      );
    }

    results.push({
      id: c.id,
      question: c.question,
      escalated: answer.escalated,
      confidence: answer.confidence,
      citationCount: answer.citations.length,
      keywordRecall,
      citedRecall,
      citationPrecision,
      retrievalHit,
      escalatedCorrectly,
      groundedness,
    });
  }

  const answerable = results.filter((r) => !Number.isNaN(r.groundedness));
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const metrics: EvalMetrics = {
    groundedness: mean(answerable.map((r) => r.groundedness)),
    citationPrecision: mean(answerable.map((r) => r.citationPrecision)),
    retrievalRecall: mean(answerable.map((r) => (r.retrievalHit ? 1 : 0))),
    escalationAccuracy: mean(results.map((r) => (r.escalatedCorrectly ? 1 : 0))),
    n: results.length,
    nAnswerable: answerable.length,
    nEscalation: results.length - answerable.length,
  };

  return { cases: results, metrics };
}

/** Builds a throwaway in-memory library over the fixture corpus. */
export async function buildEvalLibrary(): Promise<{
  lib: DocumentLibrary;
  embedder: Embedder;
}> {
  const embedder = new HashEmbedder(384);
  const lib = new DocumentLibrary({ embedder });
  await lib.upload(sampleManualPdf(), "ACME Cloud Manual");
  return { lib, embedder };
}

function printReport(report: EvalReport): void {
  console.log("case                   esc  conf  cites  kwRec  citRec  citPrec  retr");
  for (const r of report.cases) {
    const f = (x: number): string =>
      Number.isNaN(x) ? "  n/a" : x.toFixed(2).padStart(5);
    console.log(
      `${r.id.padEnd(22)} ${(r.escalated ? "Y" : "n").padEnd(4)} ` +
        `${r.confidence.toFixed(2).padStart(5)} ${String(r.citationCount).padStart(5)} ` +
        `${f(r.keywordRecall)} ${f(r.citedRecall)} ${f(r.citationPrecision)} ` +
        `  ${Number.isNaN(r.groundedness) ? "n/a" : r.retrievalHit ? "Y" : "N"}`,
    );
  }
  const m = report.metrics;
  console.log("\nmetrics:");
  console.log(`  groundedness        ${m.groundedness.toFixed(4)}`);
  console.log(`  citation_precision  ${m.citationPrecision.toFixed(4)}`);
  console.log(`  retrieval_recall    ${m.retrievalRecall.toFixed(4)}`);
  console.log(`  escalation_accuracy ${m.escalationAccuracy.toFixed(4)}`);
  console.log(
    `  cases: ${m.n} (${m.nAnswerable} answerable, ${m.nEscalation} escalation)`,
  );
}

/** CI gate predicate: groundedness must clear the threshold. */
export function evalPassed(report: EvalReport, threshold = 0.5): boolean {
  return report.metrics.groundedness >= threshold;
}

/** CLI entrypoint: `npm run eval`. Fails CI when groundedness < 0.5. */
export async function main(): Promise<void> {
  const { lib, embedder } = await buildEvalLibrary();
  const report = await runEval(lib, embedder, DEFAULT_GOLD_SET);
  printReport(report);
  const g = report.metrics.groundedness;
  if (!evalPassed(report)) {
    console.error(`\neval FAILED: groundedness ${g.toFixed(4)} < 0.5`);
    process.exit(1);
  }
  console.log(`\neval passed: groundedness ${g.toFixed(4)} >= 0.5`);
}

// Run the CLI when executed directly (not when imported by tests).
const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/eval.js") || process.argv[1].endsWith("/eval.ts"));
if (invokedAsScript) {
  main().catch((err) => {
    console.error("eval error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
