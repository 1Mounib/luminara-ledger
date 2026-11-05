/**
 * LUMINARA LEDGER - CLOUD CLIENT (Supabase, Sydney region)
 * --------------------------------------------------------
 * Talks to Supabase with plain fetch() calls - no library needed:
 *   /auth/v1/...  logins (Supabase Auth)
 *   /rest/v1/...  database tables, protected by Row Level Security
 *
 * Only MASKED data is ever sent here (see supabase/schema.sql).
 */
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const SESSION_KEY = 'll.session';

/** Lets the local test server stand in for Supabase (only on localhost). */
function baseUrl() {
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    try { const dev = localStorage.getItem('ll.devSupabaseUrl'); if (dev) return dev; } catch { /* ignore */ }
  }
  return SUPABASE_URL;
}

export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

// ------------------------------------------------------------------ session storage
function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function writeSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

/** Turns Supabase's error replies into one plain-English sentence. */
async function errorFrom(res) {
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  const raw = body.msg || body.message || body.error_description || body.error || res.statusText;
  const friendly = {
    'Invalid login credentials': 'Email or password is wrong.',
    'User already registered': 'An account with this email already exists. Sign in instead.',
    'Email not confirmed': 'Please confirm your email first (check your inbox).'
  };
  const err = new Error(friendly[raw] || raw || `Request failed (${res.status})`);
  err.status = res.status;
  return err;
}

// ------------------------------------------------------------------ auth
async function authRequest(path, body, token) {
  const res = await fetch(`${baseUrl()}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw await errorFrom(res);
  return res.status === 204 ? {} : res.json();
}

/** Saves the login tokens plus the user's name and role (read from the database, not the browser). */
async function startSession(auth) {
  const base = {
    mode: 'cloud',
    userId: auth.user.id,
    email: auth.user.email,
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
    expires_at: Date.now() + (auth.expires_in || 3600) * 1000,
    since: new Date().toISOString()
  };
  writeSession({ ...base, name: auth.user.email, role: 'taxpayer' });
  const [profile] = await rest('GET', `profiles?id=eq.${auth.user.id}&select=full_name,role`);
  return writeSession({ ...base, name: profile?.full_name || auth.user.email, role: profile?.role || 'taxpayer' });
}

/**
 * Creates an account. Accountants must give the practice code; the DATABASE
 * checks it and decides the role (see private.handle_new_user in schema.sql).
 * @returns session, or { needsConfirmation: true } if email confirmation is on
 */
export async function signUp({ email, password, fullName, role, practiceCode }) {
  const auth = await authRequest('signup', {
    email, password,
    data: { full_name: fullName, role, ...(role === 'accountant' ? { practice_code: practiceCode } : {}) }
  });
  if (!auth.access_token) return { needsConfirmation: true };
  const session = await startSession(auth);
  if (role === 'accountant' && session.role !== 'accountant') {
    session.warning = 'The practice code was not accepted, so this account was created as a taxpayer.';
  }
  return session;
}

export async function signIn(email, password) {
  return startSession(await authRequest('token?grant_type=password', { email, password }));
}

export async function signOutCloud() {
  const s = readSession();
  if (s?.mode === 'cloud' && s.access_token) {
    try { await authRequest('logout', {}, s.access_token); } catch { /* already expired */ }
  }
}

/** Returns a valid access token, refreshing it if it is about to expire. */
async function accessToken() {
  const s = readSession();
  if (!s || s.mode !== 'cloud') throw new Error('Not signed in');
  if (Date.now() < s.expires_at - 60_000) return s.access_token;
  const auth = await authRequest('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
  writeSession({ ...s, access_token: auth.access_token, refresh_token: auth.refresh_token, expires_at: Date.now() + (auth.expires_in || 3600) * 1000 });
  return auth.access_token;
}

// ------------------------------------------------------------------ database (PostgREST)
/**
 * One database request.
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path  e.g. "returns?id=eq.R-1"
 */
export async function rest(method, path, body) {
  const token = await accessToken();
  const res = await fetch(`${baseUrl()}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  if (!res.ok) throw await errorFrom(res);
  return res.status === 204 ? [] : res.json();
}

// ------------------------------------------------------------------ returns
const toRow = (r) => ({
  id: r.id, owner_name: r.owner, status: r.status, financial_year: r.financialYear,
  risk_score: r.riskScore ?? 0, docs: r.docs, masked: r.masked, analysis: r.analysis, result: r.result
});
const fromRow = (row) => ({
  id: row.id, ownerId: row.owner, owner: row.owner_name, status: row.status, financialYear: row.financial_year,
  riskScore: row.risk_score, docs: row.docs || [], masked: row.masked || [], analysis: row.analysis, result: row.result,
  approvedBy: row.approved_by, approvedAt: row.approved_at, createdAt: row.created_at, updatedAt: row.updated_at
});

export async function cloudListReturns() {
  return (await rest('GET', 'returns?select=*&order=updated_at.desc')).map(fromRow);
}
export async function cloudGetReturn(id) {
  const rows = await rest('GET', `returns?id=eq.${encodeURIComponent(id)}&select=*`);
  return rows[0] ? fromRow(rows[0]) : null;
}
/** Updates the row if it exists, otherwise creates it. */
export async function cloudSaveReturn(record) {
  const row = toRow(record);
  const updated = await rest('PATCH', `returns?id=eq.${encodeURIComponent(record.id)}`, row);
  if (updated.length) return fromRow(updated[0]);
  const created = await rest('POST', 'returns', row);
  return fromRow(created[0]);
}
export async function cloudDeleteReturn(id) {
  return rest('DELETE', `returns?id=eq.${encodeURIComponent(id)}`);
}

// ------------------------------------------------------------------ audit ledger (hash chain kept by the database)
export function createCloudLedger() {
  return {
    /** Who/when/hash are filled in by the database itself. */
    async append({ action, returnId = null, field = null, from = null, to = null, justification = null, sourceRefs = [], status = 'success' }) {
      const [row] = await rest('POST', 'audit_log', {
        action, return_id: returnId, field, from_value: from ?? null, to_value: to ?? null, justification, source_refs: sourceRefs || [], status
      });
      return row;
    },
    async entries() {
      const rows = await rest('GET', 'audit_log?select=*&order=seq.asc');
      return rows.map((e) => ({
        seq: e.seq, time: e.time, user: e.user_name, role: e.role, action: e.action, returnId: e.return_id,
        field: e.field, from: e.from_value, to: e.to_value, justification: e.justification, sourceRefs: e.source_refs, hash: e.hash, prevHash: e.prev_hash
      }));
    },
    async verifyChain() {
      const [r] = await rest('POST', 'rpc/verify_audit_chain', {});
      return { ok: r.ok, brokenAt: r.broken_at, total: Number(r.total) };
    }
  };
}
