/**
 * LUMINARA LEDGER - DETERMINISTIC TAX ENGINE
 * ------------------------------------------
 * This file does ALL of the tax maths. The AI never calculates money.
 * (Capstone 1: FR-016 "bypass LLM-based arithmetic entirely")
 *
 * Every function here is "pure": the same input always gives the same output,
 * and nothing is sent anywhere. That is what makes it testable (see tests/).
 *
 * The numbers (tax brackets, thresholds, the 70c WFH rate) are NOT written in
 * this file. They are loaded from /rules/fy2025-26.json (FR-018), so a new tax
 * year only needs a new JSON file, not new code.
 */

/** Round to cents. Used on every money value so results are exact to 1c. */
export function roundCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 1200 -> "$1,200.00" (used in the plain-English working shown to users). */
function dollars(value) {
  return '$' + Number(value || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Income tax on taxable income, using the progressive brackets.
 * Example (2025-26): $60,000 -> $4,288 + 30% of ($60,000 - $45,000) = $8,788
 * @param {number} taxableIncome whole dollars
 * @param {object} rules the loaded rules JSON
 * @returns {number} tax in dollars and cents
 */
export function incomeTax(taxableIncome, rules) {
  if (taxableIncome <= 0) return 0;
  // Find the bracket the income falls into (the last one whose "from" is below the income)
  const bracket = rules.residentBrackets.find(
    (b) => taxableIncome > b.from && (b.to === null || taxableIncome <= b.to)
  );
  return roundCents(bracket.base + (taxableIncome - bracket.from) * bracket.rate);
}

/**
 * Low Income Tax Offset (LITO).
 * Full $700 up to $37,500, then reduces by 5c per $1 up to $45,000,
 * then by 1.5c per $1 until it reaches zero (at $66,667).
 */
export function lowIncomeTaxOffset(taxableIncome, rules) {
  const l = rules.lowIncomeTaxOffset;
  let offset;
  if (taxableIncome <= l.fullOffsetUpTo) {
    offset = l.maximum;
  } else if (taxableIncome <= l.firstTaperEndsAt) {
    offset = l.maximum - (taxableIncome - l.fullOffsetUpTo) * l.firstTaperRate;
  } else {
    const afterFirstTaper = l.maximum - (l.firstTaperEndsAt - l.fullOffsetUpTo) * l.firstTaperRate;
    offset = afterFirstTaper - (taxableIncome - l.firstTaperEndsAt) * l.secondTaperRate;
  }
  return roundCents(Math.max(0, offset));
}

/**
 * Medicare levy for a single person (2%), with the low-income "shade-in":
 *  - at or below the lower threshold: nothing
 *  - between the thresholds: 10c for each $1 above the lower threshold
 *  - above the upper threshold: 2% of taxable income
 */
export function medicareLevy(taxableIncome, rules) {
  const m = rules.medicareLevy;
  if (taxableIncome <= m.singleLowerThreshold) return 0;
  if (taxableIncome <= m.singleUpperThreshold) {
    return roundCents((taxableIncome - m.singleLowerThreshold) * m.shadeInRate);
  }
  return roundCents(taxableIncome * m.rate);
}

/** Working-from-home fixed rate method: hours x rate (70c/hour in 2024-25 and 2025-26). */
export function wfhFixedRateDeduction(hours, rules) {
  if (!hours || hours < 0) return 0;
  return roundCents(hours * rules.workFromHome.fixedRatePerHour);
}

/** Number of days an asset was held in the income year (purchase day counts). */
export function daysHeldInYear(purchaseDate, rules) {
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.parse(rules.periodStart + 'T00:00:00Z');
  const end = Date.parse(rules.periodEnd + 'T00:00:00Z');
  const bought = Date.parse(purchaseDate + 'T00:00:00Z');
  if (Number.isNaN(bought) || bought > end) return 0;
  const from = Math.max(start, bought);
  return Math.round((end - from) / DAY) + 1;
}

/**
 * Deduction for a work asset (chair, laptop, desk...).
 *  - Cost $300 or less: claim the work-use share of the cost straight away.
 *  - Over $300: "decline in value" using the prime cost method:
 *      cost x (days held / 365) x (1 / effective life) x work-use %
 *    Example (Capstone 1 UC1): $450 chair, 10-year life, 184 days -> $22.68
 */
export function assetDeduction(asset, rules) {
  const dep = rules.depreciation;
  const workShare = (asset.workUsePercent ?? 100) / 100;
  if (asset.cost <= dep.immediateDeductionThreshold) {
    return {
      amount: roundCents(asset.cost * workShare),
      method: 'immediate',
      formula: `${dollars(asset.cost)} x ${asset.workUsePercent ?? 100}% work use (cost is $${dep.immediateDeductionThreshold} or less, so it is claimed in full this year)`
    };
  }
  const life = dep.effectiveLifeYears[asset.assetType] ?? dep.effectiveLifeYears.other;
  const days = daysHeldInYear(asset.purchaseDate, rules);
  const amount = roundCents(asset.cost * (days / 365) * (1 / life) * workShare);
  return {
    amount,
    method: 'prime_cost',
    effectiveLife: life,
    daysHeld: days,
    formula: `${dollars(asset.cost)} x (${days}/365 days) x (1/${life} years) x ${asset.workUsePercent ?? 100}% work use`
  };
}

/**
 * Builds the full tax position from the reviewed facts.
 * Every line it returns carries its formula, legal basis and the source
 * document references, so the UI can show WHERE each number came from.
 *
 * @param {object} facts   { salary, taxWithheld, wfhHours, assets[], coveredExpenses[], sourceRefs{} }
 * @param {object} rules   loaded rules JSON for the financial year
 * @returns {{ lines: object[], totals: object }}
 */
export function calculateReturn(facts, rules) {
  const lines = [];
  const refs = facts.sourceRefs || {};

  // 1. Income
  const salary = roundCents(facts.salary || 0);
  lines.push({
    key: 'salary', kind: 'income', label: 'Salary and wages', amount: salary,
    formula: 'Gross payments reported on your income statement',
    legalBasis: 'ITAA 1997 s 6-5 (ordinary income)', sourceRefs: refs.salary || []
  });

  // 2. Working from home (fixed rate method)
  const wfh = wfhFixedRateDeduction(facts.wfhHours, rules);
  if (facts.wfhHours > 0) {
    lines.push({
      key: 'wfh', kind: 'deduction', label: 'Working from home (fixed rate method)', amount: wfh,
      formula: `${Number(facts.wfhHours).toLocaleString('en-AU')} hours x $${rules.workFromHome.fixedRatePerHour.toFixed(2)} per hour`,
      legalBasis: 'ITAA 1997 s 8-1; ATO fixed rate method (PCG 2023/1)', sourceRefs: refs.wfhHours || []
    });
  }

  // 3. Work assets (depreciation or immediate deduction)
  let assetTotal = 0;
  for (const asset of facts.assets || []) {
    const result = assetDeduction(asset, rules);
    assetTotal += result.amount;
    lines.push({
      key: `asset:${asset.id}`, kind: 'deduction',
      label: `${asset.description} (${result.method === 'immediate' ? 'immediate deduction' : 'decline in value'})`,
      amount: result.amount, formula: result.formula,
      legalBasis: result.method === 'immediate' ? 'ITAA 1997 s 40-80(2)' : 'ITAA 1997 Div 40 (prime cost, s 40-75)',
      sourceRefs: asset.sourceRefs || []
    });
  }

  // 4. Running costs already covered by the fixed rate: shown, but $0 (no double-claiming)
  for (const expense of facts.coveredExpenses || []) {
    lines.push({
      key: `covered:${expense.id}`, kind: 'info',
      label: `${expense.description} - covered by the fixed rate`, amount: 0,
      formula: `${dollars(expense.amount)} not claimed separately (already included in the ${Math.round(rules.workFromHome.fixedRatePerHour * 100)}c/hour rate)`,
      legalBasis: 'ATO fixed rate method: energy, internet, phone and stationery are covered',
      sourceRefs: expense.sourceRefs || []
    });
  }

  // 5. Taxable income (ATO rounds taxable income down to whole dollars)
  const totalDeductions = roundCents(wfh + assetTotal);
  const taxableIncome = Math.max(0, Math.floor(salary - totalDeductions));

  const tax = incomeTax(taxableIncome, rules);
  const lito = Math.min(lowIncomeTaxOffset(taxableIncome, rules), tax); // offset can't make tax negative
  const medicare = medicareLevy(taxableIncome, rules);
  const netTax = roundCents(tax - lito + medicare);
  const withheld = roundCents(facts.taxWithheld || 0);
  const refund = roundCents(withheld - netTax); // positive = refund, negative = you owe

  lines.push(
    { key: 'tax', kind: 'tax', label: 'Income tax on taxable income', amount: tax,
      formula: describeBracket(taxableIncome, rules), legalBasis: 'Income Tax Rates Act 1986 Sch 7', sourceRefs: [] },
    { key: 'lito', kind: 'offset', label: 'Low income tax offset', amount: lito,
      formula: lito > 0 ? 'Reduces tax for taxable income under $66,667' : `Not available above $66,667 (taxable income $${taxableIncome.toLocaleString()})`,
      legalBasis: 'ITAA 1997 s 61-115', sourceRefs: [] },
    { key: 'medicare', kind: 'tax', label: 'Medicare levy', amount: medicare,
      formula: taxableIncome > rules.medicareLevy.singleUpperThreshold ? `2% x $${taxableIncome.toLocaleString()}` : 'Reduced/nil for low income',
      legalBasis: 'Medicare Levy Act 1986 s 6-7', sourceRefs: [] },
    { key: 'withheld', kind: 'credit', label: 'Tax already withheld by employer', amount: withheld,
      formula: 'PAYG withholding shown on your income statement', legalBasis: 'TAA 1953 Sch 1', sourceRefs: refs.taxWithheld || [] }
  );

  return {
    financialYear: rules.financialYear,
    lines,
    totals: {
      assessableIncome: salary,
      totalDeductions,
      taxableIncome,
      incomeTax: tax,
      lowIncomeTaxOffset: lito,
      medicareLevy: medicare,
      netTax,
      taxWithheld: withheld,
      refund
    }
  };
}

/** Plain-English description of the bracket calculation, shown next to the tax line. */
function describeBracket(taxableIncome, rules) {
  if (taxableIncome <= 18200) return 'Nil - under the $18,200 tax-free threshold';
  const b = rules.residentBrackets.find((x) => taxableIncome > x.from && (x.to === null || taxableIncome <= x.to));
  return `$${b.base.toLocaleString()} + ${Math.round(b.rate * 100)}% x ($${taxableIncome.toLocaleString()} - $${b.from.toLocaleString()})`;
}
