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
 */
export function reconcile(local, cloud, items) {
  if (!cloud?.agents) {
    return { ...local, facts: tagOrigin(local.facts, 'On-device rules'), mode: 'sovereign' };
  }
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const flags = [...local.flags];
  const facts = {};
  const ai = { ...(cloud.agents.employment || {}), ...(cloud.agents.deduction || {}) };

  // Single-value facts: salary, tax withheld, WFH hours
  for (const key of ['salary', 'taxWithheld', 'wfhHours']) {
    const mine = local.facts[key];
    const theirs = ai[key];
    const theirsOk = theirs && (theirs.computedBy === 'code' || isGrounded(theirs.value, theirs.refs, itemsById));
    if (theirs && !theirsOk) {
      flags.push({ severity: 'medium', code: 'AI_UNVERIFIED', message: `The AI suggested ${label(key)} = ${theirs.value}, but that number is not in the document it cited, so it was ignored (hallucination guard).` });
    }
    if (theirsOk && mine && Math.abs(Number(theirs.value) - Number(mine.value)) > 0.005) {
      flags.push({ severity: 'medium', code: 'AGENTS_DISAGREE', message: `Agents disagree on ${label(key)}: on-device rules found ${mine.value}, cloud AI found ${theirs.value}. The on-device value is used - please check.`, refs: [...(mine.refs || []), ...(theirs.refs || [])].slice(0, 4) });
      facts[key] = { ...mine, origin: 'On-device rules (AI disagreed)' };
    } else if (theirsOk) {
      facts[key] = { value: Number(theirs.value), refs: theirs.refs, origin: mine ? 'AI + on-device rules agree' : 'Cloud AI (verified against source)' };
    } else if (mine) {
      facts[key] = { ...mine, origin: 'On-device rules' };
    }
  }

  // Assets: keep the on-device list, use the AI to improve the asset type, add grounded AI-only assets
  facts.assets = (local.facts.assets || []).map((asset) => {
    const match = (ai.assets || []).find((a) => Math.abs(Number(a.cost) - asset.cost) < 0.005);
    const betterType = asset.assetType === 'other' && match?.assetType ? match.assetType : asset.assetType;
    return { ...asset, assetType: betterType, origin: match ? 'AI + on-device rules agree' : 'On-device rules' };
  });
  for (const a of ai.assets || []) {
    const known = facts.assets.some((x) => Math.abs(x.cost - Number(a.cost)) < 0.005);
    if (!known && isGrounded(a.cost, a.refs, itemsById)) {
      facts.assets.push({ id: `ai-${facts.assets.length + 1}`, description: a.description, assetType: a.assetType || 'other', cost: Number(a.cost), purchaseDate: a.purchaseDate || null, workUsePercent: a.workUsePercent ?? 100, refs: a.refs, origin: 'Cloud AI (verified against source)' });
    }
  }
  facts.coveredExpenses = (local.facts.coveredExpenses || []).map((e) => ({ ...e, origin: 'On-device rules' }));

  // Extra advice from the AI Compliance agent (shown separately, never changes numbers)
  const aiNotes = (cloud.agents.compliance?.flags || []).slice(0, 5).map((f) => ({
    severity: ['high', 'medium', 'info'].includes(f.severity) ? f.severity : 'info',
    code: 'AI_NOTE', message: String(f.message || '').slice(0, 300), refs: (f.refs || []).filter((r) => itemsById.has(r)), fromAi: true
  }));

  return {
    ...local,
    facts,
    flags,
    aiNotes,
    reports: cloud.reports?.length ? cloud.reports : local.reports,
    mode: 'dual-engine'
  };
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
