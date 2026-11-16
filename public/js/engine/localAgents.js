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
  triage: 'Document Triage Agent',
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

/** Plain-English names for each kind of document. */
export const KIND_LABELS = {
  income_statement: 'Income statement',
  wfh_timesheet: 'Work-from-home timesheet',
  dividend_statement: 'Dividend statement',
  rental_statement: 'Rental statement',
  private_health: 'Private health insurance statement',
  asset_receipt: 'Receipt for work equipment',
  bill_electricity: 'Electricity bill',
  bill_internet: 'Internet bill',
  bill_phone: 'Phone bill',
  other: 'Unrecognised document'
};

/** Which specialist agent(s) each kind of document is sent to. Compliance always sees everything. */
export const ROUTES = {
  income_statement: ['employment'],
  wfh_timesheet: ['deduction'],
  asset_receipt: ['deduction'],
  bill_electricity: ['deduction'],
  bill_internet: ['deduction'],
  bill_phone: ['deduction'],
  dividend_statement: ['investment'],
  rental_statement: ['rental'],
  private_health: [],
  other: []
};

/** Asset types whose personal use is common, so the taxpayer is asked about work use. */
const ASK_WORK_USE = ['laptop', 'mobile_phone', 'monitor', 'printer', 'other'];

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

// ---------------------------------------------------------------- the agents

/**
 * Document Triage Agent: decides what each document is and which specialist
 * agent should read it. Every agent reports the steps it took ("steps"), so
 * the app can show what each agent did.
 */
export function triageAgent(docs) {
  const documents = docs.map((d) => {
    const routedTo = d.kind === 'other' ? [] : ROUTES[d.kind] || [];
    return {
      docId: d.docId, docName: d.docName, kind: d.kind, label: KIND_LABELS[d.kind] || KIND_LABELS.other,
      routedTo, refs: d.items.slice(0, 1).map((i) => i.id)
    };
  });
  const steps = documents.map((d) => `${d.docName}: ${d.label}${d.routedTo.length ? `, sent to the ${d.routedTo.map((k) => AGENT_NAMES[k]).join(' and ')}` : ', not used for this claim'}.`);
  const unknown = documents.filter((d) => d.kind === 'other').length;
  return {
    findings: { documents },
    steps,
    summary: `Sorted ${documents.length} document(s)${unknown ? `; ${unknown} could not be recognised` : ''}.`
  };
}

/** FR-010: salary and tax withheld from the income statement. */
export function employmentAgent(docs) {
  const findings = { salary: null, taxWithheld: null };
  const mine = docs.filter((d) => d.kind === 'income_statement');
  for (const doc of mine) {
    findings.salary ??= findLabelledAmount(doc.items, /gross (payments|salary|wages)|salary and wages/i);
    findings.taxWithheld ??= findLabelledAmount(doc.items, /tax withheld|payg withholding/i);
  }
  const steps = [mine.length ? `Read ${mine.length} income statement(s).` : 'No income statement was sent to me.'];
  if (findings.salary) steps.push(`Found gross salary of $${findings.salary.value.toLocaleString('en-AU')} on line ${findings.salary.refs[0]}.`);
  if (findings.taxWithheld) steps.push(`Found tax withheld of $${findings.taxWithheld.value.toLocaleString('en-AU')} on line ${findings.taxWithheld.refs[0]}.`);
  const summary = findings.salary
    ? `Found salary of $${findings.salary.value.toLocaleString()} and tax withheld of $${(findings.taxWithheld?.value ?? 0).toLocaleString()}.`
    : 'No income statement found.';
  return { findings, summary, steps };
}

/** FR-011 (out of scope for WFH release): reports whether investment documents exist. */
export function investmentAgent(docs) {
  const n = docs.filter((d) => d.kind === 'dividend_statement').length;
  return { findings: {}, steps: [n ? `Received ${n} dividend statement(s); investment income is not calculated in this release.` : 'No investment documents were sent to me.'], summary: n ? `${n} dividend statement(s) found - investment income is not part of this release.` : 'No investment income documents found.' };
}

