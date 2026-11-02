/**
 * The full processing pipeline, step by step (Capstone 1 sequence diagram):
 *   1. Ingest   - fingerprint the file, store it encrypted on this device
 *   2. Read     - extract text + positions (pdf.js / CSV / OCR)
 *   3. Mask     - Level-2 PII masking (only masked text can leave)
 *   4. Swarm    - on-device agents, plus cloud agents if allowed
 *   5. Reconcile- check the AI against the source, merge
 *   6. Compute  - deterministic tax engine
 */
import { fingerprint, extractPdf, extractCsv, extractImage } from '../engine/extract.js';
import { runLocalSwarm } from '../engine/localAgents.js';
import { reconcile } from '../engine/coordinator.js';
import { toEngineInput } from '../engine/facts.js';
import { calculateReturn } from '../engine/taxEngine.js';
import { saveFile } from '../engine/vault.js';
import { pdfjsLib } from './viewer.js';

export const STAGES = ['Ingesting', 'Reading layout', 'Privacy masking', 'Agent swarm', 'Review ready'];

export function kindOf(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.csv') || file.type === 'text/csv') return 'csv';
  if (/\.(png|jpe?g|webp)$/.test(name) || file.type.startsWith('image/')) return 'image';
  return null;
}

/** Loads Tesseract OCR only when an image is uploaded (it is a big download). */
let tesseractPromise;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tesseractPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('Could not load the OCR engine (check your internet connection).'));
    document.head.append(s);
  });
  return tesseractPromise;
}

/**
 * Steps 1-3 for one file.
 * @param {File} file
 * @param {object} masking   a masking session from createMaskingSession()
 * @param {Set<string>} knownIds  document IDs already uploaded (duplicate check)
 * @param {(stage:string, extra?:string)=>void} onStage  progress callback
 */
export async function ingestFile(file, masking, knownIds, onStage = () => {}) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`"${file.name}" is not a PDF, CSV or image.`);

  onStage('Ingesting');
  const data = await file.arrayBuffer();
  const docId = (await fingerprint(data)).slice(0, 12);
  if (knownIds.has(docId)) return { duplicate: true, docId, docName: file.name };
  await saveFile(docId, file);

  onStage('Reading layout');
  const meta = { docId, docName: file.name };
  let extracted;
  if (kind === 'pdf') extracted = await extractPdf(data, pdfjsLib, meta);
  else if (kind === 'csv') extracted = extractCsv(new TextDecoder().decode(data), meta);
  else extracted = await extractImage(file, await loadTesseract(), meta, (pct) => onStage('Reading layout', `OCR ${pct}%`));

  onStage('Privacy masking');
  const maskedName = masking.mask(file.name.replace(/[_]+/g, ' ')).text;
  let maskedCount = 0;
  const masked = extracted.items.map((item) => {
    const m = masking.mask(item.text);
    maskedCount += m.found.length;
    return {
      id: item.id, docId, docName: maskedName, text: m.text, confidence: item.confidence,
      ...(item.cells ? { cells: Object.fromEntries(Object.entries(item.cells).map(([k, v]) => [k, masking.mask(v).text])) } : {})
    };
  });

  const confidence = extracted.averageConfidence ?? 100;
  return {
    doc: { docId, docName: file.name, kind, lines: extracted.items.length, maskedCount, confidence, lowConfidence: confidence < 85 },
    items: extracted.items,   // real text + positions: stays on this device
    masked                    // masked text: the only version that may be sent
  };
}

/**
 * Steps 4-6 for all documents.
 * @returns {Promise<{analysis, result, payload, cloudError}>}
 */
export async function analyse({ docs, masked, rules, useCloud, onStage = () => {} }) {
  onStage('Agent swarm');
  const ocrWarnings = docs.filter((d) => d.lowConfidence).map((d) => ({
    docName: d.docName, confidence: d.confidence, refs: masked.filter((m) => m.docId === d.docId).slice(0, 1).map((m) => m.id)
  }));
  const local = runLocalSwarm(masked, rules, ocrWarnings);

  let cloud = null;
  let cloudError = null;
  let payload = null;
  if (useCloud) {
    payload = { items: masked.map(({ id, docId, docName, text, cells }) => ({ id, docId, docName, text, ...(cells ? { cells } : {}) })) };
    try {
      const res = await fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      cloud = body;
    } catch (error) {
      cloudError = error.message;
    }
  }

  const analysis = reconcile(local, cloud, masked);
  if (cloudError) {
    analysis.flags.push({ severity: 'info', code: 'CLOUD_FALLBACK', message: `Cloud AI was not available (${cloudError}). The on-device agents produced these results instead.` });
  }
  const result = calculateReturn(toEngineInput(analysis.facts), rules);
  onStage('Review ready');
  return { analysis, result, payload, cloudError };
}

export async function loadRules(financialYear) {
  const res = await fetch(`/rules/fy${financialYear}.json`);
  if (!res.ok) throw new Error(`No tax rules for ${financialYear}`);
  return res.json();
}

/** Fetches the bundled sample documents as File objects. */
export async function sampleFiles(names) {
  return Promise.all(names.map(async (name) => {
    const res = await fetch(`/samples/${name}`);
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || (name.endsWith('.csv') ? 'text/csv' : 'application/pdf') });
  }));
}

export const UC1_SAMPLES = [
  'income-statement-2025-26.pdf',
  'wfh-timesheet-2025-26.csv',
  'ergonomic-chair-invoice.pdf',
  'electricity-annual-statement.pdf',
  'internet-annual-statement.pdf',
  'mobile-annual-statement.pdf'
];
