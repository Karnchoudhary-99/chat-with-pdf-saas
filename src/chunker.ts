/**
 * Chunker: split document text into overlapping, token-budgeted chunks
 * with character offsets and section attribution.
 */
import type { Chunk, TextSection } from "./types.js";

export interface ChunkerOptions {
  /** Target chunk size in estimated tokens (chars/4). Default 400. */
  targetTokens?: number;
  /** Overlap between consecutive chunks in tokens. Default 60. */
  overlapTokens?: number;
  /** Never emit a chunk longer than this many tokens. Default 800. */
  maxTokens?: number;
}

const CHARS_PER_TOKEN = 4;

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Greedily pack words into chunks of ~targetTokens with overlapTokens of
 * overlap between neighbours. Long sentences are hard-split at maxTokens.
 */
export function chunkText(
  docId: string,
  fullText: string,
  sections: TextSection[],
  opts: ChunkerOptions = {},
): Chunk[] {
  const targetTokens = opts.targetTokens ?? 400;
  const overlapTokens = Math.min(opts.overlapTokens ?? 60, targetTokens - 1);
  const maxTokens = opts.maxTokens ?? 800;

  const chunks: Chunk[] = [];
  // Map char offset -> nearest section heading at or above it. The heading
  // itself (including a markdown `# ` marker) starts the section's region.
  const sectionBounds: { start: number; heading: string | null }[] = [];
  {
    let cursor = 0;
    for (const s of sections) {
      let start = -1;
      if (s.heading) {
        const hIdx = fullText.indexOf(s.heading, cursor);
        if (hIdx !== -1) {
          start = hIdx;
          // Walk back over a markdown `# ` marker on the same line.
          const m = /(^|\n)(#{1,6} )$/.exec(fullText.slice(0, hIdx));
          if (m) start = hIdx - m[2].length;
        }
      }
      if (start === -1) {
        const tIdx = fullText.indexOf(s.text, cursor);
        start = tIdx === -1 ? cursor : tIdx;
      }
      sectionBounds.push({ start, heading: s.heading });
      cursor = start + (s.heading?.length ?? 0) + s.text.length;
    }
  }
  const sectionAt = (offset: number): string | null => {
    let h: string | null = null;
    for (const b of sectionBounds) {
      if (b.start <= offset) h = b.heading;
      else break;
    }
    return h;
  };

  const allWords = words(fullText);
  const wordStart: number[] = [];
  {
    let pos = 0;
    for (const w of allWords) {
      const i = fullText.indexOf(w, pos);
      wordStart.push(i);
      pos = i + w.length;
    }
  }

  const tokenEstimate = (textLen: number) =>
    Math.max(1, Math.round(textLen / CHARS_PER_TOKEN));

  let i = 0;
  let index = 0;
  while (i < allWords.length) {
    // Grow the chunk until we hit the target or run out of words.
    let j = i;
    let chars = 0;
    while (j < allWords.length) {
      const wlen = allWords[j].length + 1;
      const tok = (chars + wlen) / CHARS_PER_TOKEN;
      if (tok > targetTokens && j > i) break;
      if (tok > maxTokens) break;
      chars += wlen;
      j++;
    }
    if (j === i) j = i + 1; // pathological single huge word: keep it

    const charStart = wordStart[i];
    const lastWord = allWords[j - 1];
    const charEnd = wordStart[j - 1] + lastWord.length;
    const text = fullText.slice(charStart, charEnd);

    chunks.push({
      chunkId: `${docId}#${index}`,
      docId,
      index,
      text,
      charStart,
      charEnd,
      section: sectionAt(charStart),
      tokenEstimate: tokenEstimate(text.length),
    });
    index++;

    if (j >= allWords.length) break;
    // Step back by `overlapTokens` worth of words for the next chunk.
    const overlapWords = Math.max(
      1,
      Math.round((overlapTokens / targetTokens) * (j - i)),
    );
    i = Math.max(i + 1, j - overlapWords);
  }
  return chunks;
}
