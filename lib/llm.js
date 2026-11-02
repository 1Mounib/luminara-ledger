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
    native: true, // uses Google's own API so "thinking" can be switched off (much faster)
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // Tried in order (fast models first). If none exist, the app asks Google which models the key can use.
    models: ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'],
    extra: {},
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
    apiKey, baseUrl, models, extra: custom ? {} : p.extra, maxTokens: p.maxTokens, native: !custom && Boolean(p.native),
    provider: custom ? baseUrl : p.name,
    configured: Boolean(apiKey) || isLocal
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Asks the provider which models this key can use (backup if our list is out of date). */
export async function discoverModels(s = aiSettings()) {
  try {
    const res = s.native
      ? await fetch(`${s.baseUrl}/models?pageSize=200`, { headers: { 'x-goog-api-key': s.apiKey } })
      : await fetch(`${s.baseUrl}/models`, { headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {} });
    if (!res.ok) return [];
    const data = await res.json();
    if (s.native) {
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((id) => /flash/i.test(id) && !/image|embed|tts|audio|live|vision|preview-\d{2}-\d{2}/i.test(id));
    }
    return (data.data || [])
      .map((m) => String(m.id).replace(/^models\//, ''))
      .filter((id) => /flash|llama|gpt|qwen|gemma/i.test(id) && !/image|embed|tts|audio|live|vision|guard|whisper/i.test(id));
  } catch {
    return [];
  }
}

let workingModel = null;

/**
 * One HTTP request to the provider. Returns { ok, status, content, errorText }.
 * "simple" = leave out optional settings (used when a provider rejects them).
 */
async function send(s, model, messages, options, simple, signal) {
  let res;
  if (s.native) {
    // Google's own Gemini API
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const generationConfig = {
      temperature: 0,
      maxOutputTokens: options.maxTokens || s.maxTokens,
      ...(options.json ? { responseMimeType: 'application/json' } : {}),
      ...(simple ? {} : { thinkingConfig: { thinkingBudget: 0 } }) // no "thinking" = fast answers
    };
    res = await fetch(`${s.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
      body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig })
    });
    if (!res.ok) return { ok: false, status: res.status, errorText: await res.text() };
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return { ok: true, status: 200, content: parts.filter((p) => !p.thought).map((p) => p.text || '').join('') };
  }
  // OpenAI-compatible APIs (Groq, Ollama, ...)
  res = await fetch(`${s.baseUrl}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({
      model, messages,
      temperature: 0, // same input -> same answer, as far as possible
      max_tokens: options.maxTokens || s.maxTokens,
      ...(simple ? {} : s.extra),
      ...(options.json && !simple ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!res.ok) return { ok: false, status: res.status, errorText: await res.text() };
  const data = await res.json();
  return { ok: true, status: 200, content: data.choices?.[0]?.message?.content || '' };
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
  // A model that answered before goes first (Vercel keeps warm functions for a while)
  let models = [...new Set([workingModel, ...s.models].filter(Boolean))];
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
        const response = await send(s, model, messages, options, simple, controller.signal);
        if (response.ok) {
          const text = response.content;
          if (!text && !simple) { simple = true; continue; } // empty answer: try again plainly
          workingModel = model;
          return { text, model, ms: Date.now() - started, skipped: attempts };
        }
        const errText = response.errorText.slice(0, 300);
        lastError = new Error(`${s.provider} returned ${response.status}: ${errText}`);
        attempts.push(`${model}: HTTP ${response.status} ${errText.slice(0, 120)}`);
        if (response.status === 401 || response.status === 403 || /api key not valid|API_KEY_INVALID/i.test(errText)) throw lastError; // bad key: stop
        if (response.status === 429) { await wait(2500); continue; }          // busy: wait, retry
        if ([400, 404].includes(response.status) && /model|not found/i.test(errText) && !/response_format|reasoning|thinking|mime/i.test(errText)) break; // unknown model: next one
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
      const extra = (await discoverModels(s)).filter((m) => !models.includes(m)).slice(0, 3);
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
