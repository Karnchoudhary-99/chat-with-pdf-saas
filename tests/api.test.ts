import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import { sampleManualPdf } from "./fixtures.js";

describe("HTTP API", () => {
  let server: Server;
  let base: string;
  let docId: string;

  beforeAll(async () => {
    const app = createApp(); // in-memory store, no persistence
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("POST /v1/documents uploads a PDF", async () => {
    const res = await fetch(`${base}/v1/documents?title=ACME%20Manual`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: sampleManualPdf(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { meta: { docId: string }; chunks: number };
    expect(json.meta.docId).toMatch(/^doc_/);
    expect(json.chunks).toBeGreaterThan(0);
    docId = json.meta.docId;
  });

  it("POST /v1/documents rejects empty bodies", async () => {
    const res = await fetch(`${base}/v1/documents`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: "",
    });
    expect(res.status).toBe(400);
  });

  it("GET /v1/documents lists the library", async () => {
    const res = await fetch(`${base}/v1/documents`);
    const json = (await res.json()) as { documents: { docId: string }[] };
    expect(json.documents.map((d) => d.docId)).toContain(docId);
  });

  it("POST /v1/chat answers with citations", async () => {
    const res = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "How much do plans cost?" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      text: string;
      citations: unknown[];
      escalated: boolean;
    };
    expect(json.escalated).toBe(false);
    expect(json.text).toMatch(/\$9|per month/i);
    expect(json.citations.length).toBeGreaterThan(0);
  });

  it("POST /v1/chat requires a question", async () => {
    const res = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /v1/chat/stream streams SSE tokens and a done event", async () => {
    const res = await fetch(
      `${base}/v1/chat/stream?question=${encodeURIComponent("refund policy?")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"token"');
    expect(body).toContain('"done":true');
  });

  it("DELETE /v1/documents/:id removes the document", async () => {
    const del = await fetch(`${base}/v1/documents/${docId}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    const del2 = await fetch(`${base}/v1/documents/${docId}`, {
      method: "DELETE",
    });
    expect(del2.status).toBe(404);
  });
});
