/**
 * GET /api/health - tells the app whether the cloud AI (Engine B) is set up.
 * It never returns the key itself.
 */
import { aiSettings, sendJson } from '../lib/llm.js';

export default function handler(req, res) {
  const s = aiSettings();
  sendJson(res, 200, {
    ok: true,
    cloudAi: s.configured,
    provider: s.baseUrl.includes('groq.com') ? 'Groq' : s.baseUrl,
    preferredModel: s.models[0],
    time: new Date().toISOString()
  });
}
