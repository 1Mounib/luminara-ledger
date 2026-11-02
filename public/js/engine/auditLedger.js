/**
 * LUMINARA LEDGER - TAMPER-EVIDENT AUDIT LEDGER (NFR-011, NFR-012)
 * ----------------------------------------------------------------
 * Every override, approval and AI run is written here. Each entry contains
 * the SHA-256 hash of the entry before it (a "hash chain", like a blockchain).
 * If anyone edits or deletes an old entry, every hash after it stops matching,
 * and verifyChain() reports exactly where the chain was broken.
 *
 * Storage is passed in (localStorage in the browser, a Map in tests), so the
 * same code can later write to a database instead.
 */

const KEY = 'll.audit';
const GENESIS = '0'.repeat(64);

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The exact text that is hashed for an entry (everything except its own hash). */
function canonical(entry) {
  const { hash, ...rest } = entry;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function createLedger(storage = globalThis.localStorage) {
  const read = () => JSON.parse(storage.getItem(KEY) || '[]');
  const write = (entries) => storage.setItem(KEY, JSON.stringify(entries));

  return {
    entries: read,

    /**
     * Adds an entry. Fields recorded (NFR-011): who, when, what, which field,
     * old value, new value, justification and source references.
     */
    async append({ user, role, action, returnId, field = null, from = null, to = null, justification = null, sourceRefs = [], status = 'success' }) {
      const entries = read();
      const prevHash = entries.length ? entries[entries.length - 1].hash : GENESIS;
      const entry = {
        seq: entries.length + 1,
        time: new Date().toISOString(),
        user, role, action, returnId, field, from, to, justification, sourceRefs, status,
        interface: 'web',
        prevHash
      };
      entry.hash = await sha256(canonical(entry));
      entries.push(entry);
      write(entries);
      return entry;
    },

    /** Re-computes every hash. Returns { ok, brokenAt } */
    async verifyChain() {
      const entries = read();
      let prev = GENESIS;
      for (const e of entries) {
        if (e.prevHash !== prev || (await sha256(canonical(e))) !== e.hash) return { ok: false, brokenAt: e.seq, total: entries.length };
        prev = e.hash;
      }
      return { ok: true, brokenAt: null, total: entries.length };
    },

    clear() { storage.removeItem(KEY); }
  };
}
