/**
 * TaxMate - REVIEW AGENT (helps the accountant, never decides for them)
 * ----------------------------------------------------------------------
 * A tool-using agent: it plans, calls tools, reads the results and decides
 * what to do next, until it can give the accountant a recommendation.
 *
 * Tools (all run as code, so the agent never does arithmetic itself):
 *   read_document  - read the masked lines of one document
 *   recalculate    - "what if" run of the rules engine with changed figures
 *   lookup_rule    - fetch the ATO rule text from the checked knowledge base
 *   finish         - give the recommendation, notes and questions for the client
 *
 * The same tools drive two versions:
 *   - runReviewLoop(): the cloud AI chooses the tools (api/review.js)
 *   - localReviewAgent(): a fixed plan on this device (Sovereign Mode / fallback)
 */
import { calculateReturn } from './taxEngine.js';
import { toEngineInput } from './facts.js';
import { KNOWLEDGE_ITEMS } from './knowledge.js';

export const REVIEW_PROMPT = `You are the Review Agent of TaxMate. You help a registered tax agent (the accountant) review a client's work-from-home tax claim before they approve it. You only advise; the accountant decides.
You work in steps. Each turn, reply with JSON only, choosing ONE tool:
{"thought": "one short sentence: what you will check and why", "tool": "read_document", "args": {"docId": "..."}}
{"thought": "...", "tool": "recalculate", "args": {"wfhHours": number, "salary": number, "taxWithheld": number, "assetWorkUse": {"<asset id>": percent}}}   (any subset; the rules engine returns the new totals)
{"thought": "...", "tool": "lookup_rule", "args": {"topic": "fixed rate | records | depreciation | double claiming | ..."}}
{"thought": "...", "tool": "finish", "args": {"recommendation": "approve | query_client | adjust", "summary": "one or two sentences for the accountant", "notes": [{"severity": "high|medium|info", "message": "...", "refs": ["line id"]}], "clientQuestions": ["a polite question to the client"]}}
Rules: never calculate tax or deductions yourself - use recalculate. Cite line ids from the documents. Use at most 5 tools, then finish. Personal details appear as placeholders such as <PII_PERSON_1>; never guess them.`;

