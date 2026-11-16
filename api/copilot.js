/**
 * POST /api/copilot - the conversational assistant (FR-023, FR-024)
 * ----------------------------------------------------------------
 * Explains the result in plain English. It receives the calculated figures
 * (from the deterministic engine) and masked document facts - never raw
 * documents - and must NOT invent or recalculate numbers.
 */
import { chat, aiSettings, sendJson } from '../lib/llm.js';
import { detectUnmaskedPII } from '../public/js/engine/redact.js';
import { KNOWLEDGE } from '../public/js/engine/knowledge.js';
import { loadAiConfig, buildPrompt } from '../lib/aiConfig.js';
import { enabledConnectors } from '../public/js/engine/connectors.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
  if (!aiSettings().configured) return sendJson(res, 503, { error: 'Cloud AI is not set up.' });

  const { question, context, history } = req.body || {};
  if (!question || typeof question !== 'string') return sendJson(res, 400, { error: 'No question received.' });

  const payload = JSON.stringify({ question, context, history });
  if (payload.length > 40000) return sendJson(res, 413, { error: 'Conversation too long. Start a new chat.' });
  const leaked = detectUnmaskedPII(payload);
  if (leaked.length) return sendJson(res, 422, { error: `Blocked at the privacy boundary: unmasked ${leaked.join(', ')}.`, blocked: leaked });

  // Instructions from the Admin page (or the default); the ATO rules library is a connector the admin can switch off
  const cfg = await loadAiConfig();
  const rulesOn = enabledConnectors(cfg.settings, 'copilot').includes('lookup_rule');
  const system = `${buildPrompt(cfg, 'copilot')}${rulesOn ? `\n\nKNOWLEDGE:\n${KNOWLEDGE}` : ''}`;

  const messages = [
    { role: 'system', content: system },
    { role: 'system', content: `CONTEXT (from the rules engine and agents):\n${String(context || 'No documents processed yet.').slice(0, 12000)}` },
    ...(Array.isArray(history) ? history.slice(-8) : []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) })),
    { role: 'user', content: question.slice(0, 2000) }
  ];

  try {
    const reply = await chat(messages, { maxTokens: 600 });
    return sendJson(res, 200, { reply: reply.text, model: reply.model, ms: reply.ms });
  } catch (error) {
    return sendJson(res, 502, { error: `The AI service did not answer (${error.message}).` });
  }
}
