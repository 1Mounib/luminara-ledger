/**
 * Accountant workspace (Capstone 1: FR-020 queue, FR-021 side-by-side
 * verification, NFR-011 overrides with justification, audit ledger).
 * Nothing is "lodged" until the accountant approves (Human Control Always).
 */
import { requireRole, renderHeader, listReturns, getReturn, saveReturn, getLedger, isCloud, money, html, raw, escapeHtml, toast, $, $$ } from './common.js';
import { editableFields, setPath, getPath, toEngineInput } from '../engine/facts.js';
import { calculateReturn } from '../engine/taxEngine.js';
import { complianceAgent } from '../engine/localAgents.js';
import { createMaskingSession } from '../engine/redact.js';
import { renderDocument } from './viewer.js';
import { ingestFile, analyse, loadRules, sampleFiles, UC1_SAMPLES } from './pipeline.js';

const user = requireRole('accountant');
renderHeader(location.hash === '#audit' ? 'audit' : 'accountant');
const ledger = getLedger();
let selectedId = null;
let viewerDoc = null;

window.addEventListener('hashchange', route);
route();

function route() {
  const audit = location.hash === '#audit';
  $('#queueView').hidden = audit;
  $('#auditView').hidden = !audit;
  $$('.topbar nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href').endsWith('#audit') === audit));
  audit ? renderAudit() : renderQueue();
}

// ------------------------------------------------------------ queue
async function renderQueue() {
  let returns = [];
  try {
    // With an account, the database only returns what an accountant is allowed to see
    returns = (await listReturns()).filter((r) => r.status !== 'draft').sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  } catch (error) {
    toast(`Could not load the client queue: ${error.message}`, 'error');
  }
  if (!selectedId && returns.length) selectedId = returns[0].id;
  $('#queue').innerHTML = returns.map((r) => html`
    <li class="${r.id === selectedId ? 'on' : ''}" data-id="${r.id}">
      <div><b>${r.owner}</b><small>FY ${r.financialYear} return</small></div>
      <div class="q-right"><span class="pill ${r.status}">${r.status}</span><span class="risk r${band(r.riskScore)}">risk ${r.riskScore ?? 0}</span></div>
    </li>`).join('') || '<li class="empty">No returns waiting for review. When a client sends their return it appears here. You can also load the demo client.</li>';
  $$('#queue li[data-id]').forEach((li) => li.addEventListener('click', () => { selectedId = li.dataset.id; viewerDoc = null; renderQueue(); }));
  renderDetail();
}

$('#demoClientBtn').addEventListener('click', async () => {
  const btn = $('#demoClientBtn');
  btn.disabled = true;
  btn.textContent = 'Processing sample documents...';
  try {
    const owner = isCloud() ? 'Alex Nguyen (demo)' : 'Alex Nguyen';
    const masking = createMaskingSession({ knownNames: ['Alex Nguyen'] });
    const docs = [], items = [], masked = [];
    const known = new Set();
    for (const file of await sampleFiles(UC1_SAMPLES)) {
      // (the sample client's name is masked as "Alex Nguyen", like a real client's would be)
      const out = await ingestFile(file, masking, known);
      if (out.duplicate) continue;
      known.add(out.doc.docId);
      docs.push({ ...out.doc, stage: 'Ready' }); items.push(...out.items); masked.push(...out.masked);
    }
    const rules = await loadRules('2025-26');
    const { analysis, result } = await analyse({ docs, masked, rules, useCloud: false });
    const id = `R-${Date.now().toString(36).toUpperCase()}`;
    const cloudDocs = docs.map((d) => ({ ...d, docName: isCloud() ? d.maskedName : d.docName }));
    await saveReturn({ id, owner, status: 'submitted', financialYear: '2025-26', docs: cloudDocs, items, masked, analysis, result, riskScore: analysis.riskScore, createdAt: new Date().toISOString() });
    await ledger.append({ action: 'loaded demo client', returnId: id }).catch(() => {});
    selectedId = id;
    renderQueue();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load demo client';
  }
});

