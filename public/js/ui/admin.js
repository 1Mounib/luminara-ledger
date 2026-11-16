/**
 * Admin settings page (admin role only):
 *   - Agent instructions: edit each agent's prompt, with version history
 *   - Connectors: which tools each agent may use
 *   - AI performance: success, fallback, speed and checking rates
 *   - MCP address: TaxMate's tools for outside AI apps
 * In cloud mode the changes go to Supabase, where the security rules only
 * let an admin change them. In the demo they stay in this browser.
 */
import { requireRole, renderHeader, isCloud, getPromptHistory, savePrompt, getAiSettings, saveAiSetting, listAiRuns, getLedger, html, raw, escapeHtml, toast, $, $$ } from './common.js';
import { AGENT_NAMES } from '../engine/localAgents.js';
import { CONNECTORS, DEFAULT_CONNECTOR_SETTINGS, enabledConnectors } from '../engine/connectors.js';
import { summariseRuns } from '../engine/monitoring.js';

requireRole('admin');
renderHeader('admin');
const ledger = getLedger();

const NAMES = { ...AGENT_NAMES, review: 'Review Agent', copilot: 'Copilot', coordinator: 'Coordinator' };
const GROUPS = [
  { key: 'review', label: 'Review Agent' },
  { key: 'copilot', label: 'Copilot' },
  { key: 'taxpayer', label: 'Taxpayer page' },
  { key: 'mcp', label: 'MCP address' }
];

const state = { config: null, history: [], settings: {}, agent: 'triage', runs: [] };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// ------------------------------------------------------------ tabs
function showTab(name) {
  $$('.admin-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'performance') renderPerformance();
  history.replaceState(null, '', `#${name}`);
}
$$('.admin-tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------ load
async function load() {
  const [config, history, settings] = await Promise.all([
    fetch('/api/config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))),
    getPromptHistory().catch((e) => { toast(`Could not read the saved instructions: ${e.message}`, 'error'); return []; }),
    getAiSettings().catch(() => ({}))
  ]);
  Object.assign(state, { config, history, settings });
  renderStatus();
  renderAgentList();
  renderEditor();
  renderConnectors();
  renderMcp();
}

function renderStatus() {
  const live = state.config.live;
  const where = isCloud()
    ? (live.source === 'database'
      ? 'The live AI agents are reading these settings from the database.'
      : 'The live AI agents can\'t see the admin tables yet, so they use the defaults. Run supabase/admin.sql in Supabase to connect them.')
    : 'Demo mode: changes are saved in this browser only. Sign in with an admin account to change the live agents.';
  $('#adminStatus').innerHTML = html`<span class="dot ${isCloud() && live.source === 'database' ? 'ok' : 'warn'}"></span> ${where}`;
}

// ------------------------------------------------------------ prompts
const versionsOf = (agent) => state.history.filter((h) => h.agent === agent);
const currentText = (agent) => versionsOf(agent)[0]?.instructions ?? state.config.prompts[agent].instructions;

function renderAgentList() {
  $('#agentList').innerHTML = Object.entries(state.config.prompts).map(([key, p]) => {
    const v = versionsOf(key)[0];
    return html`<button type="button" data-agent="${key}" class="${key === state.agent ? 'on' : ''}">
      <b>${p.name}</b><small>${v ? `Version ${v.id}, edited ${when(v.created_at)}` : 'Default instructions'}</small></button>`;
  }).join('');
  $$('#agentList button').forEach((b) => b.addEventListener('click', () => { state.agent = b.dataset.agent; renderAgentList(); renderEditor(); }));
}

function renderEditor() {
  const key = state.agent;
  const p = state.config.prompts[key];
  const versions = versionsOf(key);
  const live = state.config.live.versions?.[key];
  $('#promptEditor').innerHTML = html`
    <h3>${p.name}</h3>
    <p class="muted small">${versions[0] ? raw(`Using <b>version ${versions[0].id}</b> by ${escapeHtml(versions[0].created_by_name || 'admin')}${live && isCloud() ? (live === versions[0].id ? ' (live now)' : ' (live within 30 seconds)') : ''}.`) : 'Using the default instructions written in the code.'}</p>
    <label class="field-label" for="promptText">Instructions</label>
    <textarea id="promptText" rows="10" spellcheck="true" maxlength="8000"></textarea>
    <p class="char-count" id="charCount"></p>
    <details class="fixed-format">
      <summary>Reply format (fixed in the code)</summary>
      <pre>${p.format.trim()}</pre>
    </details>
    <label class="field-label" for="promptNote">What did you change and why? <span class="muted">(kept with the version)</span></label>
    <input id="promptNote" type="text" maxlength="200" placeholder="e.g. Ask for the timesheet when hours look high">
    <div class="admin-actions">
      <button class="btn primary" id="savePrompt">Save as a new version</button>
      <button class="btn ghost" id="resetPrompt" ${versions.length ? '' : 'disabled'}>Go back to the default</button>
    </div>
    <h4>Version history</h4>
    ${versions.length ? raw(`<ol class="versions">${versions.map((v, i) => html`<li>
      <div><b>Version ${v.id}</b>${i === 0 ? raw(' <span class="pill approved">current</span>') : ''} <span class="muted">${when(v.created_at)} by ${v.created_by_name || 'admin'}</span>
      ${v.note ? raw(`<small>${escapeHtml(v.note)}</small>`) : ''}</div>
      <div class="v-actions"><button class="btn small ghost" data-view="${v.id}">View</button>${i ? raw(`<button class="btn small" data-restore="${v.id}">Restore</button>`) : ''}</div>
    </li>`).join('')}</ol>`) : raw('<p class="muted small">No changes yet: the agent uses the default instructions.</p>')}
    <pre class="version-view" id="versionView" hidden></pre>`;

  const text = $('#promptText');
  text.value = currentText(key);
  const count = () => { $('#charCount').textContent = `${text.value.trim().length.toLocaleString()} / 8,000 characters`; };
  text.addEventListener('input', count);
  count();

  $('#savePrompt').addEventListener('click', () => save(text.value, $('#promptNote').value.trim()));
  $('#resetPrompt').addEventListener('click', () => save(p.instructions, 'Back to the default instructions'));
  $$('[data-restore]').forEach((b) => b.addEventListener('click', () => {
    const v = versions.find((x) => String(x.id) === b.dataset.restore);
    save(v.instructions, `Restored version ${v.id}`);
  }));
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
    const v = versions.find((x) => String(x.id) === b.dataset.view);
    const box = $('#versionView');
    box.hidden = false;
    box.textContent = `Version ${v.id}:\n\n${v.instructions}`;
  }));
}

