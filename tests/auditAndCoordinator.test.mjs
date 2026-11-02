/**
 * Tests for the audit ledger (tamper detection) and the coordinator's
 * hallucination guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../public/js/engine/auditLedger.js';
import { isGrounded, reconcile } from '../public/js/engine/coordinator.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), raw: m };
}

test('audit ledger: valid chain verifies, edited entry is detected', async () => {
  const storage = memoryStorage();
  const ledger = createLedger(storage);
  await ledger.append({ user: 'Jordan Lee', role: 'accountant', action: 'override', returnId: 'r1', field: 'wfhHours.value', from: 1120, to: 1100, justification: 'Timesheet shows 20h leave' });
  await ledger.append({ user: 'Jordan Lee', role: 'accountant', action: 'approve', returnId: 'r1' });
  await ledger.append({ user: 'Alex', role: 'taxpayer', action: 'submit', returnId: 'r2' });
  assert.deepEqual(await ledger.verifyChain(), { ok: true, brokenAt: null, total: 3 });

  // Someone quietly changes the override in storage...
  const entries = JSON.parse(storage.getItem('ll.audit'));
  entries[0].to = 1500;
  storage.setItem('ll.audit', JSON.stringify(entries));
  const check = await ledger.verifyChain();
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 1);
});

test('audit ledger: deleting an entry is detected', async () => {
  const storage = memoryStorage();
  const ledger = createLedger(storage);
  for (let i = 0; i < 4; i++) await ledger.append({ user: 'u', role: 'accountant', action: `a${i}`, returnId: 'r' });
  const entries = JSON.parse(storage.getItem('ll.audit'));
  entries.splice(1, 1);
  storage.setItem('ll.audit', JSON.stringify(entries));
  assert.equal((await ledger.verifyChain()).ok, false);
});

const items = [
  { id: 'd1:p1:l8', docId: 'd1', text: 'Gross payments  $98,500.00' },
  { id: 'd1:p1:l9', docId: 'd1', text: 'Tax withheld  $22,450.00' }
];

test('grounding: accepts numbers that are in the cited line, rejects invented ones', () => {
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(isGrounded(98500, ['d1:p1:l8'], byId), true);
  assert.equal(isGrounded(99500, ['d1:p1:l8'], byId), false);
  assert.equal(isGrounded(98500, ['missing'], byId), false);
  assert.equal(isGrounded(98500, [], byId), false);
});

test('reconcile: a hallucinated AI salary is ignored and flagged', () => {
  const local = { facts: { salary: { value: 98500, refs: ['d1:p1:l8'] }, taxWithheld: { value: 22450, refs: ['d1:p1:l9'] } }, flags: [], reports: [] };
  const cloud = { agents: { employment: { salary: { value: 105000, refs: ['d1:p1:l8'] }, taxWithheld: { value: 22450, refs: ['d1:p1:l9'] } } }, reports: [] };
  const out = reconcile(local, cloud, items);
  assert.equal(out.facts.salary.value, 98500);
  assert.ok(out.flags.some((f) => f.code === 'AI_UNVERIFIED'));
  assert.equal(out.facts.taxWithheld.origin, 'AI + on-device rules agree');
});

test('reconcile: sovereign mode (no cloud) keeps on-device results', () => {
  const local = { facts: { salary: { value: 98500, refs: ['d1:p1:l8'] } }, flags: [], reports: [] };
  const out = reconcile(local, null, items);
  assert.equal(out.mode, 'sovereign');
  assert.equal(out.facts.salary.origin, 'On-device rules');
});