/** FR-012 (out of scope for WFH release). */
export function rentalAgent(docs) {
  const n = docs.filter((d) => d.kind === 'rental_statement').length;
  return { findings: {}, steps: [n ? `Received ${n} rental statement(s); rental property is not calculated in this release.` : 'No rental documents were sent to me.'], summary: n ? `${n} rental statement(s) found - rental property is not part of this release.` : 'No rental property documents found.' };
}

/**
 * FR-013: WFH hours, work assets and running-cost bills - and a DECISION for
 * each one: claim it (and how), treat it as covered by the fixed rate, or ask
 * the taxpayer a question first. Decisions never change numbers by themselves;
 * the taxpayer's answer does, through the rules engine.
 */
export function deductionAgent(docs) {
  const findings = { wfhHours: null, assets: [], coveredExpenses: [] };
  const steps = [];

  for (const doc of docs) {
    if (doc.kind === 'wfh_timesheet') {
      // Prefer a stated total; otherwise add up the hours column for rows worked at home.
      const total = doc.items.find((i) => /total.*hours|hours.*total/i.test(i.text));
      let hours = 0;
      const refs = [];
      let rows = 0;
      for (const item of doc.items) {
        if (!item.cells || /total/i.test(Object.values(item.cells)[0] || '')) continue;
        const key = hoursKey(item.cells);
        const location = Object.entries(item.cells).find(([k]) => /location|where/i.test(k))?.[1] || 'home';
        const h = Number(String(item.cells[key]).replace(/[^\d.]/g, ''));
        if (key && h > 0 && /home/i.test(location)) { hours += h; refs.push(item.id); rows += 1; }
      }
      if (rows) steps.push(`Added up ${rows} work-from-home rows in "${doc.docName}": ${Math.round(hours * 100) / 100} hours.`);
      if (total) {
        const stated = Number((total.text.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(hours|hrs)?\s*$/i) || [])[1]?.replace(/,/g, ''));
        if (stated) {
          steps.push(`The timesheet states a total of ${stated} hours${rows && Math.abs(stated - hours) > 0.01 ? `, which differs from the rows (${Math.round(hours * 100) / 100})` : ''}; using the stated total.`);
          hours = stated; refs.unshift(total.id);
        }
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

  const { decisions, questions } = decideClaims(findings);
  for (const d of decisions) steps.push(`${d.item}: ${DECISION_WORDS[d.decision]}. ${d.reason}`);
  if (questions.length) steps.push(`Asked you ${questions.length} question(s) before the claim is final.`);

  const parts = [];
  if (findings.wfhHours) parts.push(`${findings.wfhHours.value.toLocaleString()} WFH hours`);
  if (findings.assets.length) parts.push(`${findings.assets.length} work asset(s)`);
  if (findings.coveredExpenses.length) parts.push(`${findings.coveredExpenses.length} running-cost bill(s)`);
  return {
    findings: { ...findings, decisions, questions },
    steps,
    summary: parts.length ? `Found ${parts.join(', ')} and decided how to claim each.` : 'No deduction evidence found.'
  };
}

export const DECISION_WORDS = {
  claim: 'claim it',
  covered: 'covered by the fixed rate, not claimed again',
  ask: 'need your answer first',
  missing: 'cannot claim yet',
  not_claimable: 'not claimable'
};

/** The Deduction agent's judgement for each item it found (rules version). */
export function decideClaims(findings) {
  const decisions = [];
  const questions = [];
  if (findings.wfhHours) {
    decisions.push({ id: 'wfh', item: 'Work-from-home hours', decision: 'claim', method: 'fixed_rate',
      reason: 'There is a record of actual hours, so the 70c-per-hour fixed rate can be used.', rule: 'ATO fixed rate method (PCG 2023/1)', refs: findings.wfhHours.refs.slice(0, 1) });
  } else {
    decisions.push({ id: 'wfh', item: 'Work-from-home hours', decision: 'missing', method: 'fixed_rate',
      reason: 'No timesheet, roster or diary of actual hours was found, and the ATO does not accept estimates.', rule: 'ATO fixed rate method record-keeping (PCG 2023/1)', refs: [] });
  }
  for (const a of findings.assets || []) {
    const big = a.cost > 300;
    const ask = ASK_WORK_USE.includes(a.assetType);
    decisions.push({
      id: `asset:${a.id}`, item: a.description, decision: ask ? 'ask' : 'claim', method: big ? 'decline_in_value' : 'immediate',
      reason: `${big ? 'It cost more than $300, so it is claimed over its effective life (decline in value)' : 'It cost $300 or less, so it can be claimed in full this year'}.${ask ? ' Items like this are often used personally too, so the work-use share is needed.' : ' Home office furniture, assumed 100% work use.'}`,
      rule: big ? 'ITAA 1997 Div 40 (decline in value)' : 'ITAA 1997 s 40-80(2) (items $300 or less)', refs: a.refs
    });
    if (ask) {
      questions.push({
        id: `q-${a.id}`, assetId: a.id, agent: 'deduction', refs: a.refs,
        text: `Do you use the ${a.description.toLowerCase()} only for work?`,
        why: 'Only the work-use share can be claimed. Until you answer, it is counted as 100% work use.'
      });
    }
  }
  for (const e of findings.coveredExpenses || []) {
    decisions.push({ id: `covered:${e.id}`, item: e.description, decision: 'covered', method: 'fixed_rate',
      reason: 'The 70c-per-hour rate already includes energy, internet and phone costs.', rule: 'ATO fixed rate method (PCG 2023/1)', refs: e.refs });
  }
  return { decisions, questions };
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
  const unknown = docs.filter((d) => d.kind === 'other');
  if (unknown.length) flags.push({ severity: 'info', code: 'UNRECOGNISED_DOC', message: `${unknown.length} document(s) could not be recognised and were not used: ${unknown.map((d) => d.docName).join(', ')}.` });

  const serious = flags.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  const riskScore = Math.min(100, flags.reduce((s, f) => s + ({ high: 35, medium: 15, info: 0 }[f.severity] || 0), 5));
  const steps = [
    `Checked ${docs.length} document(s) and ${(facts.assets || []).length + (facts.wfhHours ? 1 : 0) + (facts.salary ? 1 : 0)} figure(s) against the ATO record-keeping and claim rules.`,
    ...flags.map((f) => `${{ high: 'Action needed', medium: 'Please check', info: 'Note' }[f.severity]}: ${f.message}`),
    `Audit risk score: ${riskScore} out of 100.`
  ];
  return { flags, riskScore, steps, summary: serious ? `${serious} item(s) need attention.` : 'No compliance issues found.' };
}

/**
 * The Coordinator (FR-015): runs the agents in order - triage first, then the
 * specialists on the documents routed to them, then compliance on everything -
 * and merges their answers into one "facts" object for the tax engine.
 */
export function runLocalSwarm(items, rules, ocrWarnings = []) {
  const docs = groupByDoc(items);
  const reports = [];
  const time = (name, fn) => {
    const t0 = Date.now();
    const out = fn();
    reports.push({ key: name, agent: AGENT_NAMES[name], engine: 'Local rules (on device)', summary: out.summary, steps: out.steps || [], ms: Date.now() - t0 });
    return out;
  };
  const triage = time('triage', () => triageAgent(docs));
  const routedFor = (key) => docs.filter((d) => (ROUTES[d.kind] || []).includes(key));
  const employment = time('employment', () => employmentAgent(routedFor('employment')));
  time('investment', () => investmentAgent(routedFor('investment')));
  time('rental', () => rentalAgent(routedFor('rental')));
  const deduction = time('deduction', () => deductionAgent(routedFor('deduction')));
  const { decisions, questions, ...deductionFacts } = deduction.findings;
  const facts = { ...employment.findings, ...deductionFacts };
  const compliance = time('compliance', () => complianceAgent(facts, docs, rules, ocrWarnings));
  return {
    facts,
    flags: compliance.flags,
    riskScore: compliance.riskScore,
    documents: triage.findings.documents,
    decisions,
    questions,
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
