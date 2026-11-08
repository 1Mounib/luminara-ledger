/**
 * Taxpayer portal (Capstone 1 UI: three panels - Documents | Tax position | Copilot).
 */
import { requireRole, renderHeader, getSovereignMode, cloudStatus, listReturns, saveReturn, deleteReturn, getLedger, isCloud, money, html, raw, escapeHtml, toast, $, $$ } from './common.js';
import { createMaskingSession, detectUnmaskedPII } from '../engine/redact.js';
import { saveSecret, loadSecret } from '../engine/vault.js';
import { STAGES, ingestFile, analyse, loadRules, sampleFiles, UC1_SAMPLES } from './pipeline.js';
import { openViewer } from './viewer.js';
import { createCopilot } from './copilot.js';
import { gmailConfigured, importFromGmail } from './gmail.js';

const user = requireRole('taxpayer');
renderHeader('app');
const ledger = getLedger();

// ------------------------------------------------------------ state
const state = {
  returnId: null,
  status: 'draft',
  financialYear: '2025-26',
  docs: [],        // { docId, docName, kind, lines, maskedCount, confidence, stage }
  items: [],       // real lines with positions (on this device only)
  masked: [],      // masked lines (what may be sent)
  analysis: null,
  result: null,
  payload: null,   // the exact data last sent to the cloud
  cloudAi: false
};
const masking = createMaskingSession({ knownNames: [user.name] });

// ------------------------------------------------------------ my returns
// Every return this taxpayer has made (newest first). With an account they come
// from the database (masked); the real text, file names and token map come from
// this device's encrypted vault.
let mine = [];
let existing = null;

async function refreshMine() {
  try {
    mine = (await listReturns())
      .filter((r) => (isCloud() ? r.ownerId === user.userId : r.owner === user.name))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  } catch (error) {
    toast(`Could not load your returns: ${error.message}`, 'error');
  }
  renderPicker();
}

/** Loads one saved return onto the screen. */
async function openReturn(record) {
  const [tokens, items, names] = await Promise.all(
    ['tokens', 'items', 'docnames'].map((k) => loadSecret(`${k}:${record.id}`).catch(() => null))
  );
  masking.clear();
  masking.importMap(tokens || {});
  existing = record;
  Object.assign(state, {
    returnId: record.id, status: record.status, financialYear: record.financialYear,
    docs: (record.docs || []).map((d) => ({ ...d, docName: names?.[d.docId] || d.docName, stage: 'Ready' })),
    items: record.items || items || record.masked || [], // real lines if this device has them
    masked: record.masked || [], analysis: record.analysis, result: record.result, payload: null
  });
}

const STATUS_TEXT = { draft: 'Draft', submitted: 'With your accountant', approved: 'Approved' };
function renderPicker() {
  const picker = $('#returnPicker');
  picker.hidden = mine.length < 2;
  picker.innerHTML = mine.map((r) => {
    const date = new Date(r.createdAt || r.updatedAt || Date.now()).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    const t = r.result?.totals;
    const amount = t ? (t.refund >= 0 ? `refund ${money(t.refund)}` : `owing ${money(-t.refund)}`) : (r.docs?.length ? 'not analysed' : 'empty');
    return `<option value="${escapeHtml(r.id)}" ${r.id === state.returnId ? 'selected' : ''}>${escapeHtml(`${date}, FY ${r.financialYear}: ${STATUS_TEXT[r.status] || r.status}, ${amount}`)}</option>`;
  }).join('');
}

await refreshMine();
if (mine[0]) await openReturn(mine[0]); // open the most recent return
renderPicker();

const copilot = createCopilot({ root: $('#copilotPanel'), getState: () => state, masking, onUploadRequest: () => $('#fileInput').click() });

// ------------------------------------------------------------ cloud status
async function refreshStatus() {
  const s = await cloudStatus();
  state.cloudAi = Boolean(s.cloudAi);
  const el = $('#engineStatus');
  if (getSovereignMode()) el.innerHTML = '<span class="dot ok"></span> Sovereign Mode: all AI runs on this device';
  else if (state.cloudAi) el.innerHTML = `<span class="dot primary"></span> AI: ${escapeHtml(s.provider)}, sees hidden-detail text only`;
  else el.innerHTML = '<span class="dot warn"></span> Cloud AI unavailable: using the on-device AI';
}
document.addEventListener('sovereignchange', refreshStatus);
refreshStatus();

