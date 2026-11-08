/**
 * TaxMate - LOCAL ENCRYPTED VAULT (NFR-002c, NFR-003)
 * -----------------------------------------------------------
 * Saves sensitive things on THIS device, encrypted with AES-256-GCM:
 *  - the PII token map (<PII_TFN_1> -> real TFN), and
 *  - the uploaded files themselves (so the accountant view can show them).
 *
 * The encryption key is created by the browser and stored in IndexedDB as
 * "non-extractable": JavaScript can use it but can never read or copy it out.
 */
const DB_NAME = 'TaxMate-vault';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys');
      req.result.createObjectStore('secrets');
      req.result.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** Gets (or creates on first use) this device's AES-256-GCM key. */
async function getKey() {
  let key = await idb('keys', 'readonly', (s) => s.get('main'));
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb('keys', 'readwrite', (s) => s.put(key, 'main'));
  }
  return key;
}

async function encrypt(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // a fresh random IV every time
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), bytes);
  return { iv, data };
}

async function decrypt({ iv, data }) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await getKey(), data);
}

/** Save any JSON-able value, encrypted. (Encrypt first, then store - IndexedDB can't wait mid-transaction.) */
export async function saveSecret(name, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await encrypt(bytes);
  await idb('secrets', 'readwrite', (s) => s.put(sealed, name));
}

export async function loadSecret(name) {
  const sealed = await idb('secrets', 'readonly', (s) => s.get(name));
  if (!sealed) return null;
  return JSON.parse(new TextDecoder().decode(await decrypt(sealed)));
}

/** Save an uploaded file, encrypted. */
export async function saveFile(docId, file) {
  const sealed = await encrypt(await file.arrayBuffer());
  await idb('files', 'readwrite', (s) => s.put({ ...sealed, type: file.type, name: file.name }, docId));
}

/** Load a saved file back as a Blob (decrypted). */
export async function loadFile(docId) {
  const sealed = await idb('files', 'readonly', (s) => s.get(docId));
  if (!sealed) return null;
  return new Blob([await decrypt(sealed)], { type: sealed.type });
}

/** Deletes everything (used by "Reset demo"). */
export async function wipeVault() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
