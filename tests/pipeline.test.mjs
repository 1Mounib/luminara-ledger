/**
 * End-to-end test of Engine A + local agents + tax engine using the sample
 * documents in public/samples/ (Capstone 1 Use Case 1).
 *  read files -> mask PII -> agents find facts -> engine calculates
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extractPdf, extractCsv, fingerprint } from '../public/js/engine/extract.js';
import { createMaskingSession, detectUnmaskedPII } from '../public/js/engine/redact.js';
import { runLocalSwarm } from '../public/js/engine/localAgents.js';
import { toEngineInput } from '../public/js/engine/facts.js';
import { calculateReturn } from '../public/js/engine/taxEngine.js';

let pdfjsLib = null;
try { pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch { /* not installed */ }

const SAMPLES = new URL('../public/samples/', import.meta.url);
const rules = JSON.parse(readFileSync(new URL('../public/rules/fy2025-26.json', import.meta.url)));

async function readAllSamples() {
  const items = [];
  for (const name of readdirSync(SAMPLES).filter((f) => /\.(pdf|csv)$/.test(f))) {
    const buf = readFileSync(new URL(name, SAMPLES));
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const docId = (await fingerprint(data)).slice(0, 12);
    const doc = { docId, docName: name };
    const out = name.endsWith('.pdf') ? await extractPdf(data, pdfjsLib, doc) : extractCsv(buf.toString('utf8'), doc);
    items.push(...out.items);
  }
  return items;
}

test('sample documents produce the Use Case 1 result', { skip: !pdfjsLib && 'pdfjs-dist not installed (npm install)' }, async () => {
  const raw = await readAllSamples();
  assert.ok(raw.length > 50, 'expected lines from 6 documents');

  // Engine A: mask everything that would leave the device
  const session = createMaskingSession({ knownNames: ['Alex Nguyen'] });
  const masked = raw.map((i) => ({ ...i, text: session.mask(i.text).text, cells: i.cells && Object.fromEntries(Object.entries(i.cells).map(([k, v]) => [k, session.mask(v).text])) }));
  const outbound = JSON.stringify(masked.map((i) => i.text));
  assert.deepEqual(detectUnmaskedPII(outbound), [], 'no TFN/ABN/card/email may leave the device');
  for (const secret of ['Alex', 'Nguyen', '123 456 782', 'Banksia', '0412 345 678']) assert.ok(!outbound.includes(secret), `${secret} leaked`);

  // Agents (local rules version)
  const swarm = runLocalSwarm(masked, rules);
  assert.equal(swarm.facts.salary.value, 98500);
  assert.equal(swarm.facts.taxWithheld.value, 22450);
  assert.equal(swarm.facts.wfhHours.value, 1120);
  assert.equal(swarm.facts.assets.length, 1);
  assert.equal(swarm.facts.assets[0].cost, 450);
  assert.equal(swarm.facts.assets[0].purchaseDate, '2025-12-29');
  assert.equal(swarm.facts.assets[0].assetType, 'office_chair');
  assert.equal(swarm.facts.coveredExpenses.length, 3);
  assert.equal(swarm.reports.length, 6, 'the triage agent and five specialists report back');
  assert.ok(swarm.reports.every((r) => r.steps.length), 'every agent records its steps');

  // Triage: each document is recognised and routed to the right specialist
  const kinds = Object.fromEntries(swarm.documents.map((d) => [d.docName, d.kind]));
  assert.equal(kinds['income-statement-2025-26.pdf'], 'income_statement');
  assert.equal(kinds['wfh-timesheet-2025-26.csv'], 'wfh_timesheet');
  assert.deepEqual(swarm.documents.find((d) => d.kind === 'income_statement').routedTo, ['employment']);

  // Deduction decisions: hours claimed at the fixed rate, chair over $300 depreciated, bills covered
  const byId = Object.fromEntries(swarm.decisions.map((d) => [d.id, d]));
  assert.equal(byId.wfh.decision, 'claim');
  assert.equal(swarm.decisions.filter((d) => d.decision === 'covered').length, 3);
  assert.equal(swarm.decisions.find((d) => d.id.startsWith('asset:')).method, 'decline_in_value');
  assert.equal(swarm.questions.length, 0, 'office furniture needs no question');

  // Every fact points back to a real source line (source lineage)
  const ids = new Set(raw.map((i) => i.id));
  for (const ref of [...swarm.facts.salary.refs, ...swarm.facts.assets[0].refs]) assert.ok(ids.has(ref), `unknown ref ${ref}`);
  const salaryLine = raw.find((i) => i.id === swarm.facts.salary.refs[0]);
  assert.ok(salaryLine.bbox.every((n) => n >= 0 && n <= 1000), 'bounding box on the 0-1000 scale');

  // Deterministic engine
  const result = calculateReturn(toEngineInput(swarm.facts), rules);
  assert.equal(result.totals.totalDeductions, 806.68);
  assert.equal(result.totals.refund, 400.24);
});