// ------------------------------------------------------------ uploads
const input = $('#fileInput');
$('#chooseBtn').addEventListener('click', () => input.click());
input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
const drop = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
$('#loadSamples').addEventListener('click', async () => addFiles(await sampleFiles(UC1_SAMPLES)));
$('#loadOcr').addEventListener('click', async () => addFiles(await sampleFiles(['laptop-stand-receipt.png'])));

// Import from Gmail (only shown when a Google Client ID is set in config.js)
if (gmailConfigured()) {
  const btn = $('#gmailBtn');
  const status = $('#gmailStatus');
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.hidden = false;
    try {
      const files = await importFromGmail(state.financialYear, (msg) => { status.textContent = msg; });
      if (files.length) {
        status.textContent = `Importing ${files.length} attachment(s) from Gmail...`;
        await addFiles(files);
        status.textContent = `Imported ${files.length} attachment(s) from Gmail. Gmail access has been given back.`;
      } else if (!status.textContent.startsWith('No matching')) {
        status.textContent = 'Nothing imported.';
      }
    } catch (error) {
      status.textContent = `Gmail import stopped: ${error.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

async function addFiles(files) {
  if (state.status !== 'draft') { toast('This return has already been sent to your accountant.', 'warn'); return; }
  // A document that previously gave "no text found" may be re-added so it can be read again (e.g. with OCR)
  const known = new Set(state.docs.filter((d) => d.lines !== 0).map((d) => d.docId));
  for (const file of files) {
    const placeholder = { docId: `tmp-${Math.random()}`, docName: file.name, stage: 'Ingesting' };
    state.docs.push(placeholder);
    renderDocs();
    try {
      const out = await ingestFile(file, masking, known, (stage, extra) => { placeholder.stage = extra ? `${stage} (${extra})` : stage; renderDocs(); setPipeline(stage); });
      state.docs.splice(state.docs.indexOf(placeholder), 1);
      if (out.duplicate) { toast(`"${file.name}" was already uploaded (same SHA-256 fingerprint).`, 'warn'); continue; }
      known.add(out.doc.docId);
      // replace an earlier unreadable copy of the same file
      state.docs = state.docs.filter((d) => d.docId !== out.doc.docId);
      state.items = state.items.filter((i) => i.docId !== out.doc.docId);
      state.masked = state.masked.filter((i) => i.docId !== out.doc.docId);
      state.docs.push({ ...out.doc, stage: 'Ready' });
      state.items.push(...out.items);
      state.masked.push(...out.masked);
    } catch (error) {
      placeholder.stage = 'Error';
      placeholder.error = error.message;
      toast(error.message, 'error');
    }
    renderDocs();
  }
  setPipeline(state.docs.length ? 'Privacy masking' : null, true);
  state.result = null;
  state.analysis = null;
  renderPosition();
}

function renderDocs() {
  $('#docList').innerHTML = state.docs.map((d) => html`
    <li class="doc ${d.stage === 'Error' ? 'err' : ''}">
      <span class="doc-icon">${(d.kind || '').toUpperCase() || '...'}</span>
      <div class="doc-main">
        <b title="${d.docName}">${d.docName}</b>
        <small>${d.stage === 'Ready'
          ? raw(`${d.lines} lines read, <span class="mask-count">${d.maskedCount} private details hidden</span>${d.ocr ? `. Read with OCR (${d.confidence}% confidence)` : ''}${d.lines === 0 ? '. <b class="warn-text">No text found</b>' : ''}`)
          : d.error || d.stage}</small>
      </div>
      ${d.stage === 'Ready' ? raw(`<button class="btn ghost small" data-view="${escapeHtml(d.docId)}">View</button>`) : ''}
    </li>`).join('') || '<li class="empty">No documents yet.</li>';
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
    const doc = state.docs.find((d) => d.docId === b.dataset.view);
    openViewer({ ...doc, items: state.items }, [], 'Original file (stored encrypted on this device)');
  }));
  $('#analyseBtn').disabled = !state.docs.some((d) => d.stage === 'Ready') || state.status !== 'draft';
}

function setPipeline(stage, completeUpTo = false) {
  const idx = STAGES.indexOf(stage);
  $('#pipeline').innerHTML = STAGES.map((s, i) => `<li class="${i < idx || (completeUpTo && i === idx) ? 'done' : i === idx ? 'active' : ''}">${s}</li>`).join('');
}

// ------------------------------------------------------------ analyse
$('#analyseBtn').addEventListener('click', async () => {
  const btn = $('#analyseBtn');
  btn.disabled = true;
  btn.textContent = 'Working it out...';
  try {
    const rules = await loadRules(state.financialYear);
    const useCloud = !getSovereignMode() && state.cloudAi;
    const out = await analyse({ docs: state.docs, masked: state.masked, rules, useCloud, onStage: (s) => setPipeline(s, s === 'Review ready') });
    state.analysis = out.analysis;
    state.result = out.result;
    state.payload = out.payload;
    state.returnId ??= `R-${Date.now().toString(36).toUpperCase()}`;
    await persist().catch((error) => toast(`Analysed, but saving failed: ${error.message}`, 'error'));
    await ledger.append({ action: `analysed (${out.analysis.mode})`, returnId: state.returnId, to: out.result.totals.refund }).catch(() => {});
    renderPosition();
    copilot.nudge(state.analysis.flags);
    if (out.cloudError) toast('Cloud AI unavailable - on-device agents were used.', 'warn');
  } catch (error) {
    toast(`Analysis failed: ${error.message}`, 'error');
    console.error(error);
  } finally {
    btn.textContent = 'Work out my estimate';
    renderDocs();
  }
});

async function persist() {
  const ready = state.docs.filter((d) => d.stage === 'Ready');
  const record = {
    id: state.returnId, owner: user.name, status: state.status, financialYear: state.financialYear,
    // with an account, file names are masked too (a file name can contain your name)
    docs: ready.map(({ stage, error, ...d }) => ({ ...d, docName: isCloud() ? d.maskedName || d.docName : d.docName })),
    items: state.items, masked: state.masked,  // "items" (real text) is dropped before upload - see saveReturn()
    analysis: state.analysis, result: state.result, riskScore: state.analysis?.riskScore ?? 0,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  await saveReturn(record);
  // Private details stay on THIS device, encrypted with AES-256-GCM
  await saveSecret(`tokens:${state.returnId}`, masking.exportMap());
  await saveSecret(`items:${state.returnId}`, state.items);
  await saveSecret(`docnames:${state.returnId}`, Object.fromEntries(ready.map((d) => [d.docId, d.docName])));
  refreshMine(); // keep the "my returns" list up to date
}

// ------------------------------------------------------------ tax position
function renderPosition() {
  const panel = $('#positionBody');
  renderProgress();
  if (!state.result) {
    panel.innerHTML = `<div class="placeholder"><p>Your estimate will appear here</p><p class="muted">Add your documents, then choose <b>Work out my estimate</b>.</p></div>`;
    $('#submitBtn').hidden = true;
    return;
  }
  const t = state.result.totals;
  const a = state.analysis;
  const refund = t.refund >= 0;
  const flags = [...a.flags].sort((x, y) => rank(x.severity) - rank(y.severity));
  const lines = state.result.lines;
  const pick = (fn) => lines.filter(fn).map((l) => raw(lineHtml(l, a.facts)));
  const row = (cls, label, amount) => raw(`<tr class="${cls}"><td>${escapeHtml(label)}</td><td class="amt">${amount}</td><td class="src"></td></tr>`);
  const risk = ['', 'low', 'medium', 'high'][riskBand(a.riskScore)];

  panel.innerHTML = html`
    <div class="summary ${refund ? 'refund' : 'owe'}">
      <p class="summary-label">${refund ? 'Estimated refund' : 'Estimated amount you owe'}</p>
      <p class="summary-amount">${money(Math.abs(t.refund))}</p>
      <p class="summary-text">Your employer withheld ${money(t.taxWithheld)} in tax. Your tax works out to ${money(t.netTax)}, so ${refund ? `you should get ${money(t.refund)} back` : `you may need to pay ${money(-t.refund)}`}.</p>
      <p class="summary-risk">Audit risk: <b class="risk r${riskBand(a.riskScore)}">${risk}</b> (${a.riskScore} out of 100)</p>
    </div>
    <div class="flags">${flags.map((f) => raw(flagHtml(f)))}</div>
    <h3>How it was worked out</h3>
    <table class="lines">
      <tbody>
        <tr><th colspan="3">Income</th></tr>
        ${pick((l) => l.kind === 'income')}
        <tr><th colspan="3">Deductions</th></tr>
        ${pick((l) => l.kind === 'deduction')}
        ${pick((l) => l.kind === 'info')}
        ${row('subtotal', 'Taxable income (rounded down to whole dollars)', money(t.taxableIncome))}
        <tr><th colspan="3">Tax</th></tr>
        ${pick((l) => l.kind === 'tax' || l.kind === 'offset')}
        ${row('subtotal', 'Tax for the year', money(t.netTax))}
        ${pick((l) => l.kind === 'credit')}
        ${row('total', refund ? 'Estimated refund' : 'Estimated amount owing', money(Math.abs(t.refund)))}
      </tbody>
    </table>
    ${a.aiNotes?.length ? raw(`<h3>Notes from the compliance check <span class="tag">AI suggestion</span></h3><div class="flags">${a.aiNotes.map(flagHtml).join('')}</div>`) : ''}
    <details class="agents-box">
      <summary>How your documents were read (${a.reports.length} AI agents, ${a.mode === 'dual-engine' ? 'cloud and on-device' : 'on this device only'})</summary>
      <ul class="agents">${a.reports.map((r) => raw(`<li><b>${escapeHtml(r.agent)}</b><span>${escapeHtml(r.summary)}</span><small>${escapeHtml(r.engine)}, ${(r.ms / 1000).toFixed(1)} s</small></li>`))}</ul>
    </details>`;

  $$('[data-refs]', panel).forEach((el) => el.addEventListener('click', () => showSource(el.dataset.refs.split(','), el.dataset.caption)));
  const submit = $('#submitBtn');
  submit.hidden = false;
  submit.disabled = state.status !== 'draft';
  submit.textContent = state.status === 'draft' ? 'Send to my accountant' : state.status === 'approved' ? 'Approved by your accountant' : 'Sent - waiting for your accountant';
}

/** The 1-2-3 bar at the top: Add documents -> Check estimate -> Send to accountant. */
function renderProgress() {
  const sent = state.status !== 'draft';
  const current = sent ? 3 : state.result ? 2 : 1;
  $$('#progress li').forEach((li) => {
    const n = Number(li.dataset.step);
    const done = n < current || (n === 3 && sent);
    li.classList.toggle('done', done);
    li.classList.toggle('current', n === current && !done);
    if (n === current) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    if (n === 3) li.textContent = state.status === 'approved' ? 'Approved by your accountant' : sent ? 'Sent to your accountant' : 'Send to your accountant';
  });
}

function lineHtml(l, facts) {
  const refs = l.sourceRefs || [];
  const origin = originOf(l, facts);
  const minus = (l.kind === 'offset' || l.kind === 'deduction') && l.amount > 0;
  const amount = l.kind === 'info' ? '<span class="muted">not claimed</span>' : `${minus ? '&minus;' : ''}${money(l.amount)}`;
  return `<tr class="k-${l.kind}">
    <td><b>${escapeHtml(l.label)}</b><small>${escapeHtml(l.formula)}</small><small class="law">${escapeHtml(l.legalBasis)}${origin ? `. <span class="origin">Found by: ${escapeHtml(origin)}</span>` : ''}</small></td>
    <td class="amt">${amount}</td>
    <td class="src">${refs.length ? `<button class="src-chip" data-refs="${escapeHtml(refs.join(','))}" data-caption="${escapeHtml(l.label)}">Source</button>` : ''}</td>
  </tr>`;
}

function originOf(line, facts) {
  if (line.key === 'salary') return facts.salary?.origin;
  if (line.key === 'withheld') return facts.taxWithheld?.origin;
  if (line.key === 'wfh') return facts.wfhHours?.origin;
  if (line.key.startsWith('asset:')) return facts.assets?.find((a) => `asset:${a.id}` === line.key)?.origin;
  return null;
}

function flagHtml(f) {
  const refs = (f.refs || []).filter(Boolean);
  return `<div class="flag ${f.severity}"><span class="sev">${{ high: 'Action needed', medium: 'Please check', info: 'Good to know' }[f.severity] || 'Good to know'}</span><p>${escapeHtml(f.message)}</p>${refs.length ? `<button class="src-chip" data-refs="${escapeHtml(refs.join(','))}" data-caption="Flag source">Source</button>` : ''}</div>`;
}

function showSource(refs, caption) {
  const first = state.items.find((i) => i.id === refs[0]);
  if (!first) return toast('Source line not found.', 'warn');
  const doc = state.docs.find((d) => d.docId === first.docId);
  openViewer({ ...doc, items: state.items }, refs.filter((r) => r.startsWith(first.docId)), caption);
}

const rank = (s) => ({ high: 0, medium: 1, info: 2 }[s] ?? 3);
const riskBand = (n) => (n >= 50 ? 3 : n >= 20 ? 2 : 1);

// ------------------------------------------------------------ submit + privacy
$('#submitBtn').addEventListener('click', async () => {
  state.status = 'submitted';
  try {
    await persist();
  } catch (error) {
    state.status = 'draft';
    return toast(`Could not send: ${error.message}`, 'error');
  }
  await ledger.append({ action: 'submitted for review', returnId: state.returnId }).catch(() => {});
  toast('Sent to your accountant. Nothing is lodged until they approve it.', 'ok');
  renderPosition();
  renderDocs();
});

$('#privacyBtn').addEventListener('click', () => {
  const dialog = document.createElement('dialog');
  dialog.className = 'viewer-dialog privacy';
  const sent = state.payload ? JSON.stringify(state.payload, null, 2) : null;
  const tokens = masking.exportMap();
  const types = Object.keys(tokens).reduce((acc, t) => { const k = t.match(/<PII_([A-Z]+)_/)[1]; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const scan = sent ? detectUnmaskedPII(sent) : [];
  dialog.innerHTML = html`
    <header><div><b>What left this device</b><small>The exact data sent to the cloud AI on your last analysis</small></div><button class="btn ghost small" data-close>Close</button></header>
    <div class="viewer-body">
      <div class="privacy-stats">
        <div><small>Original files uploaded</small><b>0</b></div>
        <div><small>Masked lines sent</small><b>${sent ? state.payload.items.length : 0}</b></div>
        <div><small>Private details replaced</small><b>${Object.keys(tokens).length}</b></div>
        <div><small>PII scan of payload</small><b class="${scan.length ? 'bad' : 'ok'}">${scan.length ? 'Found: ' + scan.join(', ') : 'Clean'}</b></div>
      </div>
      <p>${Object.entries(types).map(([k, n]) => `${n} × ${k}`).join(', ') || 'No private details found yet.'}</p>
      ${sent ? raw(`<pre class="payload">${escapeHtml(sent.slice(0, 20000))}${sent.length > 20000 ? '\n...' : ''}</pre>`) : raw('<p class="ok-note">Nothing has been sent. Either Sovereign Mode was on, the cloud AI is not set up, or you have not analysed yet.</p>')}
    </div>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
});

