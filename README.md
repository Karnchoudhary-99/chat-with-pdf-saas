# Chat with PDF SaaS

> Chat with your PDFs — upload documents, get cited, streamed answers. RAG-powered document Q&A in TypeScript.

Upload a PDF, ask questions in plain English, and get answers stitched from the
document's own sentences — every claim cited (`[1] Manual — REFUNDS (chunk 3)`),
streamed token-by-token over SSE. No API keys needed: the default pipeline
(hash embeddings + extractive composer) runs fully offline; plug in any
OpenAI-compatible embeddings endpoint when you want better ranking.

## Quick start

```bash
npm install
npm test

# CLI (no server needed)
npx tsx src/cli.ts upload ./manual.pdf --title "ACME Manual"
npx tsx src/cli.ts ask "What is the refund policy?"
npx tsx src/cli.ts list

# HTTP API
npx tsx src/cli.ts serve --port 8000
curl --data-binary @manual.pdf -H 'Content-Type: application/pdf' \
  'http://localhost:8000/v1/documents?title=ACME%20Manual'
curl -X POST http://localhost:8000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"question": "What is the refund policy?"}'
```

## How it works

```
PDF bytes → pdf.js text extraction (line-aware via glyph y-coords)
          → section split (markdown + ALL-CAPS headings)
          → token-budgeted overlapping chunks (sentence-boundary snap)
          → embeddings (HashEmbedder offline / OpenAI-compatible)
          → VectorStore (cosine search, JSON persistence)
          → AnswerComposer (extractive, cited, refuses to hallucinate)
```

**Honest retrieval.** The extractive composer never generates text — it quotes
the document's own sentences, so it can't hallucinate. Two-stage gating keeps
it honest: a permissive cosine floor retrieves candidates, then a strict
query-term-overlap gate decides what gets cited. Chunks are ranked by
sentence-level evidence (term overlap + section-heading match + term-density
tie-break), not by raw cosine score, so a keyword mention in the intro can't
outrank the actual answer under its section heading. No evidence → it says so
instead of inventing an answer.

## Evaluation

`npm run eval` runs a 12-case gold set over a fixture manual and reports four
metrics (also runs in CI, failing below 0.5 groundedness):

| metric | what it measures | baseline |
| ------ | ---------------- | -------- |
| groundedness | expected answer phrases present in answer text + citations | 1.0000 |
| citation_precision | citations whose excerpt supports the answer | 1.0000 |
| retrieval_recall | expected phrase in top-5 retrieved chunks | 1.0000 |
| escalation_accuracy | correct escalate / don't-escalate decision | 1.0000 |

The harness caught a real ranking bug during development: a question like
"How long do refunds take?" was answered from the intro's keyword mention
instead of the refunds section — fixed by ranking chunks on sentence evidence
rather than cosine score.

## API reference

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/healthz` | Liveness probe |
| `POST` | `/v1/documents` | Upload PDF (raw body, `Content-Type: application/pdf`, `?title=`) → `201 { meta, chunks }` |
| `GET` | `/v1/documents` | List library |
| `DELETE` | `/v1/documents/:id` | Remove a document |
| `POST` | `/v1/chat` | `{ question, docIds?, topK? }` → `{ text, citations, confidence, escalated }` |
| `GET` | `/v1/chat/stream` | Same as chat, SSE `data: {"token": …}` events + final `{"done": true, "answer": …}` |

Documents persist to `./data/store.json` (`CWP_DATA` overrides). Swap in better
embeddings any time:

```ts
import { OpenAIEmbedder } from "./src/embeddings.js";
// process.env.EMBEDDINGS_API_KEY + EMBEDDINGS_BASE_URL (Ollama/vLLM/OpenAI)
const lib = await DocumentLibrary.open({
  embedder: new OpenAIEmbedder({ dimension: 1536 }),
});
```

## Roadmap

- [x] Project scaffold (layout, README, CI)
- [x] PDF ingestion + chunking pipeline
- [x] Vector retrieval over per-doc embeddings
- [x] RAG answer composer with citations + streaming API
- [x] Multi-doc SaaS API: upload, library, per-doc sessions
- [x] Eval harness + Docker, then self-review and public flip
- [x] Eval harness (groundedness/citation/recall/escalation metrics, CI gate)

## License

MIT — see [LICENSE](LICENSE).
