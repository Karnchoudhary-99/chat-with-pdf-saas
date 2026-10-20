import { describe, expect, it } from "vitest";
import { DocumentLibrary } from "../src/library.js";
import { AnswerComposer } from "../src/answer.js";
import { HashEmbedder } from "../src/embeddings.js";
import { sampleManualPdf } from "./fixtures.js";

const buildLibrary = async () => {
  const lib = new DocumentLibrary({
    embedder: new HashEmbedder(128),
    chunker: { targetTokens: 60, overlapTokens: 10 },
  });
  const { meta } = await lib.upload(sampleManualPdf(), "manual.pdf");
  return { lib, meta };
};

describe("AnswerComposer", () => {
  it("answers in-corpus questions with citations", async () => {
    const { lib, meta } = await buildLibrary();
    const composer = new AnswerComposer(new HashEmbedder(128), lib.store);
    const answer = await composer.answer("What is the refund policy?");
    expect(answer.escalated).toBe(false);
    expect(answer.text).toMatch(/refund/i);
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations[0]!.docId).toBe(meta.docId);
    expect(answer.confidence).toBeGreaterThan(0);
    expect(answer.text).toContain("Sources:");
  });

  it("escalates on out-of-corpus questions instead of hallucinating", async () => {
    const { lib } = await buildLibrary();
    const composer = new AnswerComposer(new HashEmbedder(128), lib.store);
    const answer = await composer.answer(
      "What is the capital of Mongolia and its GDP?",
    );
    expect(answer.escalated).toBe(true);
    expect(answer.citations).toHaveLength(0);
  });

  it("scopes answers to requested docIds", async () => {
    const { lib, meta } = await buildLibrary();
    const composer = new AnswerComposer(new HashEmbedder(128), lib.store);
    const answer = await composer.answer("refund policy", [meta.docId]);
    expect(answer.escalated).toBe(false);
    expect(
      answer.citations.every((c) => c.docId === meta.docId),
    ).toBe(true);
  });

  it("rejects empty questions", async () => {
    const { lib } = await buildLibrary();
    const composer = new AnswerComposer(new HashEmbedder(128), lib.store);
    const answer = await composer.answer("   ");
    expect(answer.escalated).toBe(true);
  });
});
