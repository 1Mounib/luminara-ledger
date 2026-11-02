/**
 * Converts the agents' findings (each value + where it came from) into the
 * simple numbers the tax engine needs. Kept separate so the accountant's
 * overrides can be applied in one place before re-calculating.
 */
export function toEngineInput(facts = {}) {
  return {
    salary: facts.salary?.value ?? 0,
    taxWithheld: facts.taxWithheld?.value ?? 0,
    wfhHours: facts.wfhHours?.value ?? 0,
    assets: (facts.assets || []).map((a) => ({ ...a, sourceRefs: a.refs || [] })),
    coveredExpenses: (facts.coveredExpenses || []).map((e) => ({ ...e, sourceRefs: e.refs || [] })),
    sourceRefs: {
      salary: facts.salary?.refs || [],
      taxWithheld: facts.taxWithheld?.refs || [],
      wfhHours: facts.wfhHours?.refs || []
    }
  };
}

/**
 * The editable fields an accountant can override (NFR-011).
 * Each has a path into the facts object, a label and a type.
 */
export function editableFields(facts = {}) {
  const fields = [
    { path: 'salary.value', label: 'Salary and wages ($)', value: facts.salary?.value ?? 0, refs: facts.salary?.refs || [] },
    { path: 'taxWithheld.value', label: 'Tax withheld ($)', value: facts.taxWithheld?.value ?? 0, refs: facts.taxWithheld?.refs || [] },
    { path: 'wfhHours.value', label: 'Work-from-home hours', value: facts.wfhHours?.value ?? 0, refs: facts.wfhHours?.refs || [] }
  ];
  (facts.assets || []).forEach((a, i) => {
    fields.push({ path: `assets.${i}.cost`, label: `${a.description}: cost ($)`, value: a.cost, refs: a.refs || [] });
    fields.push({ path: `assets.${i}.purchaseDate`, label: `${a.description}: purchase date`, value: a.purchaseDate, refs: a.refs || [], type: 'date' });
    fields.push({ path: `assets.${i}.workUsePercent`, label: `${a.description}: work use (%)`, value: a.workUsePercent ?? 100, refs: a.refs || [] });
  });
  return fields;
}

/** Sets a value at a path like "assets.0.cost", creating objects on the way if needed. */
export function setPath(obj, path, value) {
  const parts = path.split('.');
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (target[key] == null) target[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    target = target[key];
  }
  target[parts[parts.length - 1]] = value;
  return obj;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