// ------------------------------------------------------------ detail
async function renderDetail() {
  const box = $('#detail');
  let r = null;
  try { r = selectedId && (await getReturn(selectedId)); } catch (error) { toast(error.message, 'error'); }
  if (!r) { box.innerHTML = '<div class="placeholder"><p>Select a client on the left.</p></div>'; return; }
  // The accountant normally sees the MASKED lines (the real text stays on the client's device)
  r.items = r.items || r.masked;
  const t = r.result.totals;
  const fields = editableFields(r.analysis.facts);
  const locked = r.status === 'approved';
  const flags = [...r.analysis.flags].sort((a, b) => ({ high: 0, medium: 1, info: 2 }[a.severity] - { high: 0, medium: 1, info: 2 }[b.severity]));

  box.innerHTML = html`
    <div class="detail-head">
      <div><h2>${r.owner} <small>${r.id}</small></h2><p class="muted">FY ${r.financialYear} return ${r.id}, ${r.docs.length} documents, read ${r.analysis.mode === 'dual-engine' ? 'with cloud and on-device AI' : 'with on-device AI only'}</p></div>
      <div class="actions">
        <button class="btn ghost small" id="printBtn">Print audit dossier</button>
        <button class="btn ghost small" id="jsonBtn">Download summary (JSON)</button>
        <button class="btn primary" id="approveBtn" ${locked ? 'disabled' : ''}>${locked ? 'Approved and signed off' : 'Approve and sign off'}</button>
      </div>
    </div>
    <div class="flags compact">${flags.map((f) => raw(`<div class="flag ${f.severity}"><span class="sev">${{ high: 'Action needed', medium: 'Check', info: 'Note' }[f.severity]}</span><p>${escapeHtml(f.message)}</p></div>`))}</div>
    <div class="totals-strip">
      <div><small>Income</small><b>${money(t.assessableIncome)}</b></div>
      <div><small>Deductions</small><b>${money(t.totalDeductions)}</b></div>
      <div><small>Taxable income</small><b>${money(t.taxableIncome)}</b></div>
      <div><small>Net tax</small><b>${money(t.netTax)}</b></div>
      <div class="${t.refund >= 0 ? 'refund' : 'owe'}"><small>${t.refund >= 0 ? 'Refund' : 'Owing'}</small><b>${money(Math.abs(t.refund))}</b></div>
    </div>
    <div class="verify">
      <div class="verify-fields">
        <h3>Figures found in the documents <small>Point at a row to see where it came from. Change a value and choose Override to correct it.</small></h3>
        <table class="fields">
          <tbody>${fields.map((f, i) => raw(fieldRow(f, i, r, locked)))}</tbody>
        </table>
      </div>
      <div class="verify-doc">
        <div class="doc-tabs">${r.docs.map((d) => raw(`<button data-doc="${escapeHtml(d.docId)}">${escapeHtml(shortName(d.docName))}</button>`))}</div>
        <div class="doc-pane" id="docPane"></div>
      </div>
    </div>`;

  // Side-by-side: resting the mouse on a field (or clicking / tabbing to it)
  // highlights its source in the document. A short pause stops the document
  // switching back and forth while the mouse just passes over rows.
  let hoverTimer;
  $$('.fields tr', box).forEach((tr) => {
    const refs = () => (tr.dataset.refs ? tr.dataset.refs.split(',') : []);
    tr.addEventListener('mouseenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showRefs(r, refs()), 250); });
    tr.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
    tr.addEventListener('click', () => { clearTimeout(hoverTimer); showRefs(r, refs()); });
    tr.addEventListener('focusin', () => { clearTimeout(hoverTimer); showRefs(r, refs()); });
  });
  $$('.doc-tabs button', box).forEach((b) => b.addEventListener('click', () => showDoc(r, b.dataset.doc, [])));
  $$('[data-save]', box).forEach((b) => b.addEventListener('click', () => override(r, fields[Number(b.dataset.save)], b)));
  $('#approveBtn').addEventListener('click', () => approve(r));
  $('#printBtn').addEventListener('click', () => printDossier(r));
  $('#jsonBtn').addEventListener('click', () => downloadJson(r));
  showDoc(r, r.docs[0]?.docId, []);
}

function fieldRow(f, i, r, locked) {
  const origin = originForPath(r.analysis.facts, f.path);
  return `<tr data-refs="${escapeHtml((f.refs || []).join(','))}">
    <td><label for="f${i}">${escapeHtml(f.label)}</label><small class="origin">${escapeHtml(origin || '')}</small></td>
    <td><input id="f${i}" type="${f.type === 'date' ? 'date' : 'number'}" step="any" value="${escapeHtml(f.value ?? '')}" ${locked ? 'disabled' : ''}></td>
    <td>${locked ? '' : `<button class="btn ghost small" data-save="${i}">Override</button>`}</td>
  </tr>`;
}

function originForPath(facts, path) {
  const top = path.split('.').slice(0, path.startsWith('assets') ? 2 : 1).join('.');
  return getPath(facts, top)?.origin;
}

function showRefs(r, refs) {
  if (!refs.length) return;
  const first = r.items.find((i) => i.id === refs[0]);
  if (first) showDoc(r, first.docId, refs);
}

async function showDoc(r, docId, refs) {
  const key = `${docId}|${refs.join(',')}`;
  if (!docId || viewerDoc === key) return;
  viewerDoc = key;
  $$('.doc-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.doc === docId));
  const doc = r.docs.find((d) => d.docId === docId);
  await renderDocument($('#docPane'), { ...doc, items: r.items }, refs);
}

// ------------------------------------------------------------ override (NFR-011)
async function override(r, field, button) {
  const inputEl = button.closest('tr').querySelector('input');
  const newValue = field.type === 'date' ? inputEl.value : Number(inputEl.value);
  if (String(newValue) === String(field.value)) return toast('The value has not changed.', 'info');
  const justification = await askJustification(field.label, field.value, newValue);
  if (!justification) { inputEl.value = field.value; return; }

  const facts = structuredClone(r.analysis.facts);
  setPath(facts, field.path, newValue);
  const top = field.path.startsWith('assets') ? field.path.split('.').slice(0, 2).join('.') : field.path.split('.')[0];
  const target = getPath(facts, top);
  if (target && typeof target === 'object') target.origin = `Accountant override (${user.name})`;

  const rules = await loadRules(r.financialYear);
  const result = calculateReturn(toEngineInput(facts), rules);
  // Re-run the deterministic compliance checks on the corrected facts
  const docsMeta = r.docs.map((d) => ({ ...d, kind: r.analysis.documents?.find((x) => x.docId === d.docId)?.kind }));
  const recheck = complianceAgent(facts, docsMeta, rules);
  const keep = r.analysis.flags.filter((f) => ['AI_UNVERIFIED', 'AGENTS_DISAGREE', 'CLOUD_FALLBACK', 'LOW_OCR_CONFIDENCE'].includes(f.code));
  r.analysis = { ...r.analysis, facts, flags: [...recheck.flags, ...keep], riskScore: recheck.riskScore };
  r.result = result;
  r.riskScore = recheck.riskScore;
  try {
    await saveReturn(r);
  } catch (error) {
    return toast(`Could not save the override: ${error.message}`, 'error');
  }
  await ledger.append({ action: 'override', returnId: r.id, field: field.path, from: field.value, to: newValue, justification, sourceRefs: field.refs })
    .catch((error) => toast(`Saved, but the audit entry failed: ${error.message}`, 'error'));
  toast(`Override saved and recalculated. ${result.totals.refund >= 0 ? 'Refund' : 'Owing'}: ${money(Math.abs(result.totals.refund))}`, 'ok');
  viewerDoc = null;
  renderQueue();
}

function askJustification(label, from, to) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'viewer-dialog small';
    d.innerHTML = html`<form method="dialog">
      <header><div><b>Justify this override</b><small>${label}: ${from} → ${to}</small></div></header>
      <div class="viewer-body">
        <p class="muted">Every change is recorded in the audit ledger with your name, the time, the old and new values and this reason.</p>
        <textarea required minlength="10" rows="3" placeholder="e.g. Timesheet shows 20 hours of annual leave in week 12"></textarea>
        <div class="row-end"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save override</button></div>
      </div></form>`;
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', () => { const text = d.querySelector('textarea').value.trim(); resolve(d.returnValue === 'ok' && text.length >= 10 ? text : null); d.remove(); });
  });
}

