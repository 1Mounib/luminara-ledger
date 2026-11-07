/**
 * Copilot chat panel (FR-023 explain, FR-024 ask for missing documents).
 * Cloud mode: sends the question + MASKED context to /api/copilot, then puts
 * real names back in locally ("re-hydration"). Sovereign/offline mode: answers
 * on-device from the result and the knowledge base.
 */
import { KNOWLEDGE_ITEMS } from '../engine/knowledge.js';
import { escapeHtml, money, getSovereignMode } from './common.js';

export function createCopilot({ root, getState, masking, onUploadRequest }) {
  const log = root.querySelector('.chat-log');
  const form = root.querySelector('form');
  const input = form.querySelector('input');
  const history = [];

  function add(role, text, extra = '') {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = `<div class="bubble">${formatText(text)}${extra}</div>`;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function ask(question) {
    if (!question.trim()) return;
    add('user', question);
    history.push({ role: 'user', content: masking.mask(question).text });
    const thinking = add('assistant', '...');
    const state = getState();
    let answer;
    let badge;
    if (!getSovereignMode() && state.cloudAi) {
      try {
        const res = await fetch('/api/copilot', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: masking.mask(question).text, context: buildContext(state, masking), history: history.slice(0, -1) })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        answer = masking.rehydrate(body.reply);           // real names restored on THIS device only
        badge = `Cloud AI · ${body.model}`;
      } catch (e) {
        answer = localAnswer(question, state);
        badge = 'On-device answer (cloud unavailable)';
      }
    } else {
      answer = localAnswer(question, state);
      badge = 'On-device answer';
    }
    history.push({ role: 'assistant', content: masking.mask(answer).text });
    thinking.querySelector('.bubble').innerHTML = formatText(answer) + `<small class="src">${escapeHtml(badge)}</small>`;
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value; input.value = ''; ask(q); });
  root.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.ask)));

  /** Active capture: after analysis, ask for anything missing. */
  function nudge(flags) {
    // Old "I need one more thing" messages are out of date after a new analysis
    log.querySelectorAll('.msg.nudge').forEach((m) => m.remove());
    const missing = flags.filter((f) => ['MISSING_WFH_RECORD', 'MISSING_INCOME', 'PHI_MISSING', 'ASSET_NO_DATE'].includes(f.code));
    if (!missing.length) {
      add('assistant', 'Your documents are analysed. Ask me anything about the result, for example how the chair was worked out.').classList.add('nudge');
      return;
    }
    const el = add('assistant', `I need one more thing:\n${missing.map((f) => `- ${f.message}`).join('\n')}`, '<button class="btn gold small upload-nudge">Upload a document</button>');
    el.classList.add('nudge');
    el.querySelector('.upload-nudge').addEventListener('click', onUploadRequest);
  }

  add('assistant', 'Hi! I\'m your Copilot. Upload your documents (or load the samples) and press **Analyse**. I can then explain every number.');
  return { ask, nudge, add };
}

/** The masked summary the cloud Copilot is allowed to see. */
export function buildContext(state, masking) {
  if (!state.result) return 'No documents analysed yet.';
  const t = state.result.totals;
  const lines = state.result.lines.map((l) => `- ${l.label}: ${money(l.amount)} | ${l.formula} | ${l.legalBasis}`).join('\n');
  const flags = (state.analysis?.flags || []).map((f) => `- [${f.severity}] ${f.message}`).join('\n') || '- none';
  const text = `Financial year ${state.result.financialYear}
Totals: income ${money(t.assessableIncome)}, deductions ${money(t.totalDeductions)}, taxable income ${money(t.taxableIncome)}, income tax ${money(t.incomeTax)}, LITO ${money(t.lowIncomeTaxOffset)}, Medicare levy ${money(t.medicareLevy)}, net tax ${money(t.netTax)}, withheld ${money(t.taxWithheld)}, ${t.refund >= 0 ? 'estimated refund' : 'estimated amount owing'} ${money(Math.abs(t.refund))}
Lines:
${lines}
Flags:
${flags}
Documents: ${(state.docs || []).map((d) => d.docName).join(', ')}`;
  return masking.mask(text).text;
}

/** On-device answers: picks the most relevant result line and knowledge item. */
export function localAnswer(question, state) {
  const q = question.toLowerCase();
  const r = state.result;
  const parts = [];
  if (r) {
    const find = (re) => r.lines.filter((l) => re.test(l.label.toLowerCase()));
    if (/refund|owe|payable|get back|result|total/.test(q)) {
      const t = r.totals;
      parts.push(`The rules engine estimates ${t.refund >= 0 ? 'a **refund of ' + money(t.refund) + '**' : 'that you **owe ' + money(-t.refund) + '**'}: tax withheld ${money(t.taxWithheld)} minus net tax ${money(t.netTax)} (income tax ${money(t.incomeTax)} + Medicare levy ${money(t.medicareLevy)} - offsets ${money(t.lowIncomeTaxOffset)}).`);
    }
    for (const l of find(/decline in value|immediate/)) if (/chair|desk|laptop|asset|depreci|equipment|stand|monitor/.test(q)) parts.push(`**${l.label}: ${money(l.amount)}** - ${l.formula}. (${l.legalBasis})`);
    for (const l of find(/covered by the fixed rate/)) if (/electric|internet|phone|mobile|bill|gas/.test(q)) parts.push(`**${l.label}** - ${l.formula}.`);
    for (const l of find(/working from home/)) if (/hour|wfh|home|fixed|70/.test(q)) parts.push(`**${l.label}: ${money(l.amount)}** = ${l.formula}. (${l.legalBasis})`);
    if (/medicare/.test(q)) find(/medicare/).forEach((l) => parts.push(`**${l.label}: ${money(l.amount)}** - ${l.formula}.`));
  }
  const scored = KNOWLEDGE_ITEMS.map((k) => ({ k, score: k.keywords.filter((w) => q.includes(w)).length })).sort((a, b) => b.score - a.score);
  if (scored[0].score > 0) parts.push(scored[0].k.text);
  if (!parts.length) parts.push('I can explain your refund, the work-from-home rate, depreciation of equipment, which records to keep, and how your privacy is protected. Try asking about one of those.');
  return parts.join('\n\n');
}

/** Very small formatter: **bold**, "- " bullets and line breaks. Everything is escaped first. */
function formatText(text) {
  const safe = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const lines = safe.split('\n');
  let out = '';
  let inList = false;
  for (const line of lines) {
    if (/^\s*[-*] /.test(line)) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${line.replace(/^\s*[-*] /, '')}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    out += line.trim() ? `<p>${line}</p>` : '';
  }
  return out + (inList ? '</ul>' : '');
}