async function save(text, note) {
  const key = state.agent;
  const clean = text.trim();
  if (clean.length < 20) return toast('The instructions are too short (at least 20 characters).', 'warn');
  if (clean === currentText(key).trim()) return toast('Nothing has changed.', 'info');
  try {
    const row = await savePrompt(key, clean, note);
    state.history = [row, ...state.history];
    await ledger.append({ action: 'agent instructions changed', field: key, to: `version ${row.id}`, justification: note || null }).catch(() => {});
    toast(`${state.config.prompts[key].name}: version ${row.id} saved.${isCloud() ? ' The live agent uses it within 30 seconds.' : ''}`, 'ok');
    renderAgentList();
    renderEditor();
  } catch (error) {
    toast(`Not saved: ${error.message}`, 'error');
  }
}

// ------------------------------------------------------------ connectors
function renderConnectors() {
  const on = (group, id) => enabledConnectors(state.settings, group).includes(id);
  $('#connectorTable').innerHTML = html`
    <thead><tr><th>Connector</th><th>What it does</th>${raw(GROUPS.map((g) => `<th class="c">${g.label}</th>`).join(''))}</tr></thead>
    <tbody>${raw(CONNECTORS.map((c) => html`<tr>
      <td><b>${c.name}</b><small><code>${c.id}</code> · ${c.kind === 'source' ? 'data source' : 'tool'}${c.mcp ? '' : ' · uses personal data, never offered by MCP'}</small></td>
      <td>${c.description}</td>
      ${raw(GROUPS.map((g) => (c.agents.includes(g.key)
        ? `<td class="c"><input type="checkbox" data-group="${g.key}" data-id="${c.id}" ${on(g.key, c.id) ? 'checked' : ''} aria-label="${escapeHtml(`${c.name} for ${g.label}`)}"></td>`
        : '<td class="c muted" aria-label="not available">-</td>')).join(''))}
    </tr>`).join(''))}</tbody>`;
}

