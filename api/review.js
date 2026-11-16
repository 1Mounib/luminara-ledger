/**
 * POST /api/review - the accountant's Review Agent (cloud version)
 * -----------------------------------------------------------------
 * A tool-using AI agent: Gemini chooses a tool (read a document, re-run the
 * rules engine with changed figures, look up an ATO rule), sees the result,
 * and decides the next step, until it gives a recommendation. Every step is
 * returned so the accountant can see how it reached its advice.
 *
 * Receives ONLY masked data. The accountant still decides; the agent advises.
 */
import { chat, aiSettings, sendJson } from '../lib/llm.js';
import { detectUnmaskedPII } from '../public/js/engine/redact.js';
import { makeReviewTools, reviewBrief, runReviewLoop } from '../public/js/engine/reviewAgent.js';
import { loadAiConfig, instructionsFor } from '../lib/aiConfig.js';
import { enabledConnectors } from '../public/js/engine/connectors.js';
import { fetchRules } from '../lib/rules.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
  if (!aiSettings().configured) return sendJson(res, 503, { error: 'Cloud AI is not set up. The on-device review agent will be used.' });

  const body = req.body || {};
  const leaked = detectUnmaskedPII(JSON.stringify(body));
  if (leaked.length) return sendJson(res, 422, { error: `Blocked at the privacy boundary: unmasked ${leaked.join(', ')} found. Nothing was sent to the AI.` });
  if (!body.facts || !Array.isArray(body.items)) return sendJson(res, 400, { error: 'Send the return\'s facts and masked lines.' });

  let rules;
  try {
    rules = await fetchRules(req, body.financialYear || '2025-26');
  } catch (error) {
    return sendJson(res, 500, { error: `Could not load the tax rules: ${error.message}` });
  }

  const items = body.items.slice(0, 1500);
  const cfg = await loadAiConfig();
  const tools = makeReviewTools({ facts: body.facts, items, documents: body.documents || [], rules, enabled: enabledConnectors(cfg.settings, 'review') });
  const brief = reviewBrief({ facts: body.facts, result: body.result, flags: body.flags, questions: body.questions, answers: body.answers, documents: body.documents, tally: body.tally });
  const started = Date.now();
  try {
    const out = await runReviewLoop({
      ask: (messages) => chat(messages, { json: true, timeoutMs: 9000, deadlineMs: 10000 }),
      tools, brief, maxSteps: 6, instructions: instructionsFor(cfg, 'review'), timeLeft: () => 26000 - (Date.now() - started)
    });
    if (!out.review) return sendJson(res, 502, { error: 'The review agent did not finish.', trace: out.trace });
    return sendJson(res, 200, { ...out, ms: Date.now() - started, promptVersion: cfg.versions.review ?? null });
  } catch (error) {
    return sendJson(res, 502, { error: `Review agent failed: ${error.message}` });
  }
}
