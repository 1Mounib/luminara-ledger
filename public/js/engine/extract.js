/**
 * LUMINARA LEDGER - DOCUMENT READING (Engine A, runs in the browser)
 * ------------------------------------------------------------------
 * Turns an uploaded file into "items" (one per line of text), each with
 * WHERE it is on the page (a bounding box). That location is what lets the
 * UI highlight the source of every number (Capstone 1: FR-008, NFR-010).
 *
 *   PDF   -> pdf.js reads the text layer and positions      (FR-003)
 *   CSV   -> each row becomes an item, with its cells        (FR-003)
 *   Image -> Tesseract OCR reads the words + confidence %    (FR-009)
 *
 * The file itself never leaves the user's computer.
 *
 * Bounding boxes use the same 0-1000 scale as LayoutLMv3: [x0, y0, x1, y1]
 * measured from the top-left corner of the page.
 */

/** SHA-256 fingerprint of the file (FR-004) - used as the document ID and to spot duplicates. */
export async function fingerprint(arrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads a PDF's text with positions.
 * @param {ArrayBuffer} data the file
 * @param {object} pdfjsLib  the pdf.js library (passed in so tests can use the Node version)
 * @param {object} doc { docId, docName }
 */
export async function extractPdf(data, pdfjsLib, doc) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false }).promise;
  const items = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    // Group text pieces that sit on the same line (same y position, within 3 points)
    const rows = [];
    for (const piece of content.items) {
      if (!piece.str || !piece.str.trim()) continue;
      const [, , , , x, y] = piece.transform;
      const height = piece.height || Math.abs(piece.transform[3]) || 10;
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) { row = { y, pieces: [] }; rows.push(row); }
      row.pieces.push({ x, width: piece.width, height, str: piece.str });
    }
    rows.sort((a, b) => b.y - a.y); // top of page first

    rows.forEach((row, lineNo) => {
      row.pieces.sort((a, b) => a.x - b.x);
      const x0 = row.pieces[0].x;
      const x1 = Math.max(...row.pieces.map((p) => p.x + p.width));
      const h = Math.max(...row.pieces.map((p) => p.height));
      const text = row.pieces.map((p) => p.str.trim()).join('  ');
      items.push({
        id: `${doc.docId}:p${pageNo}:l${lineNo + 1}`,
        docId: doc.docId, docName: doc.docName, page: pageNo,
        text,
        bbox: normalise([x0, viewport.height - row.y - h, x1, viewport.height - row.y + 2], viewport.width, viewport.height),
        confidence: 100 // digital PDF text is exact
      });
    });
  }
  return { items, pages: pdf.numPages };
}

/** Reads a CSV file. Each row becomes an item that keeps its cells by column name. */
export function extractCsv(text, doc) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return { items: [], pages: 1 };
  const headers = rows[0].map((h) => h.trim());
  const items = rows.slice(1).map((row, i) => {
    const cells = Object.fromEntries(headers.map((h, j) => [h, (row[j] ?? '').trim()]));
    return {
      id: `${doc.docId}:r${i + 2}`,
      docId: doc.docId, docName: doc.docName, page: 1, row: i + 2,
      text: headers.map((h) => `${h}: ${cells[h]}`).join(' | '),
      cells,
      confidence: 100
    };
  });
  return { items, pages: 1, headers };
}

/** A small CSV parser that understands quoted values like "Smith, J". */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Reads an image (photo or scan of a receipt) with Tesseract OCR.
 * Tesseract runs inside the browser; only the OCR program is downloaded,
 * the image is never uploaded.
 * @param {Blob} file
 * @param {object} Tesseract the Tesseract.js library
 */
export async function extractImage(file, Tesseract, doc, onProgress) {
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => onProgress && m.status === 'recognizing text' && onProgress(Math.round(m.progress * 100))
  });
  const { data } = await worker.recognize(file);
  await worker.terminate();
  const bitmap = await createImageBitmap(file);
  const items = (data.lines || [])
    .filter((l) => l.text.trim())
    .map((line, i) => ({
      id: `${doc.docId}:p1:l${i + 1}`,
      docId: doc.docId, docName: doc.docName, page: 1,
      text: line.text.trim(),
      bbox: normalise([line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1], bitmap.width, bitmap.height),
      confidence: Math.round(line.confidence)
    }));
  const avg = items.length ? Math.round(items.reduce((s, i) => s + i.confidence, 0) / items.length) : 0;
  return { items, pages: 1, averageConfidence: avg };
}

function normalise([x0, y0, x1, y1], width, height) {
  const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
  return [clamp((x0 / width) * 1000), clamp((y0 / height) * 1000), clamp((x1 / width) * 1000), clamp((y1 / height) * 1000)];
}
