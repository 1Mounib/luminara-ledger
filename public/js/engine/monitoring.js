/**
 * TaxMate - AI MONITORING
 * -------------------------------------------------------
 * Turns each analysis and review into small "run" rows (numbers only, never
 * document text) and summarises them for the Admin page: how often each
 * agent succeeds, how often the app had to fall back to the on-device
 * version, how fast it is, and how often the coordinator rejected or
 * disagreed with the AI.
 */

const isCloudEngine = (engine) => /cloud/i.test(engine || '');

/** One row per agent plus one for the coordinator, from a finished analysis. */
export function analysisRuns(analysis, { returnId = null, cloudRequested = false } = {}) {
  const versions = analysis.promptVersions || {};
  const rows = [];
  for (const r of analysis.reports || []) {
    if (r.key === 'coordinator' || r.skipped) continue;
    const fallback = cloudRequested && (Boolean(r.note) || !isCloudEngine(r.engine));
    rows.push({
      return_id: returnId, agent: r.key, engine: isCloudEngine(r.engine) ? 'cloud' : 'device',
      ms: Math.round(r.ms || 0), ok: !r.note, fallback, steps: (r.steps || []).length,
      prompt_version: isCloudEngine(r.engine) ? versions[r.key] ?? null : null
    });
  }
  const t = analysis.tally;
  rows.push({
    return_id: returnId, agent: 'coordinator', engine: 'device', ms: 0, ok: true, fallback: cloudRequested && analysis.mode !== 'dual-engine',
    steps: (analysis.reports || []).find((r) => r.key === 'coordinator')?.steps?.length || 0,
    grounded: t?.grounded ?? null, rejected: t?.rejected ?? null, agreed: t?.agreed ?? null, disagreed: t?.disagreed ?? null, prompt_version: null
  });
  return rows;
}

/** One row for an accountant's review-agent run. */
export function reviewRun(out, { returnId = null, cloudRequested = false, cloudUsed = false, ms = 0 } = {}) {
  return {
    return_id: returnId, agent: 'review', engine: cloudUsed ? 'cloud' : 'device', ms: Math.round(out?.ms ?? ms),
    ok: Boolean(out?.review), fallback: cloudRequested && !cloudUsed, steps: (out?.trace || []).length, prompt_version: out?.promptVersion ?? null
  };
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

/** Per-agent numbers for the dashboard. */
export function summariseRuns(runs) {
  const byAgent = new Map();
  for (const r of runs) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
    byAgent.get(r.agent).push(r);
  }
  const agents = [...byAgent.entries()].filter(([agent]) => agent !== 'coordinator').map(([agent, rs]) => {
    const cloud = rs.filter((r) => r.engine === 'cloud');
    const times = cloud.map((r) => r.ms || 0).sort((a, b) => a - b);
    return {
      agent, runs: rs.length, cloudRuns: cloud.length,
      successRate: pct(rs.filter((r) => r.ok).length, rs.length),
      fallbackRate: pct(rs.filter((r) => r.fallback).length, rs.length),
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      p95Ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : null,
      avgSteps: rs.length ? Math.round((rs.reduce((a, r) => a + (r.steps || 0), 0) / rs.length) * 10) / 10 : 0,
      versions: [...new Set(cloud.map((r) => r.prompt_version).filter((v) => v != null))],
      last: rs.map((r) => r.at).filter(Boolean).sort().at(-1) || null
    };
  });
  const coord = byAgent.get('coordinator') || [];
  const sum = (k) => coord.reduce((a, r) => a + (r[k] || 0), 0);
  const grounded = sum('grounded'); const rejected = sum('rejected'); const agreed = sum('agreed'); const disagreed = sum('disagreed');
  return {
    analyses: coord.length,
    agents,
    coordinator: {
      checked: grounded + rejected, grounded, rejected, agreed, disagreed,
      groundedRate: pct(grounded, grounded + rejected),
      agreementRate: pct(agreed, agreed + disagreed),
      fallbackRate: pct(coord.filter((r) => r.fallback).length, coord.length)
    }
  };
}
