#!/usr/bin/env node
/**
 * CLI: upload PDFs, ask questions, list the library — without the server.
 *
 *   npx tsx src/cli.ts upload ./manual.pdf --title "ACME Manual"
 *   npx tsx src/cli.ts ask "What is the refund policy?"
 *   npx tsx src/cli.ts ask "Pricing?" --doc doc_abc123
 *   npx tsx src/cli.ts list
 *   npx tsx src/cli.ts serve --port 8000
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DocumentLibrary } from "./library.js";
import { AnswerComposer } from "./answer.js";
import { HashEmbedder } from "./embeddings.js";
import { createApp } from "./server.js";

const DATA_PATH = process.env.CWP_DATA ?? "./data/store.json";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const lib = await DocumentLibrary.open({
    embedder: new HashEmbedder(384),
    persistPath: DATA_PATH,
  });

  if (cmd === "upload") {
    const file = rest[0];
    if (!file) throw new Error("upload: provide a PDF path");
    const titleFlag = rest.indexOf("--title");
    const title =
      titleFlag !== -1 && rest[titleFlag + 1]
        ? rest[titleFlag + 1]!
        : file.split("/").pop()!;
    const pdf = await readFile(file);
    const { meta, chunks } = await lib.upload(pdf, title);
    console.log(`uploaded ${meta.docId} (${meta.title}): ${chunks} chunks`);
  } else if (cmd === "ask") {
    const question = rest.filter((a) => !a.startsWith("--")).join(" ");
    if (!question) throw new Error("ask: provide a question");
    const docFlag = rest.indexOf("--doc");
    const docIds =
      docFlag !== -1 && rest[docFlag + 1] ? [rest[docFlag + 1]!] : undefined;
    const composer = new AnswerComposer(new HashEmbedder(384), lib.store);
    const answer = await composer.answer(question, docIds);
    console.log(answer.text);
    console.log(`\nconfidence: ${answer.confidence.toFixed(3)}`);
  } else if (cmd === "list") {
    for (const d of lib.list()) {
      console.log(`${d.docId}  ${d.title}  (${d.chunks} chunks)`);
    }
  } else if (cmd === "serve") {
    const portFlag = rest.indexOf("--port");
    const port =
      portFlag !== -1 && rest[portFlag + 1] ? Number(rest[portFlag + 1]) : 8000;
    const app = createApp(DATA_PATH);
    const server = createServer(app);
    server.listen(port, () => {
      console.log(`chat-with-pdf-saas listening on http://localhost:${port}`);
    });
  } else {
    console.error("usage: cli.ts <upload|ask|list|serve> [args]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
