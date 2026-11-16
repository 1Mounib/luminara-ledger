/**
 * Shared view: "What the agents did" - each agent's job, the steps it took,
 * which engine ran it and how long it took. Used on both portals.
 */
import { escapeHtml } from './common.js';

export /** "What the agents did": each agent's job, its steps and how long it took. */
function activityHtml(a, { open = true } = {}) {
  const ROLE = {
    triage: 'Works out what each document is and sends it to the right agent.',
    employment: 'Finds salary and tax withheld.',
    investment: 'Looks for dividends and interest (reported only in this release).',
    rental: 'Looks for rental property statements (reported only in this release).',
    deduction: 'Finds work-from-home hours, equipment and bills, and decides how each can be claimed.',
    compliance: 'Looks for anything the ATO would question and scores the audit risk.',
    coordinator: 'Checks every agent\'s answer against the documents before the rules engine does the maths.'
  };
  const cards = (a.reports || []).map((r) => `<li class="agent-card">
      <header><b>${escapeHtml(r.agent)}</b><small>${escapeHtml(r.engine || '')}${r.ms ? `, ${(r.ms / 1000).toFixed(1)} s` : ''}</small></header>
      <p class="role">${escapeHtml(ROLE[r.key] || '')}</p>
      ${r.steps?.length ? `<ol>${r.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : `<p>${escapeHtml(r.summary || '')}</p>`}
      ${r.crossCheck ? `<small class="cross">Cross-checked by the on-device version: ${escapeHtml(r.crossCheck)}</small>` : ''}
      ${r.note ? `<small class="cross">${escapeHtml(r.note)}</small>` : ''}
    </li>`).join('');
  return `<details class="agents-box"${open ? ' open' : ''}>
    <summary>What the agents did (${(a.reports || []).filter((r) => r.key !== 'coordinator').length} agents and a coordinator, ${a.mode === 'dual-engine' ? 'cloud AI checked by on-device rules' : 'all on this device'})</summary>
    <ol class="agent-cards">${cards}</ol>
  </details>`;
}

