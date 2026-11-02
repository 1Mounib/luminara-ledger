/**
 * Tests for the deterministic tax engine. Run with:  npm test
 * Expected values are worked out by hand from the ATO rates for 2025-26,
 * so these tests are the "experimental results" for the rules engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  incomeTax, lowIncomeTaxOffset, medicareLevy, wfhFixedRateDeduction,
  daysHeldInYear, assetDeduction, calculateReturn
} from '../public/js/engine/taxEngine.js';

const rules = JSON.parse(readFileSync(new URL('../public/rules/fy2025-26.json', import.meta.url)));

test('income tax: one value in every bracket (2025-26)', () => {
  const cases = [
    [0, 0], [18200, 0], [18201, 0.16], [30000, 1888], [45000, 4288],
    [60000, 8788], [135000, 31288], [150000, 36838], [190000, 51638], [250000, 78638]
  ];
  for (const [income, expected] of cases) assert.equal(incomeTax(income, rules), expected, `income $${income}`);
});

test('low income tax offset: full, first taper, second taper, nil', () => {
  assert.equal(lowIncomeTaxOffset(30000, rules), 700);
  assert.equal(lowIncomeTaxOffset(37500, rules), 700);
  assert.equal(lowIncomeTaxOffset(41000, rules), 525);   // 700 - 5% x 3,500
  assert.equal(lowIncomeTaxOffset(45000, rules), 325);
  assert.equal(lowIncomeTaxOffset(55000, rules), 175);   // 325 - 1.5% x 10,000
  assert.equal(lowIncomeTaxOffset(66667, rules), 0);
  assert.equal(lowIncomeTaxOffset(90000, rules), 0);
});

test('medicare levy: nil, shade-in, full 2%', () => {
  assert.equal(medicareLevy(28011, rules), 0);
  assert.equal(medicareLevy(30011, rules), 200);         // 10% x 2,000
  assert.equal(medicareLevy(80000, rules), 1600);
});

test('WFH fixed rate: 1,120 hours x 70c = $784 (Capstone 1 UC1)', () => {
  assert.equal(wfhFixedRateDeduction(1120, rules), 784);
  assert.equal(wfhFixedRateDeduction(0, rules), 0);
});

test('days held: purchase 29 Dec 2025 -> 184 days to 30 June 2026', () => {
  assert.equal(daysHeldInYear('2025-12-29', rules), 184);
  assert.equal(daysHeldInYear('2025-07-01', rules), 365);
  assert.equal(daysHeldInYear('2026-07-01', rules), 0);  // bought after year end
});

test('asset: $450 chair, 10 years, 184 days = $22.68 (Capstone 1 UC1)', () => {
  const r = assetDeduction({ cost: 450, assetType: 'office_chair', purchaseDate: '2025-12-29', workUsePercent: 100 }, rules);
  assert.equal(r.amount, 22.68);
  assert.equal(r.method, 'prime_cost');
});

test('asset: $89 laptop stand is claimed immediately (<= $300)', () => {
  const r = assetDeduction({ cost: 89, assetType: 'other', purchaseDate: '2026-03-14', workUsePercent: 100 }, rules);
  assert.equal(r.amount, 89);
  assert.equal(r.method, 'immediate');
});

test('full return for Capstone 1 Use Case 1: total WFH deduction $806.68', () => {
  const out = calculateReturn({
    salary: 98500, taxWithheld: 22450, wfhHours: 1120,
    assets: [{ id: 'chair', description: 'Ergonomic chair', cost: 450, assetType: 'office_chair', purchaseDate: '2025-12-29', workUsePercent: 100 }],
    coveredExpenses: [{ id: 'elec', description: 'Electricity bill', amount: 1200 }]
  }, rules);
  assert.equal(out.totals.totalDeductions, 806.68);
  assert.equal(out.totals.taxableIncome, 97693);          // 98,500 - 806.68, rounded down
  assert.equal(out.totals.incomeTax, 20095.9);            // 4,288 + 30% x 52,693
  assert.equal(out.totals.medicareLevy, 1953.86);         // 2% x 97,693
  assert.equal(out.totals.netTax, 22049.76);
  assert.equal(out.totals.refund, 400.24);                // 22,450 withheld - 22,049.76
  const covered = out.lines.find((l) => l.key === 'covered:elec');
  assert.equal(covered.amount, 0, 'bills covered by the fixed rate must not be claimed twice');
});

test('rules file has every field the engine needs (FR-018)', () => {
  for (const key of ['residentBrackets', 'lowIncomeTaxOffset', 'medicareLevy', 'workFromHome', 'depreciation']) {
    assert.ok(rules[key], `missing ${key}`);
  }
});