async function approve(r) {
  const high = r.analysis.flags.filter((f) => f.severity === 'high');
  if (high.length && !confirm(`${high.length} item(s) still need action. Approve anyway?`)) return;
  r.status = 'approved';
  r.approvedBy = user.name;              // (with an account the database stamps this itself)
  r.approvedAt = new Date().toISOString();
  try {
    await saveReturn(r);
  } catch (error) {
    return toast(`Could not approve: ${error.message}`, 'error');
  }
  await ledger.append({ action: 'approved and signed off', returnId: r.id, to: r.result.totals.refund }).catch(() => {});
  toast('Return approved and signed off.', 'ok');
  renderQueue();
}

function downloadJson(r) {
  const summary = { returnId: r.id, taxpayer: r.owner, financialYear: r.financialYear, status: r.status, approvedBy: r.approvedBy || null, totals: r.result.totals, lines: r.result.lines, flags: r.analysis.flags, generatedAt: new Date().toISOString() };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' }));
  a.download = `${r.id}-summary.json`;
  a.click();
}

async function printDossier(r) {
  const w = window.open('', '_blank'); // open first, so the pop-up blocker allows it
  const entries = (await ledger.entries().catch(() => [])).filter((e) => e.returnId === r.id);
  w.document.write(`<!doctype html><title>Audit dossier ${escapeHtml(r.id)}</title><style>body{font:13px system-ui;margin:32px;color:#111}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:6px;text-align:left;vertical-align:top}small{color:#555}h1{margin:0}</style>
    <h1>TaxMate - audit dossier</h1><p>${escapeHtml(r.owner)}, return ${escapeHtml(r.id)}, FY ${escapeHtml(r.financialYear)}, status: ${escapeHtml(r.status)}${r.approvedBy ? ` by ${escapeHtml(r.approvedBy)}` : ''}</p>
    <h2>Calculation</h2><table><tr><th>Item</th><th>Amount</th><th>Working</th><th>Basis</th><th>Source lines</th></tr>${r.result.lines.map((l) => `<tr><td>${escapeHtml(l.label)}</td><td>${money(l.amount)}</td><td>${escapeHtml(l.formula)}</td><td>${escapeHtml(l.legalBasis)}</td><td><small>${(l.sourceRefs || []).slice(0, 4).map((id) => escapeHtml(r.items.find((i) => i.id === id)?.text || id)).join('<br>')}</small></td></tr>`).join('')}</table>
    <h2>Flags</h2><ul>${r.analysis.flags.map((f) => `<li>[${f.severity}] ${escapeHtml(f.message)}</li>`).join('')}</ul>
    <h2>Audit trail</h2><table><tr><th>#</th><th>Time</th><th>User</th><th>Action</th><th>Change</th><th>Reason</th><th>Hash</th></tr>${entries.map((e) => `<tr><td>${e.seq}</td><td>${escapeHtml(e.time)}</td><td>${escapeHtml(e.user)}</td><td>${escapeHtml(e.action)}</td><td>${e.field ? `${escapeHtml(e.field)}: ${escapeHtml(e.from)} → ${escapeHtml(e.to)}` : ''}</td><td>${escapeHtml(e.justification || '')}</td><td><small>${escapeHtml(String(e.hash || '').slice(0, 16))}...</small></td></tr>`).join('')}</table>
    <p><small>This is an estimate prepared with TaxMate for practitioner review. It is not lodged with the ATO.</small></p>`);
  w.document.close();
  w.print();
}

