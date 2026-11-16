/**
 * Tests for the upgraded agents: triage and routing, the Deduction agent's
 * decisions and questions, the coordinator's merging of AI judgement,
 * the validation checks, and the accountant's tool-using Review agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLocalSwarm, decideClaims, triageAgent } from '../public/js/engine/localAgents.js';
import { reconcile } from '../public/js/engine/coordinator.js';
import { validateLine } from '../public/js/engine/validate.js';
import { calculateReturn } from '../public/js/engine/taxEngine.js';
import { toEngineInput } from '../public/js/engine/facts.js';
import { makeReviewTools, runReviewLoop, localReviewAgent, reviewBrief } from '../public/js/engine/reviewAgent.js';

const rules = JSON.parse(readFileSync(new URL('../public/rules/fy2025-26.json', import.meta.url)));

// A small masked return: income statement, timesheet with a total, a chair and a laptop receipt, a bill
const items = [
  { id: 'a1', docId: 'A', docName: 'income.pdf', text: 'INCOME STATEMENT 2025-26 Employee: <PII_PERSON_1>' },
  { id: 'a2', docId: 'A', docName: 'income.pdf', text: 'Gross payments $98,500.00' },
  { id: 'a3', docId: 'A', docName: 'income.pdf', text: 'Total tax withheld $22,450.00' },
  { id: 'b1', docId: 'B', docName: 'timesheet.csv', text: 'Date, Hours, Location', cells: { Date: 'Date', Hours: 'Hours', Location: 'Location' } },
  { id: 'b2', docId: 'B', docName: 'timesheet.csv', text: '2025-07-01, 8, Home', cells: { Date: '2025-07-01', Hours: '8', Location: 'Home' } },
  { id: 'b3', docId: 'B', docName: 'timesheet.csv', text: 'Total WFH hours 1,120' },
  { id: 'c1', docId: 'C', docName: 'chair.pdf', text: 'Tax invoice 29/12/2025' },
  { id: 'c2', docId: 'C', docName: 'chair.pdf', text: 'Ergonomic office chair $450.00' },
  { id: 'c3', docId: 'C', docName: 'chair.pdf', text: 'Total $450.00' },
  { id: 'd1', docId: 'D', docName: 'laptop.pdf', text: 'Receipt 03/03/2026' },
  { id: 'd2', docId: 'D', docName: 'laptop.pdf', text: 'Laptop 14 inch $1,200.00' },
  { id: 'd3', docId: 'D', docName: 'laptop.pdf', text: 'Total $1,200.00' },
  { id: 'e1', docId: 'E', docName: 'power.pdf', text: 'Electricity annual statement 2,400 kWh' },
  { id: 'e2', docId: 'E', docName: 'power.pdf', text: 'Total amount paid $1,310.40' }
];

test('triage agent sorts documents and routes them to the right specialist', () => {
  const swarm = runLocalSwarm(items, rules);
  const kinds = Object.fromEntries(swarm.documents.map((d) => [d.docId, d.kind]));
  assert.deepEqual(kinds, { A: 'income_statement', B: 'wfh_timesheet', C: 'asset_receipt', D: 'asset_receipt', E: 'bill_electricity' });
  assert.deepEqual(swarm.documents.find((d) => d.docId === 'E').routedTo, ['deduction']);
  const unknown = triageAgent([{ docId: 'X', docName: 'x.pdf', kind: 'other', items: [{ id: 'x1', text: 'hello' }] }]);
  assert.deepEqual(unknown.findings.documents[0].routedTo, [], 'unrecognised documents go to no specialist');
});

test('deduction agent decides each item and asks about a laptop, not a chair', () => {
  const swarm = runLocalSwarm(items, rules);
  const laptop = swarm.facts.assets.find((a) => a.assetType === 'laptop');
  assert.equal(swarm.questions.length, 1);
  assert.equal(swarm.questions[0].assetId, laptop.id);
  const d = Object.fromEntries(swarm.decisions.map((x) => [x.id, x.decision]));
  assert.equal(d[`asset:${laptop.id}`], 'ask');
  assert.equal(d.wfh, 'claim');
  assert.equal(d['covered:E'], 'covered');
  const none = decideClaims({ wfhHours: null, assets: [], coveredExpenses: [] });
  assert.equal(none.decisions[0].decision, 'missing', 'no timesheet means the hours cannot be claimed');
});

test('a taxpayer answer changes the claim only through the rules engine', () => {
  const swarm = runLocalSwarm(items, rules);
  const full = calculateReturn(toEngineInput(swarm.facts), rules).totals.refund;
  const facts = structuredClone(swarm.facts);
  facts.assets.find((a) => a.assetType === 'laptop').workUsePercent = 50;
  const half = calculateReturn(toEngineInput(facts), rules).totals.refund;
  assert.ok(half < full, 'less work use means a smaller refund');
});

test('coordinator merges cloud triage, AI doubts and AI questions, and counts the checks', () => {
  const local = runLocalSwarm(items, rules);
  const cloud = {
    agents: {
      employment: { salary: { value: 98500, refs: ['a2'] }, taxWithheld: { value: 99999, refs: ['a3'] } },
      deduction: {
        assets: [{ description: 'Chair', assetType: 'office_chair', cost: 450, refs: ['c2'] }],
        decisions: [
          { item: 'Ergonomic office chair', amount: 450, decision: 'ask', reason: 'Might be used personally.' },
          { item: 'Laptop', amount: 1200, decision: 'not_claimable', reason: 'Looks like a personal purchase.' }
        ]
      },
      compliance: { flags: [] }
    },
    reports: [{ key: 'employment', agent: 'Employment Income Agent', ok: true, summary: 'ok', steps: ['Read the income statement.'] }]
  };
  const triage = { documents: [{ docId: 'A', kind: 'income_statement', reason: 'shows gross payments' }], report: { key: 'triage', agent: 'Document Triage Agent', ok: true, summary: 'Sorted', steps: ['A: income statement'] } };
  const out = reconcile(local, cloud, items, triage);
  assert.equal(out.facts.salary.origin, 'AI + on-device rules agree');
  assert.ok(out.flags.some((f) => f.code === 'AI_UNVERIFIED'), 'a withheld amount not in its line is rejected');
  assert.ok(out.flags.some((f) => f.code === 'AI_DOUBTS_CLAIM'), 'the AI doubting the laptop raises a flag');
  assert.equal(out.questions.length, 2, 'the AI added a question about the chair');
  assert.equal(out.documents.find((d) => d.docId === 'A').aiKind, 'income_statement');
  assert.equal(out.reports.at(-1).key, 'coordinator');
  assert.equal(out.tally.rejected, 1);
});

test('validation: a grounded figure is Validated; an unanswered question needs review', () => {
  const swarm = runLocalSwarm(items, rules);
  const result = calculateReturn(toEngineInput(swarm.facts), rules);
  const ctx = { facts: swarm.facts, items, answers: {}, questions: swarm.questions, status: 'draft', rules };
  const salary = validateLine(result.lines.find((l) => l.key === 'salary'), ctx);
  assert.equal(salary.status, 'validated');
  assert.ok(salary.checks.some((c) => c.label === 'Found in the document' && c.state === 'ok'));
  const laptop = swarm.facts.assets.find((a) => a.assetType === 'laptop');
  const lv = validateLine(result.lines.find((l) => l.key === `asset:${laptop.id}`), ctx);
  assert.equal(lv.status, 'review');
  const answered = validateLine(result.lines.find((l) => l.key === `asset:${laptop.id}`), { ...ctx, answers: { [swarm.questions[0].id]: { label: 'only for work (100%)' } }, status: 'approved', approvedBy: 'Jordan Lee' });
  assert.equal(answered.status, 'approved');

  const wrong = structuredClone(swarm.facts);
  wrong.salary.value = 12345;
  const bad = validateLine(calculateReturn(toEngineInput(wrong), rules).lines.find((l) => l.key === 'salary'), { ...ctx, facts: wrong });
  assert.equal(bad.status, 'review', 'a number that is not in its source line fails');
});

test('review agent tools run the rules engine, read documents and find rules', () => {
  const swarm = runLocalSwarm(items, rules);
  const tools = makeReviewTools({ facts: swarm.facts, items, documents: swarm.documents, rules });
  assert.match(tools.recalculate({ wfhHours: 1100 }).text, /down \$/);
  assert.match(tools.read_document({ docId: 'B' }).text, /\[b3\] Total WFH hours 1,120/);
  assert.match(tools.lookup_rule({ topic: 'records' }).text, /actual hours/i);
});

test('review agent loop: the model picks tools until it finishes', async () => {
  const swarm = runLocalSwarm(items, rules);
  const tools = makeReviewTools({ facts: swarm.facts, items, documents: swarm.documents, rules });
  const moves = [
    { thought: 'Read the timesheet.', tool: 'read_document', args: { docId: 'B' } },
    { thought: 'What if the laptop is half personal?', tool: 'recalculate', args: { assetWorkUse: { D: 50 } } },
    { thought: 'Done.', tool: 'finish', args: { recommendation: 'query_client', summary: 'Ask about the laptop.', notes: [{ severity: 'medium', message: 'Laptop work use unknown.', refs: ['d2'] }], clientQuestions: ['Is the laptop only for work?'] } }
  ];
  const seen = [];
  const out = await runReviewLoop({ ask: async (messages) => { seen.push(messages.at(-1).content); return { text: JSON.stringify(moves[seen.length - 1]), model: 'stub' }; }, tools, brief: reviewBrief({ facts: swarm.facts }) });
  assert.equal(out.review.recommendation, 'query_client');
  assert.deepEqual(out.trace.map((t) => t.tool), ['read_document', 'recalculate', 'finish']);
  assert.match(seen[2], /Tool result:[\s\S]*refund/, 'the recalculation result is fed back to the model');
});

test('on-device review agent asks the client about unanswered questions', () => {
  const swarm = runLocalSwarm(items, rules);
  const out = localReviewAgent({ facts: swarm.facts, items, documents: swarm.documents, rules, flags: swarm.flags, questions: swarm.questions, answers: {} });
  assert.equal(out.review.recommendation, 'query_client');
  assert.ok(out.review.clientQuestions.some((q) => /laptop/i.test(q)));
  assert.ok(out.trace.some((t) => t.tool === 'recalculate'));
});
