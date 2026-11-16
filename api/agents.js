/**
 * POST /api/agents  - ENGINE B: the cloud AI agent swarm
 * -------------------------------------------------------
 * Receives ONLY masked document lines (names, TFNs etc. already replaced by
 * tokens in the browser). Two stages:
 *   1. {stage:'triage'}: the Document Triage Agent says what each document is.
 *   2. The five specialist agents run in parallel, each on the documents the
 *      triage routed to it, and return what they found, the line IDs used as
 *      evidence, their decisions and the steps they took.
 *
 * Important design rule (Capstone 1, FR-016): the AI classifies and points to
 * evidence; it never does the maths. Even WFH hours are added up by code here,
 * after the AI says which column holds the hours.
 */
import { chat, parseJsonReply, aiSettings, sendJson } from '../lib/llm.js';
import { detectUnmaskedPII } from '../public/js/engine/redact.js';

const MAX_ITEMS = 1500;

/** Every agent also reports what it did, so the app can show its working. */
const STEPS_RULE = `Also include "steps": up to 4 short plain-English sentences saying what you did, in order, citing line ids in square brackets where useful.`;

/** The triage agent sees only the first lines of each document: enough to tell what it is. */
const TRIAGE_LINES = 20;
const KINDS = ['income_statement', 'wfh_timesheet', 'asset_receipt', 'bill_electricity', 'bill_internet', 'bill_phone', 'dividend_statement', 'rental_statement', 'private_health', 'other'];
const ROUTES = {
  income_statement: ['employment'], wfh_timesheet: ['deduction'], asset_receipt: ['deduction'],
  bill_electricity: ['deduction'], bill_internet: ['deduction'], bill_phone: ['deduction'],
  dividend_statement: ['investment'], rental_statement: ['rental'], private_health: [], other: []
};

const TRIAGE = {
  name: 'Document Triage Agent',
  prompt: `You are the Document Triage Agent of an Australian tax assistant. You see the first lines of each document a taxpayer uploaded (personal details are already replaced by placeholders such as <PII_PERSON_1>).
Decide what each document is. Use exactly one kind from: ${KINDS.join(', ')}.
Reply with JSON only:
{"documents": [{"docId": "...", "kind": "...", "confidence": 0.0-1.0, "reason": "a few words, e.g. 'shows gross payments and PAYG withheld'", "refs": ["line id"]}],
 "summary": "one plain-English sentence",
 "steps": ["one short sentence per document"]}`
};