async function saveConnectors(value) {
  try {
    await saveAiSetting('connectors', value);
    state.settings = { ...state.settings, connectors: value };
    await ledger.append({ action: 'connectors changed', to: Object.entries(value).map(([g, ids]) => `${g}: ${ids.join(', ') || 'none'}`).join('; ') }).catch(() => {});
    renderConnectors();
    renderMcp();
    toast(`Connectors saved.${isCloud() ? ' The live agents use them within 30 seconds.' : ''}`, 'ok');
  } catch (error) {
    toast(`Not saved: ${error.message}`, 'error');
  }
}
$('#saveConnectors').addEventListener('click', () => {
  const value = Object.fromEntries(GROUPS.map((g) => [g.key, $$(`#connectorTable input[data-group="${g.key}"]:checked`).map((i) => i.dataset.id)]));
  saveConnectors(value);
});
$('#resetConnectors').addEventListener('click', () => saveConnectors(structuredClone(DEFAULT_CONNECTOR_SETTINGS)));

// ------------------------------------------------------------ AI performance
const fmtMs = (ms) => (ms == null ? '-' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const fmtPct = (n) => (n == null ? '-' : `${n}%`);

async function renderPerformance() {
  const box = $('#perf');
  box.innerHTML = '<p class="muted">Loading...</p>';
  try {
    state.runs = await listAiRuns();
  } catch (error) {
    box.innerHTML = html`<p class="form-msg err">Could not read the AI runs: ${error.message}</p>`;
    return;
  }
  const days = Number($('#perfRange').value);
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const runs = state.runs.filter((r) => !since || new Date(r.at).getTime() >= since);
  if (!runs.length) {
    box.innerHTML = '<p class="empty">No AI runs recorded yet. Work out an estimate as a taxpayer, or run the review agent as an accountant, and the numbers appear here.</p>';
    return;
  }
  const s = summariseRuns(runs);
  const c = s.coordinator;
  const maxAvg = Math.max(1, ...s.agents.map((a) => a.avgMs || 0));
  const order = ['triage', 'employment', 'investment', 'rental', 'deduction', 'compliance', 'review'];
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : 99);
  const agents = [...s.agents].sort((a, b) => rank(a.agent) - rank(b.agent));
  box.innerHTML = html`
    <div class="kpis">
      <div class="kpi"><span>Analyses</span><b>${s.analyses}</b><small>tax estimates worked out</small></div>
      <div class="kpi"><span>AI values backed by the document</span><b>${fmtPct(c.groundedRate)}</b><small>${c.grounded} of ${c.checked} checked by the coordinator</small></div>
      <div class="kpi"><span>Cloud AI and on-device rules agree</span><b>${fmtPct(c.agreementRate)}</b><small>${c.agreed} agreed, ${c.disagreed} flagged</small></div>
      <div class="kpi ${c.fallbackRate > 20 ? 'bad' : ''}"><span>Analyses that fell back to on-device</span><b>${fmtPct(c.fallbackRate)}</b><small>cloud AI unavailable or failed</small></div>
    </div>
    <h4>By agent</h4>
    <div class="table-scroll"><table class="admin-table perf-table">
      <thead><tr><th>Agent</th><th class="n">Runs</th><th class="n">On cloud AI</th><th class="n">Succeeded</th><th class="n">Fell back</th><th>Average cloud time</th><th class="n">Slowest 5%</th><th class="n">Avg steps</th><th>Instruction versions</th><th>Last run</th></tr></thead>
      <tbody>${raw(agents.map((a) => html`<tr>
        <td><b>${NAMES[a.agent] || a.agent}</b></td>
        <td class="n">${a.runs}</td><td class="n">${a.cloudRuns}</td>
        <td class="n ${a.successRate < 90 ? 'bad' : ''}">${fmtPct(a.successRate)}</td>
        <td class="n ${a.fallbackRate > 20 ? 'bad' : ''}">${fmtPct(a.fallbackRate)}</td>
        <td><span class="bar"><i style="width:${a.avgMs ? Math.max(3, Math.round((a.avgMs / maxAvg) * 100)) : 0}%"></i></span> ${fmtMs(a.avgMs)}</td>
        <td class="n">${fmtMs(a.p95Ms)}</td><td class="n">${a.avgSteps}</td>
        <td>${a.versions.length ? a.versions.map((v) => `v${v}`).join(', ') : 'default'}</td>
        <td>${when(a.last)}</td>
      </tr>`).join(''))}</tbody>
    </table></div>
    <h4>Latest runs</h4>
    <div class="table-scroll"><table class="admin-table">
      <thead><tr><th>When</th><th>Agent</th><th>Engine</th><th class="n">Time</th><th>Result</th><th>Return</th></tr></thead>
      <tbody>${raw(runs.slice(0, 25).map((r) => html`<tr>
        <td>${when(r.at)}</td><td>${NAMES[r.agent] || r.agent}${r.prompt_version ? ` (v${r.prompt_version})` : ''}</td>
        <td>${r.engine === 'cloud' ? 'Cloud AI' : 'On device'}</td><td class="n">${r.engine === 'cloud' ? fmtMs(r.ms) : '-'}</td>
        <td>${r.agent === 'coordinator' && r.grounded != null ? `${r.grounded} backed, ${r.rejected} rejected, ${r.disagreed} flagged` : !r.ok ? 'Failed' : r.fallback ? 'Fell back to on-device' : 'OK'}</td>
        <td><code>${r.return_id || ''}</code></td>
      </tr>`).join(''))}</tbody>
    </table></div>`;
}
$('#perfRefresh').addEventListener('click', renderPerformance);
$('#perfRange').addEventListener('change', renderPerformance);