// ------------------------------------------------------------ audit ledger view
async function renderAudit() {
  let entries = [];
  try { entries = (await ledger.entries()).slice().reverse(); } catch (error) { toast(error.message, 'error'); }
  $('#auditRows').innerHTML = entries.map((e) => html`<tr>
      <td>${e.seq}</td><td>${new Date(e.time).toLocaleString('en-AU')}</td><td>${e.user}<small>${e.role}</small></td>
      <td>${e.action}<small>${e.returnId || ''}</small></td>
      <td>${e.field ? `${e.field}: ${e.from} → ${e.to}` : e.to != null ? String(e.to) : ''}</td>
      <td>${e.justification || ''}</td><td><code title="${e.hash || ''}">${String(e.hash || '').slice(0, 10)}…</code></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No entries yet.</td></tr>';
  const status = await ledger.verifyChain().catch((error) => ({ ok: false, error: error.message }));
  if (status.error) { $('#chainStatus').textContent = `Could not verify: ${status.error}`; return; }
  $('#chainStatus').innerHTML = status.ok
    ? `<span class="dot ok"></span> Unchanged: all ${status.total} entries check out (SHA-256 hash chain intact)`
    : `<span class="dot bad"></span> Warning: entry #${status.brokenAt} has been changed or removed since it was written (hash chain broken)`;
}
$('#verifyBtn').addEventListener('click', renderAudit);

function band(n) { return n >= 50 ? 3 : n >= 20 ? 2 : 1; }
function shortName(n) { return n.replace(/\.(pdf|csv|png|jpe?g)$/i, '').replace(/[-_]/g, ' ').slice(0, 22); }
