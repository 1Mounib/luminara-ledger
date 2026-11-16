/**
 * GET /api/config - what the Admin page needs to show: each agent's default
 * instructions and fixed reply format, the connectors, and whether the live
 * agents are reading the admin's settings from the database. No secrets.
 */
import { sendJson } from '../lib/llm.js';
import { DEFAULT_PROMPTS } from '../lib/prompts.js';
import { loadAiConfig } from '../lib/aiConfig.js';
import { CONNECTORS, DEFAULT_CONNECTOR_SETTINGS } from '../public/js/engine/connectors.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Use GET' });
  const cfg = await loadAiConfig({ fresh: true });
  return sendJson(res, 200, {
    prompts: DEFAULT_PROMPTS,
    connectors: CONNECTORS,
    defaultConnectors: DEFAULT_CONNECTOR_SETTINGS,
    live: { source: cfg.source, versions: cfg.versions, connectors: cfg.settings.connectors || null },
    mcp: { enabled: Boolean(process.env.MCP_TOKEN), path: '/api/mcp' }
  });
}