// ------------------------------------------------------------ MCP
function renderMcp() {
  const url = `${location.origin}${state.config.mcp.path}`;
  const tools = enabledConnectors(state.settings, 'mcp').map((id) => CONNECTORS.find((c) => c.id === id));
  const clientConfig = JSON.stringify({ mcpServers: { taxmate: { type: 'http', url, headers: { Authorization: 'Bearer <MCP_TOKEN>' } } } }, null, 2);
  $('#mcpInfo').innerHTML = html`
    <p class="hint">MCP (Model Context Protocol) is a standard way for AI apps to plug into tools. TaxMate's own connectors are offered at this address, so another AI assistant can use TaxMate's rules engine and ATO rules library. Only tools that need no personal data are offered.</p>
    <div class="mcp-address"><span>Address</span><code id="mcpUrl">${url}</code><button class="btn small" id="copyMcp">Copy</button></div>
    <p class="admin-status"><span class="dot ${state.config.mcp.enabled ? 'ok' : 'warn'}"></span> ${state.config.mcp.enabled ? 'Switched on: the address answers clients that send the access token.' : 'Switched off: no access token is set yet.'}</p>
    <h4>Tools offered now</h4>
    ${tools.length ? raw(`<ul class="mcp-tools">${tools.map((c) => html`<li><b>${c.id === 'recalculate' ? 'calculate_tax' : c.id}</b> - ${c.description}</li>`).join('')}</ul>`) : raw('<p class="muted">None: switch tools on in the Connectors tab.</p>')}
    <h4>Turning it on</h4>
    <ol class="steps-list">
      <li>In Vercel, open the project's <b>Settings → Environment Variables</b>.</li>
      <li>Add <code>MCP_TOKEN</code> with a long random value, marked <b>Sensitive</b>, then redeploy.</li>
      <li>Give the token only to the AI app that should connect. To cut it off, change or delete the token.</li>
    </ol>
    <h4>Connecting an AI app</h4>
    <p class="muted small">Most MCP clients take a setting like this (replace the token):</p>
    <pre class="code-block">${clientConfig}</pre>`;
  $('#copyMcp').addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast('Address copied.', 'ok')).catch(() => {}));
}

// ------------------------------------------------------------ start
try {
  await load();
  const tab = location.hash.slice(1);
  if (['prompts', 'connectors', 'performance', 'mcp'].includes(tab)) showTab(tab);
} catch (error) {
  $('#adminStatus').textContent = `Could not load the admin settings: ${error.message}`;
}
