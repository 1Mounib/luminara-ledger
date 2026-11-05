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

// Restore this taxpayer's saved return (if any). With an account it comes from the
// database (masked); the real text, file names and token map come from this device's vault.
let existing = null;
try {
  const mine = (await listReturns()).filter((r) => (isCloud() ? r.ownerId === user.userId : r.owner === user.name));
  existing = mine[0] || null;
} catch (error) {
  toast(`Could not load your saved return: ${error.message}`, 'error');
}
if (existing) {
  const [tokens, items, names] = await Promise.all(
    ['tokens', 'items', 'docnames'].map((k) => loadSecret(`${k}:${existing.id}`).catch(() => null))
  );
  masking.importMap(tokens || {});
  Object.assign(state, {
    returnId: existing.id, status: existing.status, financialYear: existing.financialYear,
    docs: existing.docs.map((d) => ({ ...d, docName: names?.[d.docId] || d.docName, stage: 'Ready' })),
    items: existing.items || items || existing.masked, // real lines if this device has them
    masked: existing.masked, analysis: existing.analysis, result: existing.result
  });
}

const copilot = createCopilot({ root: $('#copilotPanel'), getState: () => state, masking, onUploadRequest: () => $('#fileInput').click() });

// ------------------------------------------------------------ cloud status
async function refreshStatus() {
  const s = await cloudStatus();
  state.cloudAi = Boolean(s.cloudAi);
  const el = $('#engineStatus');
  if (getSovereignMode()) el.innerHTML = '<span class="dot ok"></span> Sovereign Mode - all processing on this device';
  else if (state.cloudAi) el.innerHTML = `<span class="dot gold"></span> Dual-engine - masked data to ${escapeHtml(s.provider)} (${escapeHtml(s.preferredModel)})`;
  else el.innerHTML = '<span class="dot warn"></span> Cloud AI not set up - on-device agents only';
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
  const known = new Set(state.docs.map((d) => d.docId));
  for (const file of files) {
    const placeholder = { docId: `tmp-${Math.random()}`, docName: file.name, stage: 'Ingesting' };
    state.docs.push(placeholder);
    renderDocs();
    try {
      const out = await ingestFile(file, masking, known, (stage, extra) => { placeholder.stage = extra ? `${stage} (${extra})` : stage; renderDocs(); setPipeline(stage); });
      state.docs.splice(state.docs.indexOf(placeholder), 1);
      if (out.duplicate) { toast(`"${file.name}" was already uploaded (same SHA-256 fingerprint).`, 'warn'); continue; }
      known.add(out.doc.docId);
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
          ? raw(`${d.lines} lines read · <span class="mask-count">${d.maskedCount} private details masked</span>${d.kind === 'image' ? ` · OCR confidence ${d.confidence}%` : ''}`)
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
  btn.textContent = 'Analysing...';
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
    btn.textContent = 'Analyse my documents';
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
}

// ------------------------------------------------------------ tax position
function renderPosition() {
  const panel = $('#positionBody');
  if (!state.result) {
    panel.innerHTML = `<div class="placeholder"><p>Your estimate will appear here.</p><p class="muted">Upload documents, then press <b>Analyse my documents</b>.</p></div>`;
    $('#submitBtn').hidden = true;
    return;
  }
  const t = state.result.totals;
  const a = state.analysis;
  const refund = t.refund >= 0;
  const flags = [...a.flags].sort((x, y) => rank(x.severity) - rank(y.severity));

  panel.innerHTML = html`
    <div class="flags">${flags.map((f) => raw(flagHtml(f)))}</div>
    <div class="meter ${refund ? 'refund' : 'owe'}">
      <span>${refund ? 'Estimated refund' : 'Estimated amount you owe'}</span>
      <strong>${money(Math.abs(t.refund))}</strong>
      <div class="meter-sub">
        <div><small>Taxable income</small><b>${money(t.taxableIncome)}</b></div>
        <div><small>Deductions</small><b>${money(t.totalDeductions)}</b></div>
        <div><small>Net tax</small><b>${money(t.netTax)}</b></div>
        <div><small>Audit risk</small><b class="risk r${riskBand(a.riskScore)}">${a.riskScore}/100</b></div>
      </div>
    </div>
    <h3>How it was calculated</h3>
    <table class="lines">
      <tbody>${state.result.lines.map((l) => raw(lineHtml(l, a.facts)))}</tbody>
    </table>
    ${a.aiNotes?.length ? raw(`<h3>Compliance agent notes <span class="tag">AI · advisory only</span></h3><div class="flags">${a.aiNotes.map(flagHtml).join('')}</div>`) : ''}
    <h3>Agent activity <span class="tag">${a.mode === 'dual-engine' ? 'Dual-engine' : 'On-device'}</span></h3>
    <ul class="agents">${a.reports.map((r) => raw(`<li><b>${escapeHtml(r.agent)}</b><span>${escapeHtml(r.summary)}</span><small>${escapeHtml(r.engine)} · ${r.ms} ms</small></li>`))}</ul>`;

  $$('[data-refs]', panel).forEach((el) => el.addEventListener('click', () => showSource(el.dataset.refs.split(','), el.dataset.caption)));
  const submit = $('#submitBtn');
  submit.hidden = false;
  submit.disabled = state.status !== 'draft';
  submit.textContent = state.status === 'draft' ? 'Send to my accountant for review' : `Status: ${state.status === 'approved' ? 'approved by your accountant' : 'waiting for your accountant'}`;
}

function lineHtml(l, facts) {
  const refs = l.sourceRefs || [];
  const origin = originOf(l, facts);
  const amount = l.kind === 'offset' || l.kind === 'deduction' ? `-${money(l.amount)}` : money(l.amount);
  return `<tr class="k-${l.kind}">
    <td><b>${escapeHtml(l.label)}</b><small>${escapeHtml(l.formula)}</small><small class="law">${escapeHtml(l.legalBasis)}${origin ? ` · <span class="origin">${escapeHtml(origin)}</span>` : ''}</small></td>
    <td class="amt">${l.kind === 'info' ? '<span class="muted">$0.00</span>' : amount}</td>
    <td>${refs.length ? `<button class="src-chip" data-refs="${escapeHtml(refs.join(','))}" data-caption="${escapeHtml(l.label)}">Source</button>` : ''}</td>
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
  return `<div class="flag ${f.severity}"><span class="sev">${{ high: 'Action needed', medium: 'Check', info: 'Note' }[f.severity] || 'Note'}</span><p>${escapeHtml(f.message)}</p>${refs.length ? `<button class="src-chip" data-refs="${escapeHtml(refs.join(','))}" data-caption="Flag source">Source</button>` : ''}</div>`;
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
      <p>${Object.entries(types).map(([k, n]) => `${n} × ${k}`).join(' · ') || 'No private details found yet.'}</p>
      ${sent ? raw(`<pre class="payload">${escapeHtml(sent.slice(0, 20000))}${sent.length > 20000 ? '\n...' : ''}</pre>`) : raw('<p class="ok-note">Nothing has been sent. Either Sovereign Mode was on, the cloud AI is not set up, or you have not analysed yet.</p>')}
    </div>`;
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
});

$('#resetBtn').addEventListener('click', async () => {
  if (state.status !== 'draft') return toast('This return is with your accountant, so it can no longer be deleted.', 'warn');
  if (!confirm('Start again? This deletes your documents and estimate.')) return;
  try {
    if (state.returnId) await deleteReturn(state.returnId);
    location.reload();
  } catch (error) {
    toast(`Could not delete: ${error.message}`, 'error');
  }
});

// ------------------------------------------------------------ first render
renderDocs();
setPipeline(state.result ? 'Review ready' : state.docs.length ? 'Privacy masking' : null, true);
renderPosition();
if (state.status !== 'draft') toast(`This return is ${state.status}.`, 'info');
