/**
 * TaxMate - LEVEL-2 PII MASKING (Engine A)
 * ------------------------------------------------
 * Runs in the user's browser BEFORE anything is sent to the cloud AI (NFR-002).
 * It swaps personal details for tokens, e.g.
 *     "TFN 123 456 782"  ->  "TFN <PII_TFN_1>"
 * and keeps the token -> real value map on the user's device only, so answers
 * coming back from the AI can be "re-hydrated" locally.
 *
 * Two layers, as in the Capstone 1 design:
 *  (a) Structured filter: patterns + checksums (TFN, ABN, card numbers, BSB,
 *      account numbers, emails, phone numbers).
 *  (b) Soft filter: names and addresses. Capstone 1 planned an XLM-RoBERTa
 *      model for this; this release uses labelled-field rules plus the
 *      taxpayer's own name, which runs instantly in any browser.
 */

/** TFN checksum: weights 1,4,3,7,5,8,6,9,10 - the weighted sum must divide by 11. */
export function isValidTFN(digits) {
  if (!/^\d{8,9}$/.test(digits)) return false;
  const weights = digits.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : [10, 7, 8, 4, 6, 3, 5, 1];
  const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * weights[i], 0);
  return sum % 11 === 0;
}

/** ABN checksum: subtract 1 from the first digit, weights 10,1,3,5,...,19 - must divide by 89. */
export function isValidABN(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const nums = [...digits].map(Number);
  nums[0] -= 1;
  return nums.reduce((acc, d, i) => acc + d * weights[i], 0) % 89 === 0;
}

/** Luhn check used by payment card numbers. */
export function isValidLuhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const onlyDigits = (s) => s.replace(/\D/g, '');

/**
 * The masking rules. Each rule finds text and decides if it is PII.
 * Order matters: longer numbers (cards, ABNs) are checked before TFNs, so the
 * last 9 digits of an ABN are never mistaken for a TFN.
 */
