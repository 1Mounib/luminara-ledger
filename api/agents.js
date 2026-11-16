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
import { AGENTS, TRIAGE } from '../lib/prompts.js';
import { loadAiConfig, buildPrompt } from '../lib/aiConfig.js';

const MAX_ITEMS = 1500;

/** Every agent also reports what it did, so the app can show its working. */
const STEPS_RULE = `Also include "steps": up to 4 short plain-English sentences saying what you did, in order, citing line ids in square brackets where useful.`;

/** The triage agent sees only the first lines of each document: enough to tell what it is. */
const TRIAGE_LINES = 20;
export const KINDS = ['income_statement', 'wfh_timesheet', 'asset_receipt', 'bill_electricity', 'bill_internet', 'bill_phone', 'dividend_statement', 'rental_statement', 'private_health', 'other'];
const ROUTES = {
  income_statement: ['employment'], wfh_timesheet: ['deduction'], asset_receipt: ['deduction'],
  bill_electricity: ['deduction'], bill_internet: ['deduction'], bill_phone: ['deduction'],
  dividend_statement: ['investment'], rental_statement: ['rental'], private_health: [], other: []
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

  // The admin can change each agent's instructions in the Admin page (read from the database)
  const cfg = await loadAiConfig();

  // Stage 1: the triage agent decides what each document is
  if (req.body?.stage === 'triage') {
    const firstLines = [];
    const seen = new Map();
    for (const it of items) {
      const n = seen.get(it.docId) || 0;
      if (n < TRIAGE_LINES) { firstLines.push(it); seen.set(it.docId, n + 1); }
    }
    try {
      const r = await chat([{ role: 'system', content: buildPrompt(cfg, 'triage') }, { role: 'user', content: `Documents (each line starts with its line id in square brackets):\n\n${formatForPrompt(firstLines)}` }], { json: true });
      const parsed = parseJsonReply(r.text) || {};
      const known = new Set(items.map((i) => i.docId));
      const documents = (parsed.documents || []).filter((d) => known.has(d.docId)).map((d) => {
        const kind = KINDS.includes(d.kind) ? d.kind : 'other';
        return { docId: d.docId, kind, confidence: Number(d.confidence) || null, reason: String(d.reason || '').slice(0, 160), routedTo: ROUTES[kind], refs: (d.refs || []).slice(0, 2) };
      });
      return sendJson(res, 200, { documents, report: { key: 'triage', agent: TRIAGE.name, engine: `Cloud AI (${r.model})`, ms: r.ms, summary: parsed.summary || `Sorted ${documents.length} document(s).`, steps: (parsed.steps || []).slice(0, 12).map(String), ok: true }, promptVersions: cfg.versions });
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
          { role: 'system', content: `${buildPrompt(cfg, key)}\n${STEPS_RULE}` },
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

  return sendJson(res, 200, { agents, reports, promptVersions: cfg.versions });
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
