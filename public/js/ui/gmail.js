/**
 * IMPORT FROM GMAIL (Engine A, in the browser)
 * ---------------------------------------------
 * 1. Google's own pop-up asks the taxpayer for READ-ONLY access to Gmail.
 * 2. The browser searches for receipts, bills and statements with attachments
 *    in the financial year, and lists them.
 * 3. The taxpayer ticks the ones to import; the attachments are downloaded
 *    straight from Google into this browser and go through the normal
 *    pipeline (read -> mask -> agents). Nothing goes via our server.
 * 4. Access is revoked straight after, so the website keeps no Gmail access.
 *
 * Least privilege: only the gmail.readonly scope, only when the user clicks.
 */
import { GOOGLE_CLIENT_ID } from '../config.js';
import { escapeHtml } from './common.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ALLOWED = /\.(pdf|csv|png|jpe?g|webp)$/i;

export const gmailConfigured = () => Boolean(GOOGLE_CLIENT_ID);

/** Loads Google Identity Services (Google's sign-in library) once. */
let gisPromise;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in (check your internet connection).'));
    document.head.append(s);
  });
  return gisPromise;
}

/** Opens Google's consent pop-up and returns a short-lived access token. */
async function getAccessToken() {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e.type === 'popup_closed' ? 'The Google window was closed.' : e.message || e.type))
    });
    client.requestAccessToken({ prompt: 'select_account' }); // always let the user pick which Google account
  });
}

async function gmailGet(token, path) {
  const res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body.error?.message || `Gmail returned ${res.status}`;
    if (/mail service not enabled/i.test(msg)) {
      throw new Error('the Google account you chose has no Gmail inbox (for example, a Google account made with an Outlook address). Click the button again and choose an @gmail.com account.');
    }
    if (res.status === 403 && /insufficient|scope|permission/i.test(msg)) {
      throw new Error('Gmail permission was not given. Click the button again and tick "View your email messages".');
    }
    throw new Error(msg);
  }
  return res.json();
}

const TAX_WORDS = '(invoice OR receipt OR statement OR bill OR "tax invoice" OR "income statement" OR payslip OR timesheet OR order)';

/**
 * "2025-07-01" -> seconds since 1970 at local midnight. Gmail accepts these
 * exact times in after:/before:, so the range follows the user's own timezone
 * (plain dates would be read in US Pacific time).
 */
const localMidnight = (iso) => Math.floor(new Date(`${iso}T00:00:00`).getTime() / 1000);
/** Gmail's "before:" is exclusive, so stop at the midnight AFTER the "To" date. */
function dayAfter(iso) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return localIso(d);
}
const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Builds the Gmail search.
 * @param {{from?:string, to?:string, onlyTax?:boolean, extra?:string}} o  dates as YYYY-MM-DD
 */
export function searchQuery({ from = '', to = '', onlyTax = true, extra = '' } = {}) {
  return [
    'has:attachment',
    '(filename:pdf OR filename:csv OR filename:jpg OR filename:jpeg OR filename:png)',
    onlyTax ? TAX_WORDS : '',
    extra.trim().replace(/[()]/g, ''),
    from ? `after:${localMidnight(from)}` : '',
    to ? `before:${localMidnight(dayAfter(to))}` : ''
  ].filter(Boolean).join(' ');
}

/** Date ranges for the quick buttons. "2025-26" = 1 Jul 2025 to 30 Jun 2026. */
export function presetRange(name, financialYear, today = new Date()) {
  const y = Number(financialYear.slice(0, 4));
  const iso = localIso;
  if (name === 'fy') return { from: `${y}-07-01`, to: `${y + 1}-06-30` };
  if (name === 'lastfy') return { from: `${y - 1}-07-01`, to: `${y}-06-30` };
  if (name === '12m') { const f = new Date(today); f.setFullYear(f.getFullYear() - 1); return { from: iso(f), to: iso(today) }; }
  return { from: '', to: '' }; // any time
}

