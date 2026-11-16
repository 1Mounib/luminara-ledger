/**
 * TaxMate - COORDINATOR / RECONCILIATION (FR-015)
 * -------------------------------------------------------
 * Combines the on-device agents with the cloud AI agents, and checks the AI.
 *
 * Hallucination guard: an AI answer is only accepted if the number it gives
 * actually appears in the document line it cites. Otherwise it is rejected
 * and flagged. If the AI and the on-device rules disagree, the deterministic
 * value is kept and the accountant is asked to check.
 */

/** Does this number appear in any of the cited lines? ("98500" matches "$98,500.00") */
export function isGrounded(value, refs, itemsById) {
  if (value == null || !Array.isArray(refs) || !refs.length) return false;
  const target = Number(value);
  return refs.some((ref) => {
    const item = itemsById.get(ref);
    if (!item) return false;
    const numbers = [...String(item.text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
    return numbers.some((n) => Math.abs(n - target) < 0.005);
  });
}

/**
 * @param {object} local  result of runLocalSwarm()
 * @param {object|null} cloud  response from /api/agents ({ agents, reports }) or null
 * @param {object[]} items  the masked items that were analysed
 * @param {object|null} triage  response from the cloud triage stage ({ documents, report }) or null
 */
export function reconcile(local, cloud, items, triage = null) {
  const documents = mergeTriage(local.documents || [], triage?.documents);
  if (!cloud?.agents) {
    const steps = [
      'Ran every agent on this device (no cloud AI).',
      `Passed ${countFacts(local.facts)} figure(s) to the rules engine.`,
      ...(local.questions?.length ? [`Waiting for ${local.questions.length} answer(s) from the taxpayer.`] : [])
    ];
    return {
      ...local, documents, facts: tagOrigin(local.facts, 'On-device rules'), mode: 'sovereign',
      reports: [...local.reports, coordinatorReport(steps, 'Local rules (on device)')]
    };
  }
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const flags = [...local.flags];
  const facts = {};
  const ai = { ...(cloud.agents.employment || {}), ...(cloud.agents.deduction || {}) };
  const tally = { checked: 0, grounded: 0, rejected: 0, agreed: 0, disagreed: 0 };

  // Single-value facts: salary, tax withheld, WFH hours
  for (const key of ['salary', 'taxWithheld', 'wfhHours']) {
    const mine = local.facts[key];
    const theirs = ai[key];
    const theirsOk = theirs && (theirs.computedBy === 'code' || isGrounded(theirs.value, theirs.refs, itemsById));
    if (theirs) { tally.checked += 1; tally[theirsOk ? 'grounded' : 'rejected'] += 1; }
    if (theirs && !theirsOk) {
      flags.push({ severity: 'medium', code: 'AI_UNVERIFIED', message: `The AI suggested ${label(key)} = ${theirs.value}, but that number is not in the document it cited, so it was ignored (hallucination guard).` });
    }
    if (theirsOk && mine && Math.abs(Number(theirs.value) - Number(mine.value)) > 0.005) {
      tally.disagreed += 1;
      flags.push({ severity: 'medium', code: 'AGENTS_DISAGREE', message: `Agents disagree on ${label(key)}: on-device rules found ${mine.value}, cloud AI found ${theirs.value}. The on-device value is used - please check.`, refs: [...(mine.refs || []), ...(theirs.refs || [])].slice(0, 4) });
      facts[key] = { ...mine, origin: 'On-device rules (AI disagreed)' };
    } else if (theirsOk) {
      if (mine) tally.agreed += 1;
      facts[key] = { value: Number(theirs.value), refs: theirs.refs, origin: mine ? 'AI + on-device rules agree' : 'Cloud AI (verified against source)' };
    } else if (mine) {
      facts[key] = { ...mine, origin: 'On-device rules' };
    }
  }

  // Assets: keep the on-device list, use the AI to improve the asset type, add grounded AI-only assets
  facts.assets = (local.facts.assets || []).map((asset) => {
    const match = (ai.assets || []).find((a) => Math.abs(Number(a.cost) - asset.cost) < 0.005);
    if (match) { tally.checked += 1; tally.grounded += 1; tally.agreed += 1; }
    const betterType = asset.assetType === 'other' && match?.assetType ? match.assetType : asset.assetType;
    return { ...asset, assetType: betterType, origin: match ? 'AI + on-device rules agree' : 'On-device rules' };
  });
  for (const a of ai.assets || []) {
    const known = facts.assets.some((x) => Math.abs(x.cost - Number(a.cost)) < 0.005);
    if (known) continue;
    tally.checked += 1;
    if (isGrounded(a.cost, a.refs, itemsById)) {
      tally.grounded += 1;
      facts.assets.push({ id: `ai-${facts.assets.length + 1}`, description: a.description, assetType: a.assetType || 'other', cost: Number(a.cost), purchaseDate: a.purchaseDate || null, workUsePercent: a.workUsePercent ?? 100, refs: a.refs, origin: 'Cloud AI (verified against source)' });
    } else {
      tally.rejected += 1;
    }
  }
  facts.coveredExpenses = (local.facts.coveredExpenses || []).map((e) => ({ ...e, origin: 'On-device rules' }));

  // Decisions and questions: the rules' decision stands; the AI's judgement adds its reason,
  // can ask the taxpayer a question, and raises a flag when it thinks something isn't claimable.
  const { decisions, questions, aiFlags } = mergeJudgement(local, ai, facts, itemsById);
  flags.push(...aiFlags);

  // Extra advice from the AI Compliance agent (shown separately, never changes numbers)
  const aiNotes = (cloud.agents.compliance?.flags || []).slice(0, 5).map((f) => ({
    severity: ['high', 'medium', 'info'].includes(f.severity) ? f.severity : 'info',
    code: 'AI_NOTE', message: String(f.message || '').slice(0, 300), refs: (f.refs || []).filter((r) => itemsById.has(r)), fromAi: true
  }));

  // One report per agent: the cloud AI's own account, cross-checked by the on-device version
  const order = ['triage', 'employment', 'investment', 'rental', 'deduction', 'compliance'];
  const reports = order.map((key) => {
    const mine = local.reports.find((r) => r.key === key);
    const theirs = key === 'triage' ? triage?.report : cloud.reports?.find((r) => r.key === key);
    if (!theirs || !theirs.ok) return { ...mine, note: theirs ? `Cloud AI failed (${theirs.summary}); the on-device version was used.` : null };
    return { ...theirs, steps: theirs.steps?.length ? theirs.steps : mine?.steps || [], crossCheck: mine?.summary };
  }).filter(Boolean);
  const kindAgree = documents.filter((d) => d.aiKind).length;
  reports.push(coordinatorReport([
    ...(kindAgree ? [`Compared the AI's document types with the on-device rules: ${documents.filter((d) => d.aiKind && d.aiKind === d.kind).length} of ${kindAgree} matched.`] : []),
    `Checked ${tally.checked} value(s) from the cloud AI against the lines they cite: ${tally.grounded} found, ${tally.rejected} rejected as not in the document.`,
    `The cloud AI and on-device rules agreed on ${tally.agreed} value(s)${tally.disagreed ? ` and disagreed on ${tally.disagreed} (flagged for checking)` : ''}.`,
    ...(questions.length ? [`Waiting for ${questions.length} answer(s) from the taxpayer.`] : []),
    'Passed the checked figures to the rules engine, which does all the maths.'
  ], 'Coordinator (on device)'));

  return {
    ...local,
    documents,
    facts,
    flags,
    aiNotes,
    decisions,
    questions,
    reports,
    tally,
    mode: 'dual-engine'
  };
}

/** Adds the cloud triage verdict (kind, confidence, reason) to each document. */
function mergeTriage(localDocs, aiDocs) {
  if (!aiDocs?.length) return localDocs;
  return localDocs.map((d) => {
    const a = aiDocs.find((x) => x.docId === d.docId);
    return a ? { ...d, aiKind: a.kind, aiReason: a.reason, confidence: a.confidence } : d;
  });
}

function mergeJudgement(local, ai, facts, itemsById) {
  const decisions = (local.decisions || []).map((d) => ({ ...d, origin: 'On-device rules' }));
  const questions = [...(local.questions || [])];
  const aiFlags = [];
  const amountOf = (d) => {
    if (d.id === 'wfh') return null;
    const asset = facts.assets.find((a) => `asset:${a.id}` === d.id);
    if (asset) return asset.cost;
    return facts.coveredExpenses.find((e) => `covered:${e.id}` === d.id)?.amount ?? null;
  };
  for (const a of ai.decisions || []) {
    const amount = Number(a.amount);
    const target = decisions.find((d) => (a.amount == null ? d.id === 'wfh' && /hour|home|timesheet/i.test(a.item || '') : amountOf(d) != null && Math.abs(amountOf(d) - amount) < 0.005));
    if (!target) continue;
    target.aiDecision = a.decision;
    target.aiReason = String(a.reason || '').slice(0, 240);
    target.origin = a.decision === target.decision ? 'AI + on-device rules agree' : 'On-device rules (AI saw it differently)';
    const asset = facts.assets.find((x) => `asset:${x.id}` === target.id);
    if (a.decision === 'not_claimable' && target.decision !== 'not_claimable') {
      aiFlags.push({ severity: 'medium', code: 'AI_DOUBTS_CLAIM', message: `The AI thinks "${target.item}" may not be claimable: ${target.aiReason || 'no reason given'}. Please check before it is claimed.`, refs: target.refs });
    }
    if (a.decision === 'ask' && asset && !questions.some((q) => q.assetId === asset.id)) {
      questions.push({ id: `q-${asset.id}`, assetId: asset.id, agent: 'deduction', refs: asset.refs, fromAi: true,
        text: `Do you use the ${asset.description.toLowerCase()} only for work?`, why: target.aiReason || 'Only the work-use share can be claimed.' });
    }
  }
  // Questions the AI wrote itself, for items it can tie to a grounded asset
  for (const q of ai.questions || []) {
    const asset = facts.assets.find((x) => Math.abs(x.cost - Number(q.amount)) < 0.005);
    if (!asset || questions.some((x) => x.assetId === asset.id) || !isGrounded(asset.cost, asset.refs, itemsById)) continue;
    questions.push({ id: `q-${asset.id}`, assetId: asset.id, agent: 'deduction', refs: asset.refs, fromAi: true, text: String(q.text || '').slice(0, 200), why: 'Only the work-use share can be claimed.' });
  }
  return { decisions, questions, aiFlags };
}

function coordinatorReport(steps, engine) {
  return { key: 'coordinator', agent: 'Coordinator', engine, ms: 0, summary: 'Checked every agent\'s answer before anything was calculated.', steps };
}

function countFacts(facts) {
  return ['salary', 'taxWithheld', 'wfhHours'].filter((k) => facts[k]).length + (facts.assets || []).length;
}

function tagOrigin(facts, origin) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) {
    if (Array.isArray(v)) out[k] = v.map((x) => ({ ...x, origin }));
    else out[k] = v ? { ...v, origin } : v;
  }
  return out;
}

function label(key) {
  return { salary: 'salary', taxWithheld: 'tax withheld', wfhHours: 'work-from-home hours' }[key] || key;
}
