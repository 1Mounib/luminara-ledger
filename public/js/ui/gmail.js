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

/** "2025-26" -> Gmail search for that year (plus 3 months for late statements). */
export function searchQuery(financialYear) {
  const start = Number(financialYear.slice(0, 4));
  return [
    'has:attachment',
    '(filename:pdf OR filename:csv OR filename:jpg OR filename:jpeg OR filename:png)',
    '(invoice OR receipt OR statement OR bill OR "tax invoice" OR "income statement" OR payslip OR timesheet OR order)',
    `after:${start}/07/01`,
    `before:${start + 1}/09/30`
  ].join(' ');
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
    onStatus('Searching your Gmail...');
    const list = await gmailGet(token, `messages?maxResults=30&q=${encodeURIComponent(searchQuery(financialYear))}`);
    const emails = [];
    for (const { id } of list.messages || []) {
      const msg = await gmailGet(token, `messages/${id}?format=full`);
      const header = (name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';
      const attachments = findAttachments(msg.payload).filter((a) => a.size < 15_000_000);
      if (attachments.length) emails.push({ id, from: header('from'), subject: header('subject'), date: header('date'), attachments });
    }
    if (!emails.length) { onStatus('No matching emails with attachments were found.'); return []; }

    const chosen = await pickAttachments(emails, financialYear);
    const files = [];
    for (const [i, c] of chosen.entries()) {
      onStatus(`Downloading ${i + 1} of ${chosen.length}: ${c.filename}`);
      const att = await gmailGet(token, `messages/${c.messageId}/attachments/${c.attachmentId}`);
      files.push(new File([base64UrlToBytes(att.data)], c.filename, { type: c.mimeType }));
    }
    return files;
  } finally {
    // Give the access back straight away - the website keeps no Gmail access
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
  }
}

/** Shows the emails found, with a tick box per attachment. */
function pickAttachments(emails, financialYear) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'viewer-dialog';
    d.innerHTML = `<form method="dialog">
      <header><div><b>Choose what to import from Gmail</b><small>${emails.length} email(s) with attachments, FY ${escapeHtml(financialYear)}. Only what you tick is downloaded, straight into this browser.</small></div></header>
      <div class="viewer-body gmail-list">
        ${emails.map((e) => `<div class="gm-mail">
          <div class="gm-head"><b>${escapeHtml(e.subject || '(no subject)')}</b><small>${escapeHtml(e.from)} · ${escapeHtml(new Date(e.date).toLocaleDateString('en-AU'))}</small></div>
          ${e.attachments.map((a) => `<label class="gm-att"><input type="checkbox" checked data-msg="${escapeHtml(e.id)}" data-att="${escapeHtml(a.attachmentId)}" data-name="${escapeHtml(a.filename)}" data-type="${escapeHtml(a.mimeType)}"> ${escapeHtml(a.filename)} <small>${Math.round(a.size / 1024)} KB</small></label>`).join('')}
        </div>`).join('')}
        <div class="row-end"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn gold" value="ok">Import selected</button></div>
      </div></form>`;
    document.body.append(d);
    d.showModal();
    d.addEventListener('close', () => {
      const picked = d.returnValue === 'ok'
        ? [...d.querySelectorAll('input:checked')].map((i) => ({ messageId: i.dataset.msg, attachmentId: i.dataset.att, filename: i.dataset.name, mimeType: i.dataset.type }))
        : [];
      d.remove();
      resolve(picked);
    });
  });
}