const AGENTS = {
  employment: {
    name: 'Employment Income Agent',
    prompt: `You are the Employment Income Agent of an Australian tax assistant (FR-010).
Find the taxpayer's gross salary/wages and the PAYG tax withheld, from an income statement or payment summary.
Reply with JSON only:
{"salary": {"value": number, "refs": ["line id"]} | null,
 "taxWithheld": {"value": number, "refs": ["line id"]} | null,
 "summary": "one plain-English sentence"}
Copy numbers exactly as written in the cited line. Do not calculate anything.`
  },
  deduction: {
    name: 'Deduction Extraction Agent',
    prompt: `You are the Deduction Extraction Agent of an Australian tax assistant (FR-013), for work-from-home claims using the ATO fixed rate method.
Tasks:
1. Find the timesheet of hours worked from home. Do NOT add up hours yourself. Report which document it is, which column holds hours, which column holds the location and what value means "home".
2. Find work assets bought (chair, desk, laptop, monitor...). For each give description, assetType (one of office_chair, desk, laptop, monitor, mobile_phone, printer, other), cost, purchaseDate (YYYY-MM-DD), workUsePercent (assume 100 unless stated).
3. Find running-cost bills (electricity, gas, internet, phone, stationery). These are covered by the fixed rate; just list them.
4. DECIDE for each hours record, asset and bill: "claim" (and the method: fixed_rate, immediate if $300 or less, decline_in_value if over $300), "covered" (already in the fixed rate), "not_claimable" (personal, not work related) or "ask" (you need the taxpayer's answer first, e.g. an item often used personally such as a laptop or phone). Give the reason in one plain sentence and the ATO rule.
5. For every "ask", write one short yes/no question to the taxpayer.
Reply with JSON only:
{"timesheet": {"docId": "...", "hoursColumn": "...", "locationColumn": "..." | null, "homeValue": "..." | null, "refs": ["line id"]} | null,
 "assets": [{"description": "...", "assetType": "...", "cost": number, "purchaseDate": "YYYY-MM-DD", "workUsePercent": 100, "refs": ["line id"]}],
 "coveredExpenses": [{"description": "...", "type": "electricity|gas|internet|phone|stationery", "amount": number, "refs": ["line id"]}],
 "decisions": [{"item": "...", "amount": number | null, "decision": "claim|covered|not_claimable|ask", "method": "fixed_rate|immediate|decline_in_value" | null, "reason": "...", "rule": "...", "refs": ["line id"]}],
 "questions": [{"item": "...", "amount": number, "text": "the question to the taxpayer", "refs": ["line id"]}],
 "summary": "one plain-English sentence"}
Never calculate a deduction amount yourself: the rules engine does the maths.`
  },
  investment: {
    name: 'Investment Income Agent',
    prompt: `You are the Investment Income Agent of an Australian tax assistant (FR-011).
Look only for dividend statements, interest or share trades. In this release investment income is out of scope, so just report what you see.
Reply with JSON only: {"documentsFound": number, "summary": "one plain-English sentence"}`
  },
  rental: {
    name: 'Rental Property Agent',
    prompt: `You are the Rental Property Agent of an Australian tax assistant (FR-012).
Look only for rental property statements. In this release rental property is out of scope, so just report what you see.
Reply with JSON only: {"documentsFound": number, "summary": "one plain-English sentence"}`
  },
  compliance: {
    name: 'Tax Compliance Agent',
    prompt: `You are the Tax Compliance Agent of an Australian tax assistant (FR-014), reviewing a work-from-home claim under the ATO fixed rate method (70c per hour for 2024-25 and 2025-26).
List risks an ATO reviewer would raise: missing records of actual hours, double-claiming bills already covered by the fixed rate, assets over $300 that must be depreciated, unusually high claims, missing documents.
Reply with JSON only:
{"flags": [{"severity": "high|medium|info", "message": "plain English, one or two sentences", "refs": ["line id"]}],
 "summary": "one plain-English sentence"}
Give at most 5 flags. Do not invent documents that are not listed.`
  }
};

