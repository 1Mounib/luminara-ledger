/**
 * TaxMate - CONNECTORS (the tools agents can use)
 * -------------------------------------------------------
 * Every capability an agent can call is a "connector" listed here. An admin
 * turns connectors on or off per agent in the Admin page (stored in the
 * ai_settings table), so new functionality is added by registering a
 * connector - not by rewriting the agents. The same connectors are offered
 * to outside AI tools through the MCP address /api/mcp.
 */
export const CONNECTORS = [
  {
    id: 'read_document', name: 'Document reader', kind: 'tool', agents: ['review'], mcp: false,
    description: 'Reads the masked lines of one of the return\'s documents.',
    args: '{"docId": "..."}'
  },
  {
    id: 'recalculate', name: 'Rules engine ("what if")', kind: 'tool', agents: ['review', 'mcp'], mcp: true,
    description: 'Re-runs the deterministic tax engine with changed figures and returns the new totals.',
    args: '{"wfhHours": number, "salary": number, "taxWithheld": number, "assetWorkUse": {"<asset id>": percent}}'
  },
  {
    id: 'lookup_rule', name: 'ATO rules library', kind: 'tool', agents: ['review', 'copilot', 'mcp'], mcp: true,
    description: 'Returns the checked ATO rule text for a topic (fixed rate, records, depreciation...).',
    args: '{"topic": "..."}'
  },
  {
    id: 'gmail', name: 'Gmail (read-only import)', kind: 'source', agents: ['taxpayer'], mcp: false,
    description: 'Lets taxpayers import invoice and statement attachments from Gmail.'
  }
];

/** What is switched on when no admin has changed anything. */
export const DEFAULT_CONNECTOR_SETTINGS = {
  review: ['read_document', 'recalculate', 'lookup_rule'],
  copilot: ['lookup_rule'],
  taxpayer: ['gmail'],
  mcp: ['recalculate', 'lookup_rule']
};

/** The connector ids switched on for one agent. */
export function enabledConnectors(settings, agent) {
  const chosen = settings?.connectors?.[agent] ?? DEFAULT_CONNECTOR_SETTINGS[agent] ?? [];
  return chosen.filter((id) => CONNECTORS.some((c) => c.id === id && c.agents.includes(agent)));
}