/** Finds every attachment in an email (attachments can be nested in parts). */
export function findAttachments(payload, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId && ALLOWED.test(payload.filename)) {
    out.push({ filename: payload.filename, mimeType: payload.mimeType, attachmentId: payload.body.attachmentId, size: payload.body.size || 0 });
  }
  for (const part of payload.parts || []) findAttachments(part, out);
  return out;
}

/** base64url (what Gmail sends) -> bytes */
export function base64UrlToBytes(data) {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * The whole flow. Resolves with the File objects the user chose (or [] if cancelled).
 * @param {string} financialYear e.g. "2025-26"
 * @param {(msg:string)=>void} onStatus progress messages
 */
export async function importFromGmail(financialYear, onStatus = () => {}) {
  onStatus('Waiting for Google...');
  const token = await getAccessToken();
  try {
    onStatus('Choose what to search for in the Gmail window.');
    const files = await gmailDialog(token, financialYear, onStatus);
    if (!files.length) onStatus('Nothing imported.');
    return files;
  } finally {
    // Give the access back straight away - the website keeps no Gmail access
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
  }
}

/** Searches Gmail and returns emails that have usable attachments. */
async function searchEmails(token, query) {
  const list = await gmailGet(token, `messages?maxResults=50&q=${encodeURIComponent(query)}`);
  const ids = (list.messages || []).map((m) => m.id);
  const emails = [];
  for (let i = 0; i < ids.length; i += 10) { // 10 at a time, so it's quick but polite
    const batch = await Promise.all(ids.slice(i, i + 10).map((id) => gmailGet(token, `messages/${id}?format=full`)));
    for (const msg of batch) {
      const header = (name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
      const attachments = findAttachments(msg.payload).filter((a) => a.size < 15_000_000);
      if (attachments.length) emails.push({ id: msg.id, from: header('from'), subject: header('subject'), date: header('date'), attachments });
    }
  }
  return emails;
}

/** The Gmail window: search options, results with tick boxes, import. */
function gmailDialog(token, financialYear, onStatus) {
  return new Promise((resolve) => {
    const y = Number(financialYear.slice(0, 4));
    const d = document.createElement('dialog');
    d.className = 'viewer-dialog';
    d.innerHTML = `
      <header><div><b>Import from Gmail</b><small>Read-only. Gmail is searched straight from this browser; only what you tick is downloaded.</small></div><button class="btn ghost small" data-cancel>Cancel</button></header>
      <div class="viewer-body">
        <form class="gm-search">
          <div class="gm-label">Emails sent</div>
          <div class="gm-presets" role="group" aria-label="Date range">
            <button type="button" data-range="fy" title="Emails sent 1 Jul ${y} - 30 Jun ${y + 1}">Tax year you're claiming: FY ${y}-${String(y + 1).slice(2)}</button>
            <button type="button" data-range="lastfy" title="Emails sent 1 Jul ${y - 1} - 30 Jun ${y}">FY ${y - 1}-${String(y).slice(2)}</button>
            <button type="button" data-range="12m">Last 12 months</button>
            <button type="button" data-range="any">Any time</button>
          </div>
          <div class="gm-dates">
            <label>From <input type="date" name="from"></label>
            <label>To <input type="date" name="to"></label>
          </div>
          <label class="gm-check"><input type="checkbox" name="onlyTax" checked> Only emails that look like invoices, receipts, bills or statements</label>
          <label class="gm-extra">Extra search words (optional)<input name="extra" placeholder="e.g. Officeworks, or a sender's name"></label>
          <button class="btn gold" type="submit">Search Gmail</button>
        </form>
        <p class="gm-status" aria-live="polite"></p>
        <div class="gm-results gmail-list"></div>
        <div class="row-end gm-actions" hidden>
          <button class="btn ghost small" type="button" data-all>Select all</button>
          <button class="btn ghost small" type="button" data-none>Select none</button>
          <button class="btn gold" type="button" data-import>Import selected</button>
        </div>
      </div>`;
    document.body.append(d);
    d.showModal();

    const form = d.querySelector('.gm-search');
    const status = d.querySelector('.gm-status');
    const results = d.querySelector('.gm-results');
    const actions = d.querySelector('.gm-actions');
    const importBtn = d.querySelector('[data-import]');
    let finished = false;
    const finish = (files) => { if (finished) return; finished = true; d.close(); d.remove(); resolve(files); };

    const setRange = (name) => {
      const r = presetRange(name, financialYear);
      form.from.value = r.from;
      form.to.value = r.to;
      d.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === name));
    };
    d.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.range)));
    ['from', 'to'].forEach((n) => form[n].addEventListener('input', () => d.querySelectorAll('[data-range]').forEach((b) => b.classList.remove('on'))));
    setRange('12m');

    const countTicked = () => {
      const n = results.querySelectorAll('input:checked').length;
      importBtn.textContent = n ? `Import selected (${n})` : 'Import selected';
      importBtn.disabled = !n;
    };
    results.addEventListener('change', countTicked);
    d.querySelector('[data-all]').addEventListener('click', () => { results.querySelectorAll('input').forEach((i) => { i.checked = true; }); countTicked(); });
    d.querySelector('[data-none]').addEventListener('click', () => { results.querySelectorAll('input').forEach((i) => { i.checked = false; }); countTicked(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.from.value && form.to.value && form.from.value > form.to.value) { status.textContent = 'The "From" date is after the "To" date.'; return; }
      const query = searchQuery({ from: form.from.value, to: form.to.value, onlyTax: form.onlyTax.checked, extra: form.extra.value });
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      status.textContent = 'Searching your Gmail...';
      results.innerHTML = '';
      actions.hidden = true;
      try {
        const emails = await searchEmails(token, query);
        const range = form.from.value || form.to.value
          ? `sent ${form.from.value ? 'from ' + new Date(form.from.value).toLocaleDateString('en-AU') : ''} ${form.to.value ? 'to ' + new Date(form.to.value).toLocaleDateString('en-AU') : ''}`.trim()
          : 'sent any time';
        status.textContent = emails.length
          ? `${emails.length} email(s) with attachments, ${range}. Untick anything you don't want.`
          : `No emails with PDF, CSV or image attachments ${range}. Try a wider date range${form.onlyTax.checked ? ' or untick "Only emails that look like invoices..."' : ''}.`;
        results.innerHTML = emails.map((m) => `<div class="gm-mail">
          <div class="gm-head"><b>${escapeHtml(m.subject || '(no subject)')}</b><small>${escapeHtml(m.from)} · ${escapeHtml(new Date(m.date).toLocaleDateString('en-AU'))}</small></div>
          ${m.attachments.map((a) => `<label class="gm-att"><input type="checkbox" checked data-msg="${escapeHtml(m.id)}" data-att="${escapeHtml(a.attachmentId)}" data-name="${escapeHtml(a.filename)}" data-type="${escapeHtml(a.mimeType)}"> ${escapeHtml(a.filename)} <small>${Math.max(1, Math.round(a.size / 1024))} KB</small></label>`).join('')}
        </div>`).join('');
        actions.hidden = !emails.length;
        countTicked();
      } catch (error) {
        status.textContent = `Search failed: ${error.message}`;
      } finally {
        btn.disabled = false;
      }
    });

    importBtn.addEventListener('click', async () => {
      const chosen = [...results.querySelectorAll('input:checked')].map((i) => ({ messageId: i.dataset.msg, attachmentId: i.dataset.att, filename: i.dataset.name, mimeType: i.dataset.type }));
      importBtn.disabled = true;
      const files = [];
      try {
        for (const [i, c] of chosen.entries()) {
          status.textContent = `Downloading ${i + 1} of ${chosen.length}: ${c.filename}`;
          onStatus(status.textContent);
          const att = await gmailGet(token, `messages/${c.messageId}/attachments/${c.attachmentId}`);
          files.push(new File([base64UrlToBytes(att.data)], c.filename, { type: c.mimeType }));
        }
        finish(files);
      } catch (error) {
        status.textContent = `Download failed: ${error.message}`;
        importBtn.disabled = false;
      }
    });

    d.querySelector('[data-cancel]').addEventListener('click', () => finish([]));
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish([]); }); // Esc key
  });
}
