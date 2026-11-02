/**
 * Shared helpers for every page: sign-in session, saved returns, settings,
 * money formatting and small UI bits (toasts, header).
 *
 * NOTE (week-1 build): sessions and returns are kept in this browser's
 * localStorage so the demo works with no database. The planned next step is
 * Supabase (Postgres + Auth, Sydney region) - see docs/ROADMAP.md.
 */

// ------------------------------------------------------------------ session
const SESSION_KEY = 'll.session';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
export function signIn(name, role) {
  const session = { name: name.trim(), role, since: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}
export function signOut() {
  localStorage.removeItem(SESSION_KEY);
  location.href = '/';
}
/** Sends the user to the sign-in page if they are not the right role (FR-001). */
export function requireRole(role) {
  const s = getSession();
  if (!s || s.role !== role) {
    location.href = `/?next=${encodeURIComponent(location.pathname)}&role=${role}`;
    throw new Error('redirecting');
  }
  return s;
}

// ------------------------------------------------------------------ returns
const RETURNS_KEY = 'll.returns';

export function listReturns() {
  try { return JSON.parse(localStorage.getItem(RETURNS_KEY)) || []; } catch { return []; }
}
export function getReturn(id) {
  return listReturns().find((r) => r.id === id) || null;
}
export function saveReturn(record) {
  const all = listReturns().filter((r) => r.id !== record.id);
  all.push({ ...record, updatedAt: new Date().toISOString() });
  localStorage.setItem(RETURNS_KEY, JSON.stringify(all));
  return record;
}

// ------------------------------------------------------------------ settings
export function getSovereignMode() {
  return localStorage.getItem('ll.sovereign') === 'on';
}
export function setSovereignMode(on) {
  localStorage.setItem('ll.sovereign', on ? 'on' : 'off');
}

/** Asks the server if the cloud AI is set up. Never called in Sovereign Mode. */
export async function cloudStatus() {
  if (getSovereignMode()) return { cloudAi: false, reason: 'Sovereign Mode is on' };
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch {
    return { cloudAi: false, reason: 'Server not reachable' };
  }
}

// ------------------------------------------------------------------ formatting
export const money = (n) =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tiny template helper: html`<p>${value}</p>` escapes values automatically. */
export function html(strings, ...values) {
  return strings.reduce((out, str, i) => {
    const v = values[i - 1];
    const safe = v && v.__html ? v.__html : Array.isArray(v) ? v.map((x) => (x && x.__html) ?? escapeHtml(x)).join('') : escapeHtml(v);
    return out + safe + str;
  });
}
export const raw = (s) => ({ __html: String(s) });

export function $(selector, root = document) { return root.querySelector(selector); }
export function $$(selector, root = document) { return [...root.querySelectorAll(selector)]; }

// ------------------------------------------------------------------ toasts
export function toast(message, kind = 'info') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4200);
}

// ------------------------------------------------------------------ header
export function renderHeader(active) {
  const s = getSession();
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = html`
    <a class="brand" href="/">${raw(LOGO_SVG)}<span><b>Luminara Ledger</b><small>Sovereign by design</small></span></a>
    <nav>
      ${s?.role === 'taxpayer' ? raw(`<a href="/app.html" class="${active === 'app' ? 'on' : ''}">My tax return</a>`) : ''}
      ${s?.role === 'accountant' ? raw(`<a href="/accountant.html" class="${active === 'accountant' ? 'on' : ''}">Client queue</a><a href="/accountant.html#audit" class="${active === 'audit' ? 'on' : ''}">Audit ledger</a>`) : ''}
    </nav>
    <div class="topbar-right">
      <label class="switch" title="Sovereign Mode: nothing leaves this device - the on-device agents do all the work">
        <input type="checkbox" id="sovereignToggle" ${getSovereignMode() ? 'checked' : ''}>
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label">Sovereign Mode</span>
      </label>
      ${s ? raw(`<span class="who">${escapeHtml(s.name)} <em>${escapeHtml(s.role)}</em></span><button class="btn ghost small" id="signOutBtn">Sign out</button>`) : ''}
    </div>`;
  document.body.prepend(header);
  $('#signOutBtn', header)?.addEventListener('click', signOut);
  $('#sovereignToggle', header).addEventListener('change', (e) => {
    setSovereignMode(e.target.checked);
    toast(e.target.checked ? 'Sovereign Mode on: nothing will leave this device.' : 'Dual-engine mode: only masked data is sent to the cloud AI.', 'info');
    document.dispatchEvent(new CustomEvent('sovereignchange', { detail: e.target.checked }));
  });
}

export const LOGO_SVG = `<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6dc8a"/><stop offset="1" stop-color="#b8892b"/></linearGradient></defs><path d="M24 4 L42 40 H6 Z" fill="none" stroke="url(#lg)" stroke-width="2.5" stroke-linejoin="round"/><path d="M24 4 L24 40 M24 4 L15 40" stroke="url(#lg)" stroke-width="1.6" opacity=".7"/><ellipse cx="24" cy="30" rx="21" ry="6" fill="none" stroke="url(#lg)" stroke-width="1.3" opacity=".8"/></svg>`;