export default async function handler(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, { configured: aiSettings().configured, agents: Object.values(AGENTS).map((a) => a.name) });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });

  const settings = aiSettings();
  if (!settings.configured) {
    return sendJson(res, 503, { error: 'Cloud AI is not set up (no GROQ_API_KEY). The app will use its on-device agents instead.' });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_ITEMS) : [];
  if (!items.length) return sendJson(res, 400, { error: 'No document lines received.' });

  // Last line of defence: refuse anything that still contains personal data (NFR-002)
  const leaked = detectUnmaskedPII(JSON.stringify(items));
  if (leaked.length) {
    return sendJson(res, 422, { error: `Blocked at the privacy boundary: unmasked ${leaked.join(', ')} found. Nothing was sent to the AI.`, blocked: leaked });
  }

  // Stage 1: the triage agent decides what each document is
  if (req.body?.stage === 'triage') {
    const firstLines = [];
    const seen = new Map();
    for (const it of items) {
      const n = seen.get(it.docId) || 0;
      if (n < TRIAGE_LINES) { firstLines.push(it); seen.set(it.docId, n + 1); }
    }
    try {
      const r = await chat([{ role: 'system', content: TRIAGE.prompt }, { role: 'user', content: `Documents (each line starts with its line id in square brackets):\n\n${formatForPrompt(firstLines)}` }], { json: true });
      const parsed = parseJsonReply(r.text) || {};
      const known = new Set(items.map((i) => i.docId));
      const documents = (parsed.documents || []).filter((d) => known.has(d.docId)).map((d) => {
        const kind = KINDS.includes(d.kind) ? d.kind : 'other';
        return { docId: d.docId, kind, confidence: Number(d.confidence) || null, reason: String(d.reason || '').slice(0, 160), routedTo: ROUTES[kind], refs: (d.refs || []).slice(0, 2) };
      });
      return sendJson(res, 200, { documents, report: { key: 'triage', agent: TRIAGE.name, engine: `Cloud AI (${r.model})`, ms: r.ms, summary: parsed.summary || `Sorted ${documents.length} document(s).`, steps: (parsed.steps || []).slice(0, 12).map(String), ok: true } });
    } catch (error) {
      return sendJson(res, 502, { error: `Triage failed: ${error.message}` });
    }
  }

  // Stage 2: each specialist reads only the documents routed to it (Compliance reads everything)
  const routes = req.body?.routes && typeof req.body.routes === 'object' ? req.body.routes : null;
  const docsFor = (key) => (key === 'compliance' || !routes ? items : items.filter((it) => (routes[it.docId] || []).includes(key)));

  const names = Object.keys(AGENTS);
  const results = await Promise.allSettled(
    names.map((key) => {
      const mine = docsFor(key);
      if (!mine.length) return Promise.resolve({ notRouted: true });
      return chat(
        [
          { role: 'system', content: `${AGENTS[key].prompt}\n${STEPS_RULE}` },
          { role: 'user', content: `Documents routed to you (each line starts with its line id in square brackets):\n\n${formatForPrompt(mine)}` }
        ],
        { json: true }
      );
    })
  );

  const agents = {};
  const reports = [];
  names.forEach((key, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.notRouted) {
      reports.push({ key, agent: AGENTS[key].name, engine: 'Cloud AI', ms: 0, summary: 'No documents were routed to me, so I did not run.', steps: ['The triage agent sent me no documents.'], ok: true, skipped: true });
    } else if (r.status === 'fulfilled') {
      const parsed = parseJsonReply(r.value.text);
      agents[key] = parsed;
      reports.push({ key, agent: AGENTS[key].name, engine: `Cloud AI (${r.value.model})`, ms: r.value.ms, summary: parsed?.summary || 'No readable answer.', steps: (parsed?.steps || []).slice(0, 6).map(String), ok: Boolean(parsed) });
    } else {
      reports.push({ key, agent: AGENTS[key].name, engine: 'Cloud AI', ms: 0, summary: `Failed: ${r.reason.message}`, steps: [], ok: false });
    }
  });

  // Code (not AI) adds up the timesheet hours the Deduction agent pointed to
  const ts = agents.deduction?.timesheet;
  if (ts?.hoursColumn) {
    const rows = items.filter((it) => it.docId === ts.docId && it.cells);
    let hours = 0;
    const refs = [];
    for (const row of rows) {
      const firstCell = Object.values(row.cells)[0] || '';
      if (/total/i.test(firstCell)) continue;
      const loc = ts.locationColumn ? String(row.cells[ts.locationColumn] ?? '') : '';
      if (ts.homeValue && ts.locationColumn && loc.toLowerCase() !== String(ts.homeValue).toLowerCase()) continue;
      const h = Number(String(row.cells[ts.hoursColumn] ?? '').replace(/[^\d.]/g, ''));
      if (h > 0) { hours += h; refs.push(row.id); }
    }
    if (hours > 0) agents.deduction.wfhHours = { value: Math.round(hours * 100) / 100, refs, computedBy: 'code' };
  }

  return sendJson(res, 200, { agents, reports });
}

/** Writes the lines as "[id] text", grouped by document, keeping the prompt small. */
function formatForPrompt(items) {
  const byDoc = new Map();
  for (const it of items) {
    if (!byDoc.has(it.docId)) byDoc.set(it.docId, []);
    byDoc.get(it.docId).push(it);
  }
  const parts = [];
  for (const [docId, lines] of byDoc) {
    parts.push(`=== Document ${docId} ("${lines[0].docName || 'document'}") ===`);
    for (const l of lines) parts.push(`[${l.id}] ${String(l.text).slice(0, 300)}`);
  }
  return parts.join('\n').slice(0, 60000);
}
