/**
 * HTTP API for the Chat-with-PDF SaaS.
 *
 *  POST /v1/documents        upload a PDF (raw body, content-type: application/pdf)
 *  GET  /v1/documents        list the library
 *  DELETE /v1/documents/:id  remove a document
 *  POST /v1/chat             { question, docIds?, topK? } -> cited answer
 *  GET  /v1/chat/stream      SSE stream of the answer (same params as query string)
 *  GET  /healthz             liveness
 */
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { DocumentLibrary } from "./library.js";
import { AnswerComposer } from "./answer.js";
import { HashEmbedder } from "./embeddings.js";

export function createApp(persistPath?: string): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  let libPromise: Promise<DocumentLibrary> | null = null;
  const library = (): Promise<DocumentLibrary> => {
    libPromise ??= DocumentLibrary.open({
      embedder: new HashEmbedder(384),
      persistPath,
    });
    return libPromise;
  };
  const composerFor = async (topK?: number) => {
    const lib = await library();
    return new AnswerComposer(new HashEmbedder(384), lib.store, { topK });
  };

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "chat-with-pdf-saas" });
  });

  // Raw PDF upload: curl --data-binary @doc.pdf -H 'Content-Type: application/pdf'
  app.post(
    "/v1/documents",
    express.raw({ type: "application/pdf", limit: "50mb" }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Buffer | undefined;
        if (!body || body.length === 0) {
          res.status(400).json({ error: "empty PDF body" });
          return;
        }
        const source =
          typeof req.query.title === "string" && req.query.title.length > 0
            ? req.query.title
            : "upload.pdf";
        const lib = await library();
        const result = await lib.upload(body, source);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get("/v1/documents", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ documents: (await library()).list() });
    } catch (err) {
      next(err);
    }
  });

  app.delete(
    "/v1/documents/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const ok = (await library()).remove(req.params.id);
        if (!ok) {
          res.status(404).json({ error: "document not found" });
          return;
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  app.post("/v1/chat", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { question, docIds, topK } = req.body as {
        question?: string;
        docIds?: string[];
        topK?: number;
      };
      if (typeof question !== "string" || question.trim().length === 0) {
        res.status(400).json({ error: "question is required" });
        return;
      }
      const answer = await (await composerFor(topK)).answer(question, docIds);
      res.json(answer);
    } catch (err) {
      next(err);
    }
  });

  // SSE: streams the answer word-by-word, then a final `done` event.
  app.get(
    "/v1/chat/stream",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const question = req.query.question;
        if (typeof question !== "string" || question.trim().length === 0) {
          res.status(400).json({ error: "question query param is required" });
          return;
        }
        const docIds =
          typeof req.query.docIds === "string"
            ? req.query.docIds.split(",")
            : undefined;
        const answer = await (await composerFor()).answer(question, docIds);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const word of answer.text.split(/(?<=\s)/)) {
          res.write(`data: ${JSON.stringify({ token: word })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true, answer })}\n\n`);
        res.end();
      } catch (err) {
        next(err);
      }
    },
  );

  // JSON error envelope; keep 4xx messages, hide 500 internals.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "internal error";
    const status =
      /no extractable text|empty|not found|required/i.test(message) ? 400 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? "internal error" : message });
  });

  return app;
}
