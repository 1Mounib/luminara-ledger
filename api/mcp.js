/**
 * /api/mcp - TaxMate's tools as an MCP server (Model Context Protocol)
 * ----------------------------------------------------------------------
 * Lets an outside AI app (any MCP client) connect to TaxMate and use the
 * same connectors our agents use. Streamable HTTP transport, JSON responses,
 * no sessions. Only tools that need no personal data are offered:
 *   calculate_tax  - the deterministic rules engine
 *   lookup_rule    - the checked ATO rules library
 * Protected by a token: set MCP_TOKEN in Vercel, and send it as
 *   Authorization: Bearer <MCP_TOKEN>
 * The admin can switch each tool off in the Admin page (connectors).
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { sendJson } from '../lib/llm.js';
import { loadAiConfig } from '../lib/aiConfig.js';
import { fetchRules } from '../lib/rules.js';
import { enabledConnectors } from '../public/js/engine/connectors.js';
import { calculateReturn } from '../public/js/engine/taxEngine.js';
import { KNOWLEDGE_ITEMS } from '../public/js/engine/knowledge.js';

const PROTOCOL = '2025-06-18';

export const MCP_TOOLS = {
  recalculate: {
    name: 'calculate_tax',
    description: 'Works out an Australian employee\'s work-from-home deductions, tax and refund with TaxMate\'s deterministic rules engine (fixed rate method, decline in value, brackets, LITO, Medicare levy). No personal details needed.',
    inputSchema: {
      type: 'object',
      properties: {
        financialYear: { type: 'string', enum: ['2025-26', '2024-25'], default: '2025-26' },
        salary: { type: 'number', description: 'Gross salary and wages in dollars' },
        taxWithheld: { type: 'number', description: 'PAYG tax withheld in dollars' },
        wfhHours: { type: 'number', description: 'Actual hours worked from home in the year' },
        assets: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, cost: { type: 'number' }, purchaseDate: { type: 'string', description: 'YYYY-MM-DD' }, assetType: { type: 'string', enum: ['office_chair', 'desk', 'laptop', 'monitor', 'mobile_phone', 'printer', 'other'] }, workUsePercent: { type: 'number' } }, required: ['cost'] } }
      },
      required: ['salary', 'taxWithheld']
    }
  },
  lookup_rule: {
    name: 'lookup_rule',
    description: 'Returns the checked ATO rule text TaxMate uses for a topic: fixed rate, records, depreciation, tax agent and more.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] }
  }
};

export default async function handler(req, res) {
  if (!process.env.MCP_TOKEN) return sendJson(res, 503, { error: 'The MCP address is switched off. An admin sets MCP_TOKEN in Vercel to turn it on.' });
  if (!sameSecret(req.headers.authorization || '', `Bearer ${process.env.MCP_TOKEN}`)) return sendJson(res, 401, { error: 'Missing or wrong MCP token.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST (JSON-RPC 2.0).' });

  const cfg = await loadAiConfig();
  const enabled = enabledConnectors(cfg.settings, 'mcp');
  const body = req.body;
  const calls = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of calls) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') { replies.push(error(msg?.id ?? null, -32600, 'Invalid request')); continue; }
    if (msg.id === undefined) continue; // a notification: nothing to send back
    try {
      replies.push({ jsonrpc: '2.0', id: msg.id, result: await handle(msg, enabled, req) });
    } catch (e) {
      replies.push(error(msg.id, e.code || -32603, e.message));
    }
  }
  if (!replies.length) { res.statusCode = 202; return res.end(); }
  return sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
}

async function handle(msg, enabled, req) {
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: p.protocolVersion || PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'taxmate', version: '1.0.0' }, instructions: 'TaxMate tools for Australian work-from-home tax claims. Figures come from a deterministic rules engine; this is an estimate for a registered tax agent to review, not tax advice.' };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: Object.entries(MCP_TOOLS).filter(([id]) => enabled.includes(id)).map(([, t]) => t) };
    case 'tools/call': {
      const entry = Object.entries(MCP_TOOLS).find(([, t]) => t.name === p.name);
      if (!entry || !enabled.includes(entry[0])) throw Object.assign(new Error(`Unknown or switched-off tool: ${p.name}`), { code: -32602 });
      return runTool(entry[0], p.arguments || {}, req);
    }
    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

export async function runTool(id, args, req) {
  if (id === 'lookup_rule') {
    const q = String(args.topic || '').toLowerCase();
    const hit = KNOWLEDGE_ITEMS.map((k) => ({ k, s: k.keywords.filter((w) => q.includes(w)).length + (q.includes(k.topic) ? 3 : 0) })).sort((a, b) => b.s - a.s)[0];
    return { content: [{ type: 'text', text: hit?.s ? hit.k.text : `No rule found. Topics: ${KNOWLEDGE_ITEMS.map((k) => k.topic).join(', ')}` }], isError: !hit?.s };
  }
  const rules = await fetchRules(req, args.financialYear || '2025-26');
  const assets = (Array.isArray(args.assets) ? args.assets : []).slice(0, 50).map((a, i) => ({ id: `a${i + 1}`, description: String(a.description || `Item ${i + 1}`).slice(0, 80), cost: Number(a.cost) || 0, purchaseDate: a.purchaseDate || rules.periodStart, assetType: a.assetType || 'other', workUsePercent: a.workUsePercent ?? 100 }));
  const result = calculateReturn({ salary: Number(args.salary) || 0, taxWithheld: Number(args.taxWithheld) || 0, wfhHours: Number(args.wfhHours) || 0, assets, coveredExpenses: [], sourceRefs: {} }, rules);
  const lines = result.lines.map((l) => `- ${l.label}: $${l.amount.toFixed(2)} (${l.formula}; ${l.legalBasis})`).join('\n');
  const t = result.totals;
  return {
    content: [{ type: 'text', text: `${t.refund >= 0 ? 'Estimated refund' : 'Estimated amount owing'}: $${Math.abs(t.refund).toFixed(2)} for ${rules.financialYear}.\n${lines}\nTaxable income $${t.taxableIncome}, net tax $${t.netTax.toFixed(2)}. Estimate only, for review by a registered tax agent.` }],
    structuredContent: { financialYear: rules.financialYear, totals: t },
    isError: false
  };
}

/** Compares the token in constant time (hashing first makes the lengths equal). */
function sameSecret(a, b) {
  const h = (x) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(a), h(b));
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
