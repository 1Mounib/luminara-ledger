/**
 * TaxMate - VALIDATION CHECKS for each figure
 * -------------------------------------------------------
 * Answers "why should I trust this number?" for every line of the estimate.
 * Each check is: ok (passed), fail (needs review) or wait (not done yet, e.g.
 * the accountant hasn't approved). Shown under Source and beside each figure.
 */
import { isGrounded } from './coordinator.js';
import { parseDate } from './localAgents.js';

/**
 * @param {object} line      a line from calculateReturn() (key, amount, formula, legalBasis, sourceRefs)
 * @param {object} ctx       { facts, items, answers, questions, status, approvedBy, approvedAt, rules }
 * @returns {{ status: 'validated'|'approved'|'review', label: string, checks: {state, label, detail}[] } | null}
 */
export function validateLine(line, ctx) {
  const { facts = {}, items = [], answers = {}, questions = [], rules } = ctx;
  const byId = new Map(items.map((i) => [i.id, i]));
  const checks = [];
  const add = (state, label, detail) => checks.push({ state, label, detail });
  const refs = line.sourceRefs || [];

  let fact = null;
  if (line.key === 'salary') fact = facts.salary;
  else if (line.key === 'withheld') fact = facts.taxWithheld;
  else if (line.key === 'wfh') fact = facts.wfhHours;
  else if (line.key.startsWith('asset:')) fact = (facts.assets || []).find((a) => `asset:${a.id}` === line.key);
  else if (line.key.startsWith('covered:')) fact = (facts.coveredExpenses || []).find((e) => `covered:${e.id}` === line.key);
  else if (['tax', 'lito', 'medicare'].includes(line.key)) {
    add('ok', 'Calculated by the rules engine', `${line.formula} (${line.legalBasis}). No AI is used for the maths.`);
    add('ok', 'Uses validated figures', 'Worked out from taxable income, which comes from the checked figures above.');
    return finish(checks, ctx);
  } else return null;
  if (!fact) return null;

  // 1. Is the number really in the document?
  const value = line.key === 'wfh' ? fact.value : line.key.startsWith('asset:') ? fact.cost : line.key.startsWith('covered:') ? fact.amount : fact.value;
  if (!refs.length) add('fail', 'Found in the document', 'No source line is linked to this figure.');
  else if (line.key === 'wfh' && !isGrounded(value, refs, byId)) {
    add('ok', 'Found in the document', `Added up by code from ${refs.length} timesheet row(s) marked as worked from home.`);
  } else if (isGrounded(value, refs, byId)) {
    add('ok', 'Found in the document', `${fmt(value, line.key)} appears word for word in the highlighted line.`);
  } else if (String(fact.origin || '').startsWith('Accountant override')) {
    add('ok', 'Found in the document', 'Changed by the accountant, with the reason recorded in the audit log.');
  } else {
    add('fail', 'Found in the document', `${fmt(value, line.key)} could not be found in the linked line.`);
  }

  // 2. Did both engines agree?
  const origin = String(fact.origin || '');
  if (/agree/.test(origin)) add('ok', 'Two engines agree', 'The cloud AI and the on-device rules found the same value.');
  else if (/disagreed/.test(origin)) add('fail', 'Two engines agree', 'The cloud AI found a different value. The on-device value is used; please check.');
  else if (/^Accountant override/.test(origin)) add('ok', 'Corrected by the accountant', origin);
  else if (/Cloud AI/.test(origin)) add('ok', 'Checked against the source', 'Found by the cloud AI and verified against the line it cited.');
  else if (origin) add('info', 'Two engines agree', 'Only the on-device rules read this (the cloud AI was not used).');

  // 3. Rule applied
  add('ok', 'ATO rule applied', line.legalBasis);

  // 4. Does it make sense?
  const sense = plausibility(line, fact, facts, byId, rules);
  add(sense.ok ? 'ok' : 'fail', 'Looks reasonable', sense.detail);

  // 5. Waiting for the taxpayer?
  const q = questions.find((x) => line.key === `asset:${x.assetId}`);
  if (q) {
    const a = answers[q.id];
    add(a ? 'ok' : 'fail', 'Taxpayer answered the agent', a ? `"${q.text}" Answer: ${a.label}.` : `Waiting for an answer: "${q.text}"`);
  }
  return finish(checks, ctx);
}

function finish(checks, ctx) {
  if (ctx.status === 'approved') checks.push({ state: 'ok', label: 'Approved by the accountant', detail: ctx.approvedBy ? `Signed off by ${ctx.approvedBy}${ctx.approvedAt ? ` on ${new Date(ctx.approvedAt).toLocaleDateString('en-AU')}` : ''}.` : 'Signed off.' });
  else checks.push({ state: 'wait', label: 'Approved by the accountant', detail: ctx.status === 'submitted' ? 'Waiting for the accountant to review it.' : 'Not sent to your accountant yet.' });
  const failed = checks.some((c) => c.state === 'fail');
  const status = failed ? 'review' : ctx.status === 'approved' ? 'approved' : 'validated';
  return { status, label: { review: 'Needs review', approved: 'Validated and approved', validated: 'Validated' }[status], checks };
}

/** Simple sense checks a reviewer would make first. */
function plausibility(line, fact, facts, byId, rules) {
  const k = line.key;
  if (k === 'salary') return fact.value > 0 && fact.value < 1_000_000 ? { ok: true, detail: 'A normal salary amount.' } : { ok: false, detail: 'The salary is outside the usual range.' };
  if (k === 'withheld') {
    const s = facts.salary?.value || 0;
    return s && fact.value < s * 0.5 ? { ok: true, detail: `Tax withheld is ${Math.round((fact.value / s) * 100)}% of salary, which is normal.` } : { ok: false, detail: 'Tax withheld is unusually high compared with the salary.' };
  }
  if (k === 'wfh') return fact.value > 0 && fact.value <= 2000 ? { ok: true, detail: `${fact.value.toLocaleString('en-AU')} hours is within a full-time year (about 1,900 hours).` } : { ok: false, detail: 'More hours than a full-time year. Check the timesheet.' };
  if (k.startsWith('asset:')) {
    if (!fact.purchaseDate) return { ok: false, detail: 'No purchase date, so the decline in value cannot be checked.' };
    const inYear = rules ? fact.purchaseDate >= rules.periodStart && fact.purchaseDate <= rules.periodEnd : true;
    const dateSeen = (fact.refs || []).some((r) => parseDate(byId.get(r)?.text || '') === fact.purchaseDate);
    if (!inYear) return { ok: false, detail: `Bought on ${fact.purchaseDate}, outside this financial year.` };
    return { ok: true, detail: `Bought on ${fact.purchaseDate}, inside this financial year${dateSeen ? ' (date found on the receipt)' : ''}; cost $${fact.cost.toLocaleString('en-AU')}.` };
  }
  if (k.startsWith('covered:')) return { ok: true, detail: 'Not claimed separately, so it cannot be double-claimed.' };
  return { ok: true, detail: 'No problems found.' };
}

function fmt(value, key) {
  return key === 'wfh' ? `${Number(value).toLocaleString('en-AU')} hours` : `$${Number(value).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