/** The tools, bound to one return. Each returns a short text result for the agent. */
export function makeReviewTools({ facts, items, documents = [], rules }) {
  return {
    read_document({ docId } = {}) {
      const lines = items.filter((i) => i.docId === docId);
      if (!lines.length) return { text: `No document with id "${docId}". Documents: ${documents.map((d) => `${d.docId} (${d.kind})`).join(', ')}`, short: 'document not found' };
      const shown = lines.slice(0, 60).map((l) => `[${l.id}] ${String(l.text).slice(0, 200)}`).join('\n');
      return { text: `${lines.length} lines${lines.length > 60 ? ' (first 60 shown)' : ''}:\n${shown}`, short: `read ${lines.length} lines` };
    },
    recalculate(args = {}) {
      const changed = structuredClone(facts);
      const said = [];
      for (const key of ['wfhHours', 'salary', 'taxWithheld']) {
        if (Number.isFinite(Number(args[key])) && args[key] !== null && args[key] !== '') {
          changed[key] = { ...(changed[key] || {}), value: Number(args[key]) };
          said.push(`${key} = ${Number(args[key]).toLocaleString('en-AU')}`);
        }
      }
      for (const [id, pct] of Object.entries(args.assetWorkUse || {})) {
        const asset = (changed.assets || []).find((a) => a.id === id);
        if (asset && Number(pct) >= 0 && Number(pct) <= 100) { asset.workUsePercent = Number(pct); said.push(`${asset.description} work use = ${pct}%`); }
      }
      const base = calculateReturn(toEngineInput(facts), rules).totals;
      const now = calculateReturn(toEngineInput(changed), rules).totals;
      const diff = Math.round((now.refund - base.refund) * 100) / 100;
      const money = (n) => `$${Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const text = `With ${said.join(', ') || 'no changes'}: deductions ${money(now.totalDeductions)}, taxable income ${money(now.taxableIncome)}, net tax ${money(now.netTax)}, ${now.refund >= 0 ? 'refund' : 'owing'} ${money(now.refund)} (${diff === 0 ? 'no change' : `${diff > 0 ? 'up' : 'down'} ${money(diff)}`} from ${money(base.refund)}).`;
      return { text, short: text };
    },
    lookup_rule({ topic = '' } = {}) {
      const q = String(topic).toLowerCase();
      const scored = KNOWLEDGE_ITEMS.map((k) => ({ k, score: k.keywords.filter((w) => q.includes(w)).length + (q.includes(k.topic) ? 3 : 0) })).sort((a, b) => b.score - a.score);
      const hit = scored[0]?.score ? scored[0].k : null;
      return hit ? { text: hit.text, short: `rule on ${hit.topic}` } : { text: `No rule found for "${topic}". Topics: ${KNOWLEDGE_ITEMS.map((k) => k.topic).join(', ')}`, short: 'no rule found' };
    }
  };
}

/** The return as the agent sees it: masked figures, where they came from, flags and open questions. */
export function reviewBrief({ facts, result, flags = [], questions = [], answers = {}, documents = [], tally }) {
  return JSON.stringify({
    figures: {
      salary: facts.salary && { value: facts.salary.value, refs: facts.salary.refs, origin: facts.salary.origin },
      taxWithheld: facts.taxWithheld && { value: facts.taxWithheld.value, refs: facts.taxWithheld.refs, origin: facts.taxWithheld.origin },
      wfhHours: facts.wfhHours && { value: facts.wfhHours.value, refs: (facts.wfhHours.refs || []).slice(0, 3), origin: facts.wfhHours.origin },
      assets: (facts.assets || []).map((a) => ({ id: a.id, description: a.description, cost: a.cost, purchaseDate: a.purchaseDate, workUsePercent: a.workUsePercent ?? 100, refs: a.refs, origin: a.origin })),
      billsCoveredByFixedRate: (facts.coveredExpenses || []).map((e) => ({ description: e.description, amount: e.amount }))
    },
    totals: result?.totals,
    documents: documents.map((d) => ({ docId: d.docId, kind: d.aiKind || d.kind })),
    flags: flags.map((f) => ({ severity: f.severity, message: f.message })),
    questionsToTaxpayer: questions.map((q) => ({ question: q.text, answer: answers[q.id]?.label || 'not answered yet' })),
    agentChecks: tally || null
  });
}

/**
 * The cloud loop: ask the model which tool to use, run it, feed the result back.
 * @param {(messages: object[]) => Promise<{text: string, model?: string}>} ask
 */
export async function runReviewLoop({ ask, tools, brief, maxSteps = 6, timeLeft = () => Infinity }) {
  const messages = [
    { role: 'system', content: REVIEW_PROMPT },
    { role: 'user', content: `The return to review:\n${brief}` }
  ];
  const trace = [];
  let model = null;
  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1 || timeLeft() < 8000;
    if (last) messages.push({ role: 'user', content: 'You have used your tool budget. Reply now with the finish tool.' });
    const reply = await ask(messages);
    model = reply.model || model;
    const move = parseMove(reply.text);
    if (!move) {
      messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: 'That was not valid JSON with a "tool". Reply with JSON only.' });
      continue;
    }
    if (move.tool === 'finish') {
      trace.push({ thought: move.thought, tool: 'finish', args: {}, result: 'Gave the recommendation.' });
      return { review: cleanFinish(move.args), trace, model };
    }
    const tool = tools[move.tool];
    const out = tool ? tool(move.args || {}) : { text: `Unknown tool "${move.tool}". Use read_document, recalculate, lookup_rule or finish.`, short: 'unknown tool' };
    trace.push({ thought: move.thought, tool: move.tool, args: move.args || {}, result: out.short });
    messages.push({ role: 'assistant', content: JSON.stringify(move) }, { role: 'user', content: `Tool result:\n${out.text}` });
  }
  return { review: null, trace, model };
}

function parseMove(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    return j && typeof j.tool === 'string' ? j : null;
  } catch { return null; }
}

function cleanFinish(args = {}) {
  const rec = ['approve', 'query_client', 'adjust'].includes(args.recommendation) ? args.recommendation : 'query_client';
  return {
    recommendation: rec,
    summary: String(args.summary || '').slice(0, 400),
    notes: (args.notes || []).slice(0, 6).map((n) => ({ severity: ['high', 'medium', 'info'].includes(n.severity) ? n.severity : 'info', message: String(n.message || '').slice(0, 300), refs: (n.refs || []).slice(0, 4) })),
    clientQuestions: (args.clientQuestions || []).slice(0, 5).map((q) => String(q).slice(0, 240))
  };
}

/**
 * The on-device version: a fixed plan that uses the same tools, so the
 * accountant still gets a review (and sees each step) without the cloud AI.
 */
export function localReviewAgent({ facts, items, documents = [], rules, flags = [], questions = [], answers = {} }) {
  const tools = makeReviewTools({ facts, items, documents, rules });
  const trace = [];
  const use = (thought, tool, args) => { const out = tools[tool](args); trace.push({ thought, tool, args, result: out.short }); return out; };
  const notes = [];
  const clientQuestions = [];

  use('Check what records the ATO needs for the fixed rate method.', 'lookup_rule', { topic: 'records' });
  const timesheet = documents.find((d) => (d.aiKind || d.kind) === 'wfh_timesheet');
  if (timesheet) use('Read the timesheet to confirm the hours are actual records, not estimates.', 'read_document', { docId: timesheet.docId });
  else { notes.push({ severity: 'high', message: 'There is no timesheet, so the fixed rate claim cannot be supported yet.', refs: [] }); clientQuestions.push('Could you send your work-from-home timesheet, roster or diary for the whole year?'); }

  const hours = facts.wfhHours?.value || 0;
  if (hours > 2000) {
    const out = use('The hours look high, so check the effect of a full-time year (1,900 hours).', 'recalculate', { wfhHours: 1900 });
    notes.push({ severity: 'medium', message: `${hours.toLocaleString('en-AU')} hours is more than a full-time year. ${out.text}`, refs: facts.wfhHours?.refs?.slice(0, 1) || [] });
    clientQuestions.push('Your timesheet shows more hours than a full-time year. Could you confirm the hours worked from home?');
  }
  const open = questions.filter((q) => !answers[q.id]);
  for (const q of open) {
    const out = use(`"${q.text}" is unanswered, so check how much it matters if only half is for work.`, 'recalculate', { assetWorkUse: { [q.assetId]: 50 } });
    notes.push({ severity: 'medium', message: `The client hasn't said how much they use this item for work. ${out.text}`, refs: q.refs || [] });
    clientQuestions.push(q.text.replace(/^Do you/, 'Could you confirm whether you'));
  }
  for (const f of flags.filter((x) => ['AGENTS_DISAGREE', 'AI_UNVERIFIED', 'AI_DOUBTS_CLAIM', 'ASSET_NO_DATE', 'LOW_OCR_CONFIDENCE', 'HIGH_DEDUCTION_RATIO'].includes(x.code))) {
    notes.push({ severity: 'medium', message: f.message, refs: f.refs || [] });
  }
  if (flags.some((f) => f.code === 'PHI_MISSING')) clientQuestions.push('Do you have private hospital cover? If so, please send your private health insurance statement.');
  if (flags.some((f) => f.code === 'MISSING_INCOME')) clientQuestions.push('Could you send your income statement from myGov?');

  const recommendation = clientQuestions.length ? 'query_client' : notes.some((n) => n.severity !== 'info') ? 'adjust' : 'approve';
  if (!notes.length) notes.push({ severity: 'info', message: 'Every figure was found in its source line, and the two engines agreed. Nothing unusual found.', refs: [] });
  trace.push({ thought: 'Summarise for the accountant.', tool: 'finish', args: {}, result: 'Gave the recommendation.' });
  const summary = {
    approve: 'The claim is supported by the documents. It looks ready to approve.',
    adjust: 'The claim is mostly supported, but some figures should be checked before approving.',
    query_client: 'Some information is missing or unclear. Ask the client before approving.'
  }[recommendation];
  return { review: { recommendation, summary, notes, clientQuestions }, trace, model: null };
}
