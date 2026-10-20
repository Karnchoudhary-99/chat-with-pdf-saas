/** Domain types for the Chat-with-PDF RAG pipeline. */

export interface DocumentMeta {
  /** Stable id, e.g. `doc_<8 hex chars>`. */
  docId: string;
  /** Human title: PDF metadata title or filename fallback. */
  title: string;
  /** Original filename or upload label. */
  source: string;
  /** Page count reported by the PDF parser. */
  pageCount: number;
  /** Raw character count of extracted text. */
  charCount: number;
}

export interface TextSection {
  /** Section heading (markdown-style), or null for body text. */
  heading: string | null;
  /** Section body text, normalized whitespace. */
  text: string;
  /** 1-based page number, or null when unknown. */
  page: number | null;
}

export interface Chunk {
  /** `${docId}#${index}`. */
  chunkId: string;
  docId: string;
  /** 0-based position inside the document. */
  index: number;
  text: string;
  /** Character offsets into the document's full text. */
  charStart: number;
  charEnd: number;
  /** Nearest section heading above the chunk, if any. */
  section: string | null;
  /** Rough token estimate (chars / 4). */
  tokenEstimate: number;
}
