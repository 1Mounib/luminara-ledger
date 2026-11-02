/**
 * GET /api/health          - is the cloud AI (Engine B) set up?
 * GET /api/health?ping=1   - also sends one tiny test message to the AI and
 *                            reports which model answered (for troubleshooting).
 * It never returns the key itself.
 */
import { aiSettings, chat, sendJson } from '../lib/llm.js';

export default async function handler(req, res) {
  const s = aiSettings();
  const out = {
    ok: true,
    cloudAi: s.configured,
    provider: s.provider,
    preferredModel: s.models[0] || null,
    time: new Date().toISOString()
  };
  const wantsPing = /[?&]ping=1/.test(req.url || '');
  if (wantsPing && s.configured) {
    try {
      const reply = await chat([{ role: 'user', content: 'Reply with the single word: ready' }], { timeoutMs: 4000, deadlineMs: 9000 });
      out.ping = { ok: true, model: reply.model, ms: reply.ms, reply: reply.text.slice(0, 40) };
    } catch (error) {
      out.ping = { ok: false, error: error.message, attempts: error.attempts || [] };
    }
  }
  sendJson(res, 200, out);
}
