/**
 * POST /api/agents  - ENGINE B: the cloud AI agent swarm
 * -------------------------------------------------------
 * Receives ONLY masked document lines (names, TFNs etc. already replaced by
 * tokens in the browser). Runs five specialist agents in parallel and returns
 * what each one found, with the line IDs it used as evidence.
 *
 * Important design rule (Capstone 1, FR-016): the AI classifies and points to
 * evidence; it never does the maths. Even WFH hours are added up by code here,
 * after the AI says which column holds the hours.
 */
import { chat, parseJsonReply, aiSettings, sendJson } from '../lib/llm.js';
import { detectUnmaskedPII } from '../public/js/engine/redact.js';

const MAX_ITEMS = 1500;

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
Reply with JSON only:
{"timesheet": {"docId": "...", "hoursColumn": "...", "locationColumn": "..." | null, "homeValue": "..." | null, "refs": ["line id"]} | null,
 "assets": [{"description": "...", "assetType": "...", "cost": number, "purchaseDate": "YYYY-MM-DD", "workUsePercent": 100, "refs": ["line id"]}],
 "coveredExpenses": [{"description": "...", "type": "electricity|gas|internet|phone|stationery", "amount": number, "refs": ["line id"]}],
 "summary": "one plain-English sentence"}`
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

  const documentText = formatForPrompt(items);

  // Run all five agents at the same time (parallel swarm)
  const names = Object.keys(AGENTS);
  const results = await Promise.allSettled(
    names.map((key) =>
      chat(
        [
          { role: 'system', content: AGENTS[key].prompt },
          { role: 'user', content: `Documents (each line starts with its line id in square brackets):\n\n${documentText}` }
        ],
        { json: true }
      )
    )
  );

  const agents = {};
  const reports = [];
  names.forEach((key, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const parsed = parseJsonReply(r.value.text);
      agents[key] = parsed;
      reports.push({ agent: AGENTS[key].name, engine: `Cloud AI (${r.value.model})`, ms: r.value.ms, summary: parsed?.summary || 'No readable answer.', ok: Boolean(parsed) });
    } else {
      reports.push({ agent: AGENTS[key].name, engine: 'Cloud AI', ms: 0, summary: `Failed: ${r.reason.message}`, ok: false });
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
