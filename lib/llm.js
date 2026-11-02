/**
 * Talks to the cloud language model (Engine B).
 *
 * Works with any "OpenAI-compatible" chat API. Settings come from environment
 * variables (Vercel -> Settings -> Environment Variables), never from the code
 * (Capstone 1: NFR-004). Set ONE of these keys:
 *
 *   GEMINI_API_KEY  Google Gemini key from aistudio.google.com   (used first)
 *   GROQ_API_KEY    Groq key from console.groq.com
 *
 * Optional:
 *   AI_MODEL        force a model name
 *   AI_BASE_URL     another OpenAI-compatible provider, e.g.
 *                   http://localhost:11434/v1 for Ollama on your own computer
 */

const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Tried in order. "gemini-flash-latest" is Google's alias for the current Flash model.
    models: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest'],
    extra: { reasoning_effort: 'low' }, // keep "thinking" short so answers are fast
    maxTokens: 4000
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    extra: {},
    maxTokens: 1500
  }
};

export function aiSettings() {
  const env = process.env;
  const kind = env.GEMINI_API_KEY ? 'gemini' : 'groq';
  const p = PROVIDERS[kind];
  const apiKey = env.GEMINI_API_KEY || env.GROQ_API_KEY || env.AI_API_KEY || '';
  const baseUrl = (env.AI_BASE_URL || p.baseUrl).replace(/\/$/, '');
  const custom = Boolean(env.AI_BASE_URL);
  const models = [env.AI_MODEL, ...(custom ? [] : p.models)].filter(Boolean);
  const isLocal = /localhost|127\.0\.0\.1/.test(baseUrl);
  return {
    apiKey, baseUrl, models, extra: custom ? {} : p.extra, maxTokens: p.maxTokens,
    provider: custom ? baseUrl : p.name,
    configured: Boolean(apiKey) || isLocal
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Asks the provider which models this key can use (backup if our list is out of date). */
async function discoverModels(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .map((m) => String(m.id).replace(/^models\//, ''))
      .filter((id) => /flash|llama|gpt|qwen|gemma/i.test(id) && !/image|embed|tts|audio|live|vision|guard|whisper/i.test(id));
  } catch {
    return [];
  }
}

/**
 * Sends one chat request and returns the model's reply.
 * Tries each model in turn; if a model name is unknown it moves to the next,
 * and if the provider rejects an optional setting it retries without it.
 * @param {object[]} messages  [{ role: 'system'|'user'|'assistant', content }]
 * @param {object} options     { json: true } to ask for a JSON reply
 * @returns {Promise<{ text: string, model: string, ms: number }>}
 */
export async function chat(messages, options = {}) {
  const s = aiSettings();
  let lastError = new Error('No AI model available');
  let models = [...s.models];
  let discovered = false;
  const deadline = Date.now() + (options.deadlineMs || 25000); // never run past Vercel's time limit
  const attempts = []; // what happened with each model (shown by /api/health?ping=1)

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (Date.now() > deadline - 1500) break;
    let simple = false; // true = retry without optional settings
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const left = deadline - Date.now();
      if (left < 1500) break;
      const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs || 20000, left));
      try {
        const body = {
          model,
          messages,
          temperature: 0, // same input -> same answer, as far as possible
          max_tokens: options.maxTokens || s.maxTokens,
          ...(simple ? {} : s.extra),
          ...(options.json && !simple ? { response_format: { type: 'json_object' } } : {})
        };
        const response = await fetch(`${s.baseUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
          body: JSON.stringify(body)
        });
        if (response.ok) {
          const data = await response.json();
          const text = data.choices?.[0]?.message?.content || '';
          if (!text && !simple) { simple = true; continue; } // empty answer: try again plainly
          return { text, model, ms: Date.now() - started };
        }
        const errText = (await response.text()).slice(0, 300);
        lastError = new Error(`${s.provider} returned ${response.status}: ${errText}`);
        attempts.push(`${model}: HTTP ${response.status} ${errText.slice(0, 120)}`);
        if (response.status === 401 || response.status === 403) throw lastError; // bad key: stop
        if (response.status === 429) { await wait(2500); continue; }          // busy: wait, retry
        if ([400, 404].includes(response.status) && /model/i.test(errText) && !/response_format|reasoning/i.test(errText)) break; // unknown model: next one
        if (response.status === 400 && !simple) { simple = true; continue; }   // optional setting rejected
        break;
      } catch (error) {
        if (error === lastError) throw error;
        lastError = error.name === 'AbortError' ? new Error(`${s.provider} timed out`) : error;
        attempts.push(`${model}: ${lastError.message}`);
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    // Ran out of our own list: ask the provider what it has, once
    if (i === models.length - 1 && !discovered) {
      discovered = true;
      if (Date.now() > deadline - 4000) break;
      const extra = (await discoverModels(s.baseUrl, s.apiKey)).filter((m) => !models.includes(m)).slice(0, 3);
      models = models.concat(extra);
    }
  }
  lastError.attempts = attempts;
  throw lastError;
}

/** Pulls the first JSON object out of a reply, even if the model added extra words or ``` fences. */
export function parseJsonReply(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/** Minimal helper so handlers read the same in Vercel and in the local dev server. */
export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
