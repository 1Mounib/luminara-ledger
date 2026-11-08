/**
 * Shared helpers for every page: sign-in session, saved returns, settings,
 * money formatting and small UI bits (toasts, header).
 *
 * Two modes:
 *  - "cloud": a real account (Supabase Auth). Returns and the audit ledger
 *    are stored in the Sydney database, protected by Row Level Security.
 *  - "local": the offline demo (no account). Everything stays in this
 *    browser's storage - handy for presentations without internet.
 * Every page uses the same functions below, whatever the mode.
 */
import { signOutCloud, cloudListReturns, cloudGetReturn, cloudSaveReturn, cloudDeleteReturn, createCloudLedger } from '../cloud.js';
import { createLedger } from '../engine/auditLedger.js';
import { IDLE_MINUTES } from '../config.js';

// ------------------------------------------------------------------ session
const SESSION_KEY = 'll.session';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
export const isCloud = () => getSession()?.mode === 'cloud';

/** Offline demo sign-in (no password, this browser only). */
export function signInLocal(name, role) {
  const session = { mode: 'local', name: name.trim(), role, since: new Date().toISOString() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}
export async function signOut(reason) {
  await signOutCloud();
  localStorage.removeItem(SESSION_KEY);
  location.href = reason ? `/?msg=${encodeURIComponent(reason)}` : '/';
}
/** Sends the user to the sign-in page if they are not the right role (FR-001). */
export function requireRole(role) {
  const s = getSession();
  if (!s || s.role !== role) {
    location.href = `/?next=${encodeURIComponent(location.pathname)}&role=${role}`;
    throw new Error('redirecting');
  }
  watchIdle();
  return s;
}

/** Signs out automatically after IDLE_MINUTES without any activity (FR-002). */
function watchIdle() {
  const KEY = 'll.lastActive';
  const touch = () => localStorage.setItem(KEY, String(Date.now()));
  touch();
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach((ev) => addEventListener(ev, throttle(touch, 5000), { passive: true }));
  setInterval(() => {
    if (Date.now() - Number(localStorage.getItem(KEY) || 0) > IDLE_MINUTES * 60_000) {
      signOut(`Signed out after ${IDLE_MINUTES} minutes without activity.`);
    }
  }, 30_000);
}
function throttle(fn, ms) {
  let last = 0;
  return () => { const now = Date.now(); if (now - last > ms) { last = now; fn(); } };
}

// ------------------------------------------------------------------ returns
const RETURNS_KEY = 'll.returns';
const localAll = () => { try { return JSON.parse(localStorage.getItem(RETURNS_KEY)) || []; } catch { return []; } };

/** All returns this user may see (cloud: decided by the database's security rules). */
export async function listReturns() {
  return isCloud() ? cloudListReturns() : localAll();
}
export async function getReturn(id) {
  return isCloud() ? cloudGetReturn(id) : localAll().find((r) => r.id === id) || null;
}
/**
 * Saves a return. In cloud mode the real document text ("items") is NEVER
 * sent - only masked lines, results and flags.
 */
export async function saveReturn(record) {
  if (isCloud()) {
    const { items, ...safe } = record; // eslint-disable-line no-unused-vars
    return cloudSaveReturn(safe);
  }
  const all = localAll().filter((r) => r.id !== record.id);
  all.push({ ...record, updatedAt: new Date().toISOString() });
  localStorage.setItem(RETURNS_KEY, JSON.stringify(all));
  return record;
}
export async function deleteReturn(id) {
  if (isCloud()) return cloudDeleteReturn(id);
  localStorage.setItem(RETURNS_KEY, JSON.stringify(localAll().filter((r) => r.id !== id)));
}

/** The audit ledger: the database's hash chain in cloud mode, a local one offline. */
export function getLedger() {
  if (isCloud()) return createCloudLedger();
  const local = createLedger(localStorage);
  const s = getSession();
  return {
    append: (entry) => local.append({ user: s?.name, role: s?.role, ...entry }),
    entries: async () => local.entries(),
    verifyChain: () => local.verifyChain()
  };
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
    <a class="brand" href="/">${raw(LOGO_SVG)}<span>Luminara Ledger</span></a>
    <nav>
      ${s?.role === 'taxpayer' ? raw(`<a href="/app.html" class="${active === 'app' ? 'on' : ''}">My tax return</a>`) : ''}
      ${s?.role === 'accountant' ? raw(`<a href="/accountant.html" class="${active === 'accountant' ? 'on' : ''}">Client returns</a><a href="/accountant.html#audit" class="${active === 'audit' ? 'on' : ''}">Audit log</a>`) : ''}
    </nav>
    <div class="topbar-right">
      <label class="switch" title="Sovereign Mode: the AI runs only on this device - no document text is sent to the cloud AI">
        <input type="checkbox" id="sovereignToggle" ${getSovereignMode() ? 'checked' : ''}>
        <span class="track"><span class="thumb"></span></span>
        <span class="switch-label">Sovereign Mode</span>
      </label>
      ${s ? raw(`<span class="who">${escapeHtml(s.name)} <em>${escapeHtml(s.role)}</em><small class="mode-badge ${s.mode === 'cloud' ? 'cloud' : 'local'}" title="${s.mode === 'cloud' ? 'Signed in with an account. Saved in the Sydney database (hidden-detail copy only).' : 'Demo: everything stays in this browser.'}">${s.mode === 'cloud' ? 'Saved online' : 'Demo'}</small></span><button class="btn ghost small" id="signOutBtn">Sign out</button>`) : ''}
    </div>`;
  document.body.prepend(header);
  const flash = sessionStorage.getItem('ll.flash');
  if (flash) { sessionStorage.removeItem('ll.flash'); setTimeout(() => toast(flash, 'warn'), 300); }
  $('#signOutBtn', header)?.addEventListener('click', () => signOut());
  $('#sovereignToggle', header).addEventListener('change', (e) => {
    setSovereignMode(e.target.checked);
    toast(e.target.checked ? 'Sovereign Mode on: the AI runs only on this device.' : 'Dual-engine mode: only masked data is sent to the cloud AI.', 'info');
    document.dispatchEvent(new CustomEvent('sovereignchange', { detail: e.target.checked }));
  });
}

export const LOGO_SVG = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1d4e89"/><path d="M16 6 L26 25 H6 Z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M10.5 19.5 H21.5" stroke="#9fc0ea" stroke-width="2"/></svg>`;
