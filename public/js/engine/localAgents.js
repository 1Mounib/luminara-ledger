/**
 * TaxMate - LOCAL (RULES-BASED) AGENT SWARM
 * -------------------------------------------------
 * Five "agents" that read the masked document lines and pull out the facts
 * the tax engine needs. This version uses plain pattern rules, so it:
 *   - runs fully on the user's device in Sovereign Mode (nothing leaves), and
 *   - is the automatic fallback if the cloud AI (Engine B) is unavailable.
 *
 * The cloud version (api/agents.js) returns results in exactly the same shape.
 *
 * An "item" is one line of a document:
 *   { id, docId, docName, docKind, text, cells?, confidence? }
 */

export const AGENT_NAMES = {
  employment: 'Employment Income Agent',
  investment: 'Investment Income Agent',
  rental: 'Rental Property Agent',
  deduction: 'Deduction Extraction Agent',
  compliance: 'Tax Compliance Agent'
};

/** "$1,200.00" -> 1200 */
export function parseMoney(text) {
  const m = String(text).match(/-?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/);
  return m ? Number((m[1] + (m[2] || '')).replace(/,/g, '')) : null;
}

/** Finds all money amounts written with a $ sign or two decimals in a line. */
export function moneyIn(text) {
  return [...String(text).matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?|\b(\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\b/g)]
    .map((m) => Number(m[0].replace(/[$,\s]/g, '')));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Reads dates like 29/12/2025, 2025-12-29 or 29 Dec 2025 and returns "2025-12-29". */
export function parseDate(text) {
  const s = String(text);
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i);
  if (m) return `${m[3]}-${String(MONTHS[m[2].toLowerCase().slice(0, 3)]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Decides what kind of document this is from its words. */
export function classifyDocument(items) {
  const all = items.map((i) => i.text).join(' ').toLowerCase();
  if (/income statement|payment summary|gross payments|payg/.test(all)) return 'income_statement';
  if (/timesheet|wfh hours|hours worked|work from home log/.test(all) || items.some((i) => i.cells && hoursKey(i.cells))) return 'wfh_timesheet';
  if (/dividend|franking/.test(all)) return 'dividend_statement';
  if (/rental statement|rent received|property manager/.test(all)) return 'rental_statement';
  if (/private health|hospital cover/.test(all)) return 'private_health';
  if (/chair|desk|laptop|monitor|printer|bookshelf|stand|keyboard/.test(all)) return 'asset_receipt';
  if (/kwh|electricity|energy|\bgas\b/.test(all)) return 'bill_electricity';
  if (/\bnbn\b|internet|broadband/.test(all)) return 'bill_internet';
  if (/mobile|phone plan|telco|calls/.test(all)) return 'bill_phone';
  return 'other';
}

function hoursKey(cells) {
  return Object.keys(cells).find((k) => /hours/i.test(k));
}

function groupByDoc(items) {
  const docs = new Map();
  for (const item of items) {
    if (!docs.has(item.docId)) docs.set(item.docId, { docId: item.docId, docName: item.docName, items: [] });
    docs.get(item.docId).items.push(item);
  }
  for (const doc of docs.values()) doc.kind = classifyDocument(doc.items);
  return [...docs.values()];
}

/** Finds the first line matching a label and returns its amount + where it came from. */
function findLabelledAmount(items, labelRegex) {
  for (const item of items) {
    if (labelRegex.test(item.text)) {
      const amounts = moneyIn(item.text);
      if (amounts.length) return { value: amounts[amounts.length - 1], refs: [item.id] };
    }
  }
  return null;
}

// ---------------------------------------------------------------- the 5 agents

/** FR-010: salary and tax withheld from the income statement. */
export function employmentAgent(docs) {
  const findings = { salary: null, taxWithheld: null };
  for (const doc of docs.filter((d) => d.kind === 'income_statement')) {
    findings.salary ??= findLabelledAmount(doc.items, /gross (payments|salary|wages)|salary and wages/i);
    findings.taxWithheld ??= findLabelledAmount(doc.items, /tax withheld|payg withholding/i);
  }
  const summary = findings.salary
    ? `Found salary of $${findings.salary.value.toLocaleString()} and tax withheld of $${(findings.taxWithheld?.value ?? 0).toLocaleString()}.`
    : 'No income statement found.';
  return { findings, summary };
}

/** FR-011 (out of scope for WFH release): reports whether investment documents exist. */
export function investmentAgent(docs) {
  const n = docs.filter((d) => d.kind === 'dividend_statement').length;
  return { findings: {}, summary: n ? `${n} dividend statement(s) found - investment income is not part of this release.` : 'No investment income documents found.' };
}

/** FR-012 (out of scope for WFH release). */
export function rentalAgent(docs) {
  const n = docs.filter((d) => d.kind === 'rental_statement').length;
  return { findings: {}, summary: n ? `${n} rental statement(s) found - rental property is not part of this release.` : 'No rental property documents found.' };
}

/** FR-013: WFH hours, work assets, and running-cost bills. */
export function deductionAgent(docs) {
  const findings = { wfhHours: null, assets: [], coveredExpenses: [] };

  for (const doc of docs) {
    if (doc.kind === 'wfh_timesheet') {
      // Prefer a stated total; otherwise add up the hours column for rows worked at home.
      const total = doc.items.find((i) => /total.*hours|hours.*total/i.test(i.text));
      let hours = 0;
      const refs = [];
      for (const item of doc.items) {
        if (!item.cells || /total/i.test(Object.values(item.cells)[0] || '')) continue;
        const key = hoursKey(item.cells);
        const location = Object.entries(item.cells).find(([k]) => /location|where/i.test(k))?.[1] || 'home';
        const h = Number(String(item.cells[key]).replace(/[^\d.]/g, ''));
        if (key && h > 0 && /home/i.test(location)) { hours += h; refs.push(item.id); }
      }
      if (total) {
        const stated = Number((total.text.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(hours|hrs)?\s*$/i) || [])[1]?.replace(/,/g, ''));
        if (stated) { hours = stated; refs.unshift(total.id); }
      }
      if (hours > 0) findings.wfhHours = { value: Math.round(hours * 100) / 100, refs: refs.slice(0, 60) };
    }

    if (doc.kind === 'asset_receipt') {
      const line = doc.items.find((i) => /chair|desk|laptop|monitor|printer|bookshelf|stand|keyboard/i.test(i.text) && moneyIn(i.text).length);
      const totalLine = doc.items.find((i) => /total/i.test(i.text) && moneyIn(i.text).length) || line;
      const dateLine = doc.items.find((i) => parseDate(i.text));
      if (totalLine) {
        const text = (line || totalLine).text;
        findings.assets.push({
          id: doc.docId,
          description: describeAsset(text),
          assetType: assetTypeOf(text),
          cost: moneyIn(totalLine.text).slice(-1)[0],
          purchaseDate: dateLine ? parseDate(dateLine.text) : null,
          workUsePercent: 100,
          refs: [...new Set([line?.id, totalLine.id, dateLine?.id].filter(Boolean))]
        });
      }
    }

    if (/^bill_/.test(doc.kind)) {
      const due = findLabelledAmount(doc.items, /total|amount due|amount paid|annual/i);
      if (due) {
        const type = doc.kind.replace('bill_', '');
        findings.coveredExpenses.push({ id: doc.docId, description: `${capitalise(type)} bill`, type, amount: due.value, refs: due.refs });
      }
    }
  }
  const parts = [];
  if (findings.wfhHours) parts.push(`${findings.wfhHours.value.toLocaleString()} WFH hours`);
  if (findings.assets.length) parts.push(`${findings.assets.length} work asset(s)`);
  if (findings.coveredExpenses.length) parts.push(`${findings.coveredExpenses.length} running-cost bill(s)`);
  return { findings, summary: parts.length ? `Found ${parts.join(', ')}.` : 'No deduction evidence found.' };
}

/** FR-014 / FR-024: risk checks and requests for missing documents. */
export function complianceAgent(facts, docs, rules, ocrWarnings = []) {
  const flags = [];
  const salary = facts.salary?.value || 0;
  const hours = facts.wfhHours?.value || 0;

  if (!facts.salary) flags.push({ severity: 'high', code: 'MISSING_INCOME', message: 'No income statement found. Upload your income statement from myGov or your employer.' });
  if (!hours) flags.push({ severity: 'high', code: 'MISSING_WFH_RECORD', message: 'No record of your actual work-from-home hours. The ATO requires a timesheet, roster or diary for the whole year - estimates are not accepted.' });
  if (hours > 2000) flags.push({ severity: 'medium', code: 'HIGH_WFH_HOURS', message: `${hours.toLocaleString()} WFH hours is unusually high (a full-time year is about 1,900 hours). Check the timesheet.`, refs: facts.wfhHours?.refs?.slice(0, 1) });
  if (facts.coveredExpenses?.length) flags.push({ severity: 'info', code: 'FIXED_RATE_COVERS_BILLS', message: 'Your electricity, internet and phone bills are covered by the 70c/hour fixed rate, so they are not claimed again (no double-claiming). Keep one of each bill as evidence.' });
  for (const asset of facts.assets || []) {
    if (!asset.purchaseDate) flags.push({ severity: 'medium', code: 'ASSET_NO_DATE', message: `No purchase date found for "${asset.description}". It is needed to work out the decline in value.`, refs: asset.refs });
  }
  const mls = rules.medicareLevySurcharge?.singleBaseThreshold;
  if (mls && salary > mls && !docs.some((d) => d.kind === 'private_health')) {
    flags.push({ severity: 'medium', code: 'PHI_MISSING', message: `Income is above $${mls.toLocaleString()}. Upload your private health insurance statement, or you may have to pay the Medicare levy surcharge.` });
  }
  const totalClaims = hours * rules.workFromHome.fixedRatePerHour + (facts.assets || []).reduce((s, a) => s + (a.cost || 0), 0);
  if (salary && totalClaims / salary > 0.1) flags.push({ severity: 'medium', code: 'HIGH_DEDUCTION_RATIO', message: 'Work-from-home claims are above 10% of salary, which is higher than typical. An accountant should review the evidence.' });
  for (const w of ocrWarnings) flags.push({ severity: 'medium', code: 'LOW_OCR_CONFIDENCE', message: `"${w.docName}" was read with ${w.confidence}% confidence (below 85%). Check the extracted values by hand.`, refs: w.refs });

  const serious = flags.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  const riskScore = Math.min(100, flags.reduce((s, f) => s + ({ high: 35, medium: 15, info: 0 }[f.severity] || 0), 5));
  return { flags, riskScore, summary: serious ? `${serious} item(s) need attention.` : 'No compliance issues found.' };
}

/**
 * The Coordinator (FR-015): runs the agents and merges their answers into
 * one "facts" object for the deterministic tax engine.
 */
export function runLocalSwarm(items, rules, ocrWarnings = []) {
  const docs = groupByDoc(items);
  const reports = [];
  const time = (name, fn) => {
    const t0 = Date.now();
    const out = fn();
    reports.push({ agent: AGENT_NAMES[name], engine: 'Local rules (on device)', summary: out.summary, ms: Date.now() - t0 });
    return out;
  };
  const employment = time('employment', () => employmentAgent(docs));
  time('investment', () => investmentAgent(docs));
  time('rental', () => rentalAgent(docs));
  const deduction = time('deduction', () => deductionAgent(docs));
  const facts = { ...employment.findings, ...deduction.findings };
  const compliance = time('compliance', () => complianceAgent(facts, docs, rules, ocrWarnings));
  return {
    facts,
    flags: compliance.flags,
    riskScore: compliance.riskScore,
    documents: docs.map((d) => ({ docId: d.docId, docName: d.docName, kind: d.kind })),
    reports
  };
}

function assetTypeOf(text) {
  const t = text.toLowerCase();
  if (/chair/.test(t)) return 'office_chair';
  if (/desk/.test(t)) return 'desk';
  if (/laptop|notebook/.test(t)) return 'laptop';
  if (/monitor|screen/.test(t)) return 'monitor';
  if (/printer/.test(t)) return 'printer';
  return 'other';
}

function describeAsset(text) {
  const cleaned = text.replace(/\$?\s?\d[\d,]*\.\d{2}/g, '').replace(/\b\d+\s*x\s*$/i, '').replace(/\s{2,}/g, ' ').replace(/[|:]+\s*$/, '').trim();
  return cleaned.length > 3 ? cleaned.slice(0, 60) : 'Work asset';
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
