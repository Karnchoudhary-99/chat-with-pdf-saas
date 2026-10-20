import { describe, expect, it } from "vitest";
import {
  buildEvalLibrary,
  evalPassed,
  phraseRecall,
  runEval,
  type EvalCase,
  type EvalReport,
} from "../src/eval.js";

describe("phraseRecall", () => {
  it("is 1 when every phrase is present (case-insensitive)", () => {
    expect(phraseRecall("Refunds are issued within 30 days.", ["30 days", "REFUNDS"])).toBe(1);
  });

  it("counts partial matches", () => {
    expect(phraseRecall("The Pro tier costs $49.", ["$49", "starter"])).toBe(0.5);
  });

  it("is 0 when nothing matches", () => {
    expect(phraseRecall("hello world", ["goodbye"])).toBe(0);
  });

  it("is 1 for an empty phrase list", () => {
    expect(phraseRecall("anything", [])).toBe(1);
  });
});

describe("runEval", () => {
  const miniGold: EvalCase[] = [
    {
      id: "refund",
      question: "How long do refunds take?",
      expectedPhrases: ["30 days"],
      expectedDocTitle: "manual",
    },
    {
      id: "escalate",
      question: "What is the capital of Mars?",
      expectedPhrases: [],
      shouldEscalate: true,
    },
  ];

  it("scores a tiny gold set against the fixture library", async () => {
    const { lib, embedder } = await buildEvalLibrary();
    const report = await runEval(lib, embedder, miniGold);

    expect(report.cases).toHaveLength(2);
    const refund = report.cases[0]!;
    expect(refund.retrievalHit).toBe(true);
    expect(refund.escalatedCorrectly).toBe(true);
    expect(refund.groundedness).toBeGreaterThan(0.5);

    const esc = report.cases[1]!;
    expect(esc.escalated).toBe(true);
    expect(esc.escalatedCorrectly).toBe(true);
    expect(Number.isNaN(esc.groundedness)).toBe(true);

    expect(report.metrics.n).toBe(2);
    expect(report.metrics.nAnswerable).toBe(1);
    expect(report.metrics.nEscalation).toBe(1);
    expect(report.metrics.escalationAccuracy).toBe(1);
  });

  it("keeps every metric in [0, 1]", async () => {
    const { lib, embedder } = await buildEvalLibrary();
    const report = await runEval(lib, embedder, miniGold);
    const ratios = [
      report.metrics.groundedness,
      report.metrics.citationPrecision,
      report.metrics.retrievalRecall,
      report.metrics.escalationAccuracy,
    ];
    for (const v of ratios) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    for (const c of report.cases) {
      for (const v of [
        c.keywordRecall,
        c.citedRecall,
        c.citationPrecision,
      ]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("headline groundedness is the mean of answerable case groundedness", async () => {
    const { lib, embedder } = await buildEvalLibrary();
    const report = await runEval(lib, embedder, miniGold);
    const answerable = report.cases.filter((c) => !Number.isNaN(c.groundedness));
    const expected =
      answerable.reduce((s, c) => s + c.groundedness, 0) / answerable.length;
    expect(report.metrics.groundedness).toBeCloseTo(expected, 10);
  });
});

describe("evalPassed", () => {
  const report = (g: number): EvalReport => ({
    cases: [],
    metrics: {
      groundedness: g,
      citationPrecision: 1,
      retrievalRecall: 1,
      escalationAccuracy: 1,
      n: 0,
      nAnswerable: 0,
      nEscalation: 0,
    },
  });

  it("passes at and above the 0.5 threshold", () => {
    expect(evalPassed(report(0.5))).toBe(true);
    expect(evalPassed(report(0.99))).toBe(true);
    expect(evalPassed(report(0.49))).toBe(false);
  });

  it("honors a custom threshold", () => {
    expect(evalPassed(report(0.7), 0.8)).toBe(false);
    expect(evalPassed(report(0.9), 0.8)).toBe(true);
  });
});
