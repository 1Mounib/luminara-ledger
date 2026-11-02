/**
 * Talks to the cloud language model (Engine B).
 *
 * Works with any "OpenAI-compatible" chat API. The default is Groq.
 * Settings come from environment variables (set in Vercel -> Settings ->
 * Environment Variables), never from the code (Capstone 1: NFR-004):
 *
 *   GROQ_API_KEY   your Groq key                      (required for cloud AI)
 *   AI_MODEL       model name                         (optional)
 *   AI_BASE_URL    another provider's address,        (optional)
 *                  e.g. http://localhost:11434/v1 for Ollama on your own computer
 */

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
// Tried in order; if Groq retires one model the next one is used.
const DEFAULT_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'];

export function aiSettings() {
  const apiKey = process.env.GROQ_API_KEY || process.env.AI_API_KEY || '';
  const baseUrl = (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const models = process.env.AI_MODEL ? [process.env.AI_MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS;
  const isLocal = /localhost|127\.0\.0\.1/.test(baseUrl);
  return { apiKey, baseUrl, models, configured: Boolean(apiKey) || isLocal };
}

/**
 * Sends one chat request and returns the model's reply.
 * @param {object[]} messages  [{ role: 'system'|'user'|'assistant', content }]
 * @param {object} options     { json: true } to ask for a JSON reply
 * @returns {Promise<{ text: string, model: string, ms: number }>}
 */
export async function chat(messages, options = {}) {
  const { apiKey, baseUrl, models } = aiSettings();
  let lastError;
  for (const model of models) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,          // same input -> same answer, as far as possible
          max_tokens: options.maxTokens || 1500,
          ...(options.json ? { response_format: { type: 'json_object' } } : {})
        })
      });
      if (!response.ok) {
        const body = await response.text();
        lastError = new Error(`AI provider returned ${response.status}: ${body.slice(0, 200)}`);
        // 400/404 usually means this model name is not available - try the next one
        if ([400, 404].includes(response.status) && /model/i.test(body)) continue;
        throw lastError;
      }
      const data = await response.json();
      return { text: data.choices?.[0]?.message?.content || '', model, ms: Date.now() - started };
    } catch (error) {
      lastError = error.name === 'AbortError' ? new Error('AI provider timed out') : error;
      if (!/model/i.test(lastError.message)) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('No AI model available');
}

/** Pulls the first JSON object out of a reply, even if the model added extra words. */
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
