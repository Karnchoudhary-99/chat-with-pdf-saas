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
query-term-overlap gate decides what gets cited. No evidence → it says so
instead of inventing an answer.

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
- [ ] Eval harness + Docker, then self-review and public flip

## License

MIT — see [LICENSE](LICENSE).
