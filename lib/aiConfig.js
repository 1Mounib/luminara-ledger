/**
 * Reads the admin's AI settings from the database for the cloud functions:
 *   - the latest version of each agent's instructions (ai_prompts)
 *   - which connectors each agent may use (ai_settings "connectors")
 * Both tables are readable with the public key (they hold no personal data).
 * Cached for 30 seconds; if the database can't be reached the defaults in
 * code are used, so the agents always keep working.
 */
import { SUPABASE_URL, SUPABASE_KEY } from '../public/js/config.js';
import { DEFAULT_PROMPTS } from './prompts.js';

const TTL = 30_000;
let cache = null;
let cachedAt = 0;

export async function loadAiConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL) return cache;
  const out = { prompts: {}, versions: {}, settings: {}, source: 'defaults' };
  const base = process.env.TAXMATE_SUPABASE_URL || SUPABASE_URL;
  if (base && SUPABASE_KEY && process.env.TAXMATE_CONFIG !== 'off') {
    try {
      const get = async (path) => {
        const res = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, signal: AbortSignal.timeout(2500) });
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      };
      const [prompts, settings] = await Promise.all([
        get('ai_prompts?select=id,agent,instructions,created_at,created_by_name&order=id.desc&limit=300'),
        get('ai_settings?select=key,value')
      ]);
      for (const p of prompts) {
        if (!out.prompts[p.agent] && DEFAULT_PROMPTS[p.agent]) {
          out.prompts[p.agent] = p.instructions;
          out.versions[p.agent] = p.id;
        }
      }
      for (const s of settings) out.settings[s.key] = s.value;
      out.source = 'database';
    } catch {
      // tables not created yet, or offline: keep the defaults
    }
  }
  cache = out;
  cachedAt = Date.now();
  return out;
}

/** The instructions an admin set for this agent, or the default. */
export function instructionsFor(cfg, key) {
  return (cfg?.prompts?.[key] || DEFAULT_PROMPTS[key].instructions).trim();
}

/** Full system prompt: the (editable) instructions plus the fixed reply format. */
export function buildPrompt(cfg, key) {
  return `${instructionsFor(cfg, key)}\n${DEFAULT_PROMPTS[key].format}`;
}

/** For tests. */
export function resetAiConfigCache() { cache = null; cachedAt = 0; }
