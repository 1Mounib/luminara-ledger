/**
 * Tests for the admin features: editable prompts (read from the database,
 * with safe defaults), connectors per agent, the MCP address, and the AI
 * performance numbers.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONNECTORS, DEFAULT_CONNECTOR_SETTINGS, enabledConnectors } from '../public/js/engine/connectors.js';
import { DEFAULT_PROMPTS } from '../lib/prompts.js';
import { loadAiConfig, buildPrompt, instructionsFor, resetAiConfigCache } from '../lib/aiConfig.js';
import { makeReviewTools, reviewPrompt, localReviewAgent } from '../public/js/engine/reviewAgent.js';
import { analysisRuns, reviewRun, summariseRuns } from '../public/js/engine/monitoring.js';
import { runLocalSwarm } from '../public/js/engine/localAgents.js';
import { reconcile } from '../public/js/engine/coordinator.js';
import mcp from '../api/mcp.js';

const rules = JSON.parse(readFileSync(new URL('../public/rules/fy2025-26.json', import.meta.url)));
const realFetch = globalThis.fetch;

// A stand-in for the database (Supabase REST) and the site's rules files
let db = { ai_prompts: [], ai_settings: [] };
let dbUp = true;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/rules/fy2025-26.json')) return new Response(JSON.stringify(rules), { status: 200 });
  if (u.includes('/rest/v1/')) {
    if (!dbUp) throw new Error('offline');
    const table = u.split('/rest/v1/')[1].split('?')[0];
    return new Response(JSON.stringify(db[table] || []), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};
process.env.TAXMATE_SUPABASE_URL = 'http://db.test';
delete process.env.TAXMATE_CONFIG;
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { resetAiConfigCache(); db = { ai_prompts: [], ai_settings: [] }; dbUp = true; });

// ------------------------------------------------------------ prompts
test('every agent has default instructions and a fixed reply format', () => {
  assert.deepEqual(Object.keys(DEFAULT_PROMPTS), ['triage', 'employment', 'deduction', 'investment', 'rental', 'compliance', 'review', 'copilot']);
  for (const [key, p] of Object.entries(DEFAULT_PROMPTS)) {
    assert.ok(p.instructions.length > 40, `${key} instructions`);
    assert.ok(p.format.length > 10, `${key} format`);
    if (!['review', 'copilot'].includes(key)) assert.match(p.format, /JSON/, `${key} reply format stays in the code`);
  }
  assert.match(DEFAULT_PROMPTS.copilot.instructions, /registered tax agent/);
});

test('with no admin changes the agents use the defaults', async () => {
  const cfg = await loadAiConfig();
  assert.equal(cfg.source, 'database');
  assert.equal(instructionsFor(cfg, 'deduction'), DEFAULT_PROMPTS.deduction.instructions.trim());
  assert.equal(buildPrompt(cfg, 'triage'), `${DEFAULT_PROMPTS.triage.instructions.trim()}\n${DEFAULT_PROMPTS.triage.format}`);
});

test('the newest saved version is used, and the reply format is always kept', async () => {
  db.ai_prompts = [ // newest first, as the database returns them
    { id: 7, agent: 'deduction', instructions: 'NEW: Always ask for the receipt when an item is over $300.' },
    { id: 3, agent: 'deduction', instructions: 'OLD instructions that should not be used any more.' },
    { id: 5, agent: 'hacker', instructions: 'An unknown agent name is ignored by the server.' }
  ];
  const cfg = await loadAiConfig();
  assert.equal(cfg.versions.deduction, 7);
  assert.equal(cfg.versions.hacker, undefined);
  const prompt = buildPrompt(cfg, 'deduction');
  assert.ok(prompt.startsWith('NEW: Always ask'));
  assert.ok(prompt.endsWith(DEFAULT_PROMPTS.deduction.format));
  assert.equal(instructionsFor(cfg, 'employment'), DEFAULT_PROMPTS.employment.instructions.trim());
});

test('if the database cannot be reached the agents keep working on the defaults', async () => {
  dbUp = false;
  const cfg = await loadAiConfig();
  assert.equal(cfg.source, 'defaults');
  assert.equal(instructionsFor(cfg, 'copilot'), DEFAULT_PROMPTS.copilot.instructions.trim());
});

test('settings are cached for 30 seconds unless a fresh read is asked for', async () => {
  await loadAiConfig();
  db.ai_prompts = [{ id: 9, agent: 'copilot', instructions: 'Answer in one short sentence only, please.' }];
  assert.equal((await loadAiConfig()).versions.copilot, undefined);
  assert.equal((await loadAiConfig({ fresh: true })).versions.copilot, 9);
});

// ------------------------------------------------------------ connectors
test('connectors: defaults, admin choices, and nothing an agent is not allowed to have', () => {
  assert.deepEqual(enabledConnectors({}, 'review'), DEFAULT_CONNECTOR_SETTINGS.review);
  assert.deepEqual(enabledConnectors({ connectors: { review: ['lookup_rule'] } }, 'review'), ['lookup_rule']);
  // gmail is a taxpayer data source: the review agent can never be given it; MCP never gets personal data
  assert.deepEqual(enabledConnectors({ connectors: { review: ['gmail', 'recalculate'], mcp: ['read_document', 'gmail', 'lookup_rule'] } }, 'review'), ['recalculate']);
  assert.deepEqual(enabledConnectors({ connectors: { mcp: ['read_document', 'gmail', 'lookup_rule'] } }, 'mcp'), ['lookup_rule']);
  for (const c of CONNECTORS) if (c.agents.includes('mcp')) assert.ok(c.mcp, `${c.id} offered by MCP must need no personal data`);
});

test('the review agent only sees and can only call the tools switched on', () => {
  const prompt = reviewPrompt('Check the claim carefully before the accountant approves it.', ['lookup_rule']);
  assert.match(prompt, /"tool": "lookup_rule"/);
  assert.doesNotMatch(prompt, /"tool": "recalculate"/);
  assert.doesNotMatch(prompt, /use recalculate/);
  const tools = makeReviewTools({ facts: { salary: { value: 1 } }, items: [], rules, enabled: ['lookup_rule'] });
  assert.deepEqual(Object.keys(tools), ['lookup_rule']);
  assert.equal(tools.recalculate, undefined);
  assert.equal(tools.read_document, undefined);
});

test('the on-device review agent skips switched-off tools', () => {
  const items = [{ id: 'a1', docId: 'A', text: 'Gross payments $98,500.00' }];
  const facts = { salary: { value: 98500, refs: ['a1'] }, taxWithheld: { value: 22450, refs: [] }, wfhHours: { value: 1120, refs: [] }, assets: [] };
  const out = localReviewAgent({ facts, items, documents: [{ docId: 'A', kind: 'income_statement' }], rules, enabled: [] });
  assert.ok(out.review);
  const used = out.trace.filter((t) => t.tool !== 'finish');
  assert.ok(used.length > 0);
  assert.ok(used.every((t) => /switched off/.test(t.result)), 'each switched-off tool is shown as skipped, not run');
});

// ------------------------------------------------------------ MCP address
function call(body, { token = 'secret-token', method = 'POST' } = {}) {
  const req = { method, body, headers: { host: 'localhost:3000', ...(token ? { authorization: `Bearer ${token}` } : {}) } };
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }); } };
    mcp(req, res);
  });
}

test('MCP address is off until an admin sets MCP_TOKEN, and needs the token', async () => {
  delete process.env.MCP_TOKEN;
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'initialize' })).status, 503);
  process.env.MCP_TOKEN = 'secret-token';
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { token: null })).status, 401);
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { token: 'wrong' })).status, 401);
  assert.equal((await call(null, { method: 'GET' })).status, 405);
});

test('MCP: initialize, list tools, and notifications', async () => {
  process.env.MCP_TOKEN = 'secret-token';
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'taxmate');
  assert.ok(init.body.result.capabilities.tools);
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['calculate_tax', 'lookup_rule']);
  assert.equal((await call({ jsonrpc: '2.0', id: 3, method: 'nope' })).body.error.code, -32601);
});

test('MCP: calculate_tax gives the same refund as the app (Use Case 1 figures)', async () => {
  process.env.MCP_TOKEN = 'secret-token';
  const out = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'calculate_tax', arguments: {
    salary: 98500, taxWithheld: 22450, wfhHours: 1120,
    assets: [{ description: 'Office chair', cost: 450, purchaseDate: '2025-12-29', assetType: 'office_chair' }]
  } } });
  const r = out.body.result;
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.totals.totalDeductions, 806.68);
  assert.match(r.content[0].text, /registered tax agent/);
});

test('MCP: lookup_rule, and switched-off tools disappear', async () => {
  process.env.MCP_TOKEN = 'secret-token';
  const rule = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lookup_rule', arguments: { topic: 'fixed rate' } } });
  assert.match(rule.body.result.content[0].text, /70 cents/);
  resetAiConfigCache();
  db.ai_settings = [{ key: 'connectors', value: { mcp: ['lookup_rule'] } }];
  const list = await call({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((t) => t.name), ['lookup_rule']);
  const blocked = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'calculate_tax', arguments: { salary: 1, taxWithheld: 0 } } });
  assert.equal(blocked.body.error.code, -32602);
});

// ------------------------------------------------------------ AI performance
test('monitoring rows hold numbers only, and the dashboard maths is right', () => {
  const masked = [
    { id: 'a1', docId: 'A', docName: 'income.pdf', text: 'INCOME STATEMENT Employee: <PII_PERSON_1>' },
    { id: 'a2', docId: 'A', docName: 'income.pdf', text: 'Gross payments $98,500.00' },
    { id: 'a3', docId: 'A', docName: 'income.pdf', text: 'Total tax withheld $22,450.00' }
  ];
  const analysis = reconcile(runLocalSwarm(masked, rules), null, masked);
  const rows = analysisRuns(analysis, { returnId: 'R-1', cloudRequested: false });
  assert.ok(rows.length >= 2);
  assert.equal(rows.at(-1).agent, 'coordinator');
  const allowed = new Set(['return_id', 'agent', 'engine', 'ms', 'ok', 'fallback', 'steps', 'grounded', 'rejected', 'agreed', 'disagreed', 'prompt_version']);
  for (const r of rows) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  assert.doesNotMatch(JSON.stringify(rows), /98,500|PII|Gross/);

  // cloud was wanted but not used -> counted as a fall-back
  const fellBack = analysisRuns(analysis, { cloudRequested: true });
  assert.ok(fellBack.every((r) => r.fallback));

  const summary = summariseRuns([
    { agent: 'triage', engine: 'cloud', ms: 1000, ok: true, fallback: false, steps: 3, prompt_version: 2, at: '2026-11-10T01:00:00Z' },
    { agent: 'triage', engine: 'cloud', ms: 3000, ok: true, fallback: false, steps: 5, prompt_version: 2, at: '2026-11-11T01:00:00Z' },
    { agent: 'triage', engine: 'device', ms: 0, ok: false, fallback: true, steps: 2, at: '2026-11-12T01:00:00Z' },
    { agent: 'coordinator', engine: 'device', grounded: 9, rejected: 1, agreed: 6, disagreed: 2, fallback: false },
    { agent: 'coordinator', engine: 'device', grounded: 0, rejected: 0, agreed: 0, disagreed: 0, fallback: true },
    reviewRun({ review: { recommendation: 'approve' }, trace: [1, 2, 3], ms: 4200 }, { cloudRequested: true, cloudUsed: true })
  ]);
  const triage = summary.agents.find((a) => a.agent === 'triage');
  assert.deepEqual([triage.runs, triage.cloudRuns, triage.successRate, triage.fallbackRate, triage.avgMs, triage.p95Ms, triage.versions], [3, 2, 67, 33, 2000, 3000, [2]]);
  assert.equal(triage.last, '2026-11-12T01:00:00Z');
  assert.deepEqual(summary.coordinator, { checked: 10, grounded: 9, rejected: 1, agreed: 6, disagreed: 2, groundedRate: 90, agreementRate: 75, fallbackRate: 50 });
  assert.equal(summary.analyses, 2);
  assert.equal(summary.agents.find((a) => a.agent === 'review').avgMs, 4200);
});
