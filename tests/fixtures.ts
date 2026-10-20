/** Build minimal but VALID single/multi-page PDFs for ingestion tests.
 *  Each page is a list of text lines (rendered top to bottom). */
export function buildPdf(pages: string[][]): Buffer {
  // Escape text for PDF literal strings.
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  const n = pages.length;
  // obj ids: 1 catalog, 2 pages, then per page: page obj + content obj, then font
  let fontId = 3 + n * 2;

  const header = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const parts: string[] = [header];
  const offsets: number[] = [];

  const emit = (id: number, body: string) => {
    offsets[id] = Buffer.byteLength(parts.join(""), "latin1");
    parts.push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  const pageRefs: string[] = [];
  for (let p = 0; p < n; p++) pageRefs.push(`${3 + p * 2} 0 R`);
  emit(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  emit(2, `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${n} >>`);

  for (let p = 0; p < n; p++) {
    const pid = 3 + p * 2;
    const lines = pages[p]!;
    const ops = lines
      .map((ln, i) => (i === 0 ? "" : "0 -18 Td ") + `(${esc(ln)}) Tj`)
      .join(" ");
    const stream = `BT /F1 12 Tf 72 720 Td ${ops} ET`;
    emit(
      pid,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pid + 1} 0 R >>`,
    );
    const streamBytes = Buffer.byteLength(stream, "latin1");
    emit(pid + 1, `<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream`);
  }
  emit(fontId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const bodyLen = Buffer.byteLength(parts.join(""), "latin1");
  const maxId = fontId;
  let xref = "xref\n0 " + (maxId + 1) + "\n";
  xref += "0000000000 65535 f \n";
  for (let id = 1; id <= maxId; id++) {
    xref += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
  }
  const trailer =
    `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\n` +
    `startxref\n${bodyLen}\n%%EOF`;
  return Buffer.from(parts.join("") + xref + trailer, "latin1");
}

/** A six-page "product manual" style PDF used across ingestion tests.
 *  Each page covers a distinct topic so retrieval tests discriminate. */
export function sampleManualPdf(): Buffer {
  return buildPdf([
    [
      "ACME Cloud Docs",
      "INTRODUCTION",
      "Welcome to ACME Cloud. This manual covers setup, billing, refunds,",
      "the developer API, security practices, and troubleshooting.",
    ],
    [
      "GETTING STARTED",
      "Create an account at cloud.acme.example, then verify your email.",
      "Install the command line tool with npm install -g acme-cli.",
      "Run acme login and paste the API token from your dashboard.",
    ],
    [
      "BILLING",
      "Plans start at $9 per month for the Starter tier.",
      "The Pro tier costs $49 per month and includes priority support.",
      "Invoices are emailed on the first day of each billing cycle.",
    ],
    [
      "REFUNDS",
      "Refunds are issued within 30 days of purchase.",
      "To request a refund, open a ticket with your order number.",
      "Refunded amounts return to the original payment method.",
    ],
    [
      "DEVELOPER API",
      "All API requests need a bearer token in the Authorization header.",
      "The base URL is https://api.acme.example/v1.",
      "Rate limits are 100 requests per minute per token.",
    ],
    [
      "TROUBLESHOOTING",
      "If the CLI reports authentication errors, rotate your API token.",
      "For billing questions, contact billing@acme.example.",
      "Status page: https://status.acme.example shows live incidents.",
    ],
  ]);
}