const STRUCTURED_RULES = [
  { type: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { type: 'CARD', pattern: /\b(?:\d[ -]?){13,19}\b/g, test: (m) => isValidLuhn(onlyDigits(m)) },
  { type: 'ABN', pattern: /\b\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g, test: (m) => isValidABN(onlyDigits(m)) },
  { type: 'TFN', pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{2,3}\b/g, test: (m) => isValidTFN(onlyDigits(m)) },
  { type: 'PHONE', pattern: /(?:\+61[ ]?|\b0)[2-478](?:[ -]?\d){8}\b/g },
  { type: 'BSB', pattern: /\bBSB[:#\s]*\d{3}-?\d{3}\b/gi, keepLabel: /^BSB[:#\s]*/i }
];

/** Soft PII: the value after a label like "Name:", and street addresses. */
const LABELLED_RULES = [
  { type: 'ACCOUNT', pattern: /\b(?:Account|Acct|Customer|Member|NMI|Service)\s*(?:No\.?|Number|#|ID)?[:#\s]+(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,}\b/gi, keepLabel: /^(?:Account|Acct|Customer|Member|NMI|Service)\s*(?:No\.?|Number|#|ID)?[:#\s]+/i },
  { type: 'TFN', pattern: /\b(?:TFN|Tax File Number)[:#\s]+[\d -]{8,11}\d/gi, keepLabel: /^(?:TFN|Tax File Number)[:#\s]+/i },
  { type: 'PERSON', pattern: /\b(?:Name|Employee|Payee|Customer name|Account name|Bill to|Billed to|Sold to)[:\s]+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3}/g, keepLabel: /^(?:Name|Employee|Payee|Customer name|Account name|Bill to|Billed to|Sold to)[:\s]+/ },
  { type: 'ADDRESS', pattern: /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Pl|Place|Cres|Crescent|Bvd|Boulevard|Lane|Ln|Way|Pde|Parade|Tce|Terrace)\b\.?(?:,?\s+[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?\s+(?:VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\s+\d{4})?/g }
];

/**
 * Creates a masking session. Use ONE session per taxpayer so the same value
 * always gets the same token (e.g. the same TFN on two documents = <PII_TFN_1>).
 *
 * @param {object} options { knownNames: ["Alex Nguyen"] } - the taxpayer's own name(s)
 */
export function createMaskingSession(options = {}) {
  const valueToToken = new Map();   // "123 456 782" -> "<PII_TFN_1>"
  const tokenToValue = new Map();   // "<PII_TFN_1>" -> "123 456 782"  (stays on device)
  const counters = {};
  const knownNames = (options.knownNames || []).filter((n) => n && n.trim().length > 1);

  // Numbers are compared by their digits only, so "123 456 782" and "123456782" match
  const keyFor = (type, value) =>
    `${type}:${['TFN', 'ABN', 'CARD', 'PHONE', 'BSB'].includes(type) ? onlyDigits(value) : value.trim().toLowerCase()}`;

  function tokenFor(type, value) {
    const key = keyFor(type, value);
    if (valueToToken.has(key)) return valueToToken.get(key);
    counters[type] = (counters[type] || 0) + 1;
    const token = `<PII_${type}_${counters[type]}>`;
    valueToToken.set(key, token);
    tokenToValue.set(token, value.trim());
    return token;
  }

  /**
   * Masks one piece of text.
   * @returns {{ text: string, found: {type:string, token:string}[] }}
   */
  function mask(text) {
    let output = String(text ?? '');
    const found = [];
    const apply = (rules) => {
      for (const rule of rules) {
        output = output.replace(rule.pattern, (match) => {
          if (match.includes('<PII_')) return match;           // already masked
          if (rule.test && !rule.test(match)) return match;    // failed checksum: not PII
          let label = '';
          let value = match;
          if (rule.keepLabel) {
            const m = match.match(rule.keepLabel);
            if (m) { label = m[0]; value = match.slice(label.length); }
          }
          const token = tokenFor(rule.type, value);
          found.push({ type: rule.type, token });
          return label + token;
        });
      }
    };

    // 1. Structured PII (emails, card numbers, ABN, TFN, phone, BSB)
    apply(STRUCTURED_RULES);

    // 2. The taxpayer's own name (full name first, then each part of it)
    for (const fullName of knownNames) {
      const parts = [fullName, ...fullName.split(/\s+/).filter((p) => p.length > 2)];
      for (const part of parts) {
        const re = new RegExp(`\\b${escapeRegex(part)}\\b`, 'gi');
        output = output.replace(re, (m) => {
          const token = tokenFor('PERSON', fullName === part ? m : fullName);
          found.push({ type: 'PERSON', token });
          return token;
        });
      }
    }

    // 3. Labelled fields and addresses
    apply(LABELLED_RULES);
    return { text: output, found };
  }

  /** Puts the real values back into text that came back from the AI (local de-masking). */
  function rehydrate(text) {
    return String(text ?? '').replace(/<PII_[A-Z]+_\d+>/g, (t) => tokenToValue.get(t) ?? t);
  }

  return {
    mask,
    rehydrate,
    /** The token map. Only ever stored encrypted on the user's device (see vault.js). */
    exportMap: () => Object.fromEntries(tokenToValue),
    importMap(map) {
      for (const [token, value] of Object.entries(map || {})) {
        tokenToValue.set(token, value);
        const type = token.match(/^<PII_([A-Z]+)_/)?.[1];
        if (type) {
          valueToToken.set(keyFor(type, value), token);
          const n = Number(token.match(/_(\d+)>$/)?.[1] || 0);
          counters[type] = Math.max(counters[type] || 0, n);
        }
      }
    },
    size: () => tokenToValue.size,
    /** Forgets all tokens (used when switching to a different return). */
    clear() { valueToToken.clear(); tokenToValue.clear(); for (const k of Object.keys(counters)) delete counters[k]; }
  };
}

/**
 * Last line of defence used by the SERVER before calling the AI:
 * returns the PII types still visible in a payload (should be none).
 */
export function detectUnmaskedPII(text) {
  const hits = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(/\b\d{3}[ -]?\d{3}[ -]?\d{2,3}\b/g)) if (isValidTFN(onlyDigits(m[0]))) hits.push('TFN');
  for (const m of s.matchAll(/\b\d{2}[ ]?\d{3}[ ]?\d{3}[ ]?\d{3}\b/g)) if (isValidABN(onlyDigits(m[0]))) hits.push('ABN');
  for (const m of s.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) if (isValidLuhn(onlyDigits(m[0]))) hits.push('CARD');
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(s)) hits.push('EMAIL');
  return [...new Set(hits)];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