$('#resetBtn').addEventListener('click', async () => {
  const submitted = state.status !== 'draft';
  const question = submitted
    ? 'Your submitted return stays with your accountant. Start a new, separate return?'
    : 'Start again? This deletes the documents and estimate in this draft.';
  if (!confirm(question)) return;
  try {
    // A draft can be deleted; a submitted return belongs to the accountant's queue now
    if (!submitted && state.returnId) await deleteReturn(state.returnId);
    // Save a brand-new empty return straight away, so it's what you see next time you sign in
    Object.assign(state, {
      returnId: `R-${Date.now().toString(36).toUpperCase()}`, status: 'draft',
      docs: [], items: [], masked: [], analysis: null, result: null, payload: null
    });
    existing = null;
    masking.clear();
    await persist();
    renderDocs();
    setPipeline(null);
    renderPosition();
    toast('New return started. Add documents or import from Gmail.', 'ok');
  } catch (error) {
    toast(`Could not start again: ${error.message}`, 'error');
  }
});

// ------------------------------------------------------------ switching between returns
$('#returnPicker').addEventListener('change', async (e) => {
  const record = mine.find((r) => r.id === e.target.value);
  if (!record) return;
  await openReturn(record);
  renderDocs();
  setPipeline(state.result ? 'Review ready' : state.docs.length ? 'Privacy masking' : null, true);
  renderPosition();
  toast(state.status === 'draft' ? 'Opened your draft return.' : `Opened a return that is ${STATUS_TEXT[state.status].toLowerCase()} (read-only).`, 'info');
});

// ------------------------------------------------------------ first render
renderDocs();
setPipeline(state.result ? 'Review ready' : state.docs.length ? 'Privacy masking' : null, true);
renderPosition();
if (state.status !== 'draft') toast(`This return is ${state.status}.`, 'info');
