# TaxMate: Capstone 2 build

**Sovereign dual-engine AI tax assistant.** This release covers Use Case 1: a salaried employee claiming work-from-home deductions.
NIT3004 IT Capstone Project 2, Victoria University · TaxMate Development team.

> Student prototype. It gives estimates only, it isn't tax advice, and it isn't connected to the ATO. All sample documents are fictional.

---

## What it does

1. **Upload** an income statement, a WFH timesheet (CSV), receipts and bills. PDFs, CSVs and receipt photos all work.
2. **Engine A (inside the browser)** reads every line along with its position on the page. It then masks the TFN, ABN, name, address, email, phone and account numbers, replacing them with tokens like `<PII_TFN_1>`.
3. **Engine B (cloud AI on Google Gemini or Groq)** runs five specialist agents in parallel. They see only the masked text.
4. **The coordinator** checks every AI number against the source line it cites (the hallucination guard), and compares it with the on-device rules.
5. **The deterministic tax engine** does all the maths: the 2025-26 brackets, Medicare levy, LITO, the 70c/hour fixed rate, and decline in value.
6. **The accountant** reviews the result side by side with the source documents, overrides values (a justification is required), and signs off. Every action goes into a **hash-chained audit ledger**.

**Accounts:** taxpayers and accountants sign in with real accounts (Supabase Auth, Sydney region). Row Level Security decides who sees what: taxpayers see only their own return, and accountants see the practice's queue. Becoming an accountant needs a practice code. The database stores masked data only. The original files and the real names, TFN and so on stay encrypted on the taxpayer's device. There is also an **Offline demo** tab (no account, this browser only).

**Sovereign Mode** (the toggle in the top bar) keeps all AI on the device: no document text goes to the cloud AI.

## The agents (updated 16 Nov 2026)

TaxMate supports a registered tax agent; it doesn't replace one. The AI agents do the reading, sorting and first judgement, the rules engine does the maths, and the accountant decides.

| Agent | What it decides or does |
| --- | --- |
| Document Triage Agent | Works out what each document is and routes it to the right specialist |
| Employment Income Agent | Finds salary and tax withheld, citing the line |
| Deduction Extraction Agent | Finds hours, equipment and bills, decides how each is claimed, and asks the taxpayer when work use is unclear |
| Investment / Rental agents | Report those documents (out of scope for calculation) |
| Tax Compliance Agent | Flags what the ATO would question and scores audit risk |
| Coordinator | Checks every AI value against its source line and against the on-device rules |
| Review Agent (accountant) | Uses tools (read a document, re-run the rules engine "what if", look up an ATO rule) to recommend approve, adjust or ask the client, with a draft message |

## Admin settings (added 16 Nov 2026)

An **admin** account gets an Admin settings page (`/admin.html`) with four tabs:

| Tab | What the admin can do |
| --- | --- |
| Agent instructions | Edit each agent's prompt without changing code. Every version is kept (who, when, why) and can be restored. The live agents read the newest version from the database within 30 seconds. The reply format stays in code so the app can always read the answer. |
| Connectors | Switch tools and data sources on or off per agent (document reader, rules engine "what if", ATO rules library, Gmail import, and what the MCP address offers). New functionality is added by registering one more connector in `connectors.js`. |
| AI performance | Success rate, fall-back rate, speed and steps per agent; how often the coordinator found the AI's values in the document and how often the two engines agreed; which instruction version each run used. Numbers only, never document text. |
| MCP address | TaxMate's tools as an MCP server at `/api/mcp` (`calculate_tax`, `lookup_rule`) for other AI apps, protected by the `MCP_TOKEN` key. Only tools that need no personal data are offered. |

Only an admin can change these: the database's security rules enforce it (`supabase/admin.sql`, 20 attack tests). To make an account an admin, run the `update ... set role = 'admin'` line at the top of `supabase/admin.sql` in the Supabase SQL editor.

Each figure shows its **validation checks** (found in the document, two engines agree, ATO rule applied, looks reasonable, taxpayer answered, accountant approved). Every agent's steps are shown in **What the agents did**.

## Project layout

```
public/                  the website (served as-is, no build step)
  index.html             landing page + sign in
  app.html               taxpayer portal (3 panels: documents | tax position | copilot)
  accountant.html        accountant queue, side-by-side verification, audit ledger
  admin.html             admin settings: agent instructions, connectors, AI performance, MCP
  rules/fy2025-26.json   ALL tax numbers live here, not in code (FR-018)
  samples/               fictional demo documents for Use Case 1
  js/engine/             the core logic (pure JavaScript, unit tested)
    extract.js           Engine A: read PDF / CSV / image (OCR) with bounding boxes
    redact.js            Engine A: Level-2 PII masking + checksums (TFN, ABN, Luhn)
    localAgents.js       the agents as on-device rules (Sovereign Mode + fallback)
    reviewAgent.js       the accountant's tool-using Review Agent
    connectors.js        the tools each agent may use (switched on/off by the admin)
    monitoring.js        AI performance rows and dashboard numbers
    coordinator.js       merges cloud + local results, hallucination guard
    taxEngine.js         deterministic tax calculation
    auditLedger.js       tamper-evident SHA-256 hash chain
    vault.js             AES-256-GCM encrypted storage on the device
  js/ui/                 page code (taxpayer, accountant, copilot, viewer)
  vendor/pdfjs/          pdf.js (Mozilla, Apache-2.0), self-hosted
api/                     Engine B: Vercel serverless functions
  agents.js              POST: triage, then the specialist AI agents (masked data only)
  review.js              POST: the Review Agent's tool loop (masked data only)
  copilot.js             POST: plain-English explanations
  config.js              GET: default instructions and connectors for the Admin page
  mcp.js                 POST: MCP server (JSON-RPC) offering calculate_tax and lookup_rule
  health.js              GET: is the cloud AI configured?
lib/llm.js               talks to Gemini or Groq (or any OpenAI-compatible API, e.g. Ollama)
lib/prompts.js           each agent's default instructions + fixed reply format
lib/aiConfig.js          reads the admin's instructions and connectors from the database
supabase/schema.sql      the database: tables, security rules, hash-chained audit log
supabase/admin.sql       admin tables: prompt versions, settings, AI runs (run after schema.sql)
supabase/test-security.sh 17 attack tests for the security rules (run on a local Postgres)
public/js/cloud.js       sign-in and database calls (plain fetch, no library)
public/js/config.js      Supabase URL + publishable key (public by design)
tests/                   automated tests (node --test)
scripts/                 dev server + sample generator
docs/                    deployment guide, AI-use log, roadmap, requirements trace
```

## Run it on your own computer (optional)

You need [Node.js](https://nodejs.org) 20 or newer. There's nothing else to install.

```
node scripts/dev-server.mjs
```

Then open http://localhost:3000. To use the cloud AI locally, create a file called `.env` containing `GEMINI_API_KEY=your-key`.

## Run the tests

```
npm install      (once - installs pdf.js for the document test)
npm test
```

There are 43 tests, plus 17 database security tests in `supabase/test-security.sh` and 20 for the admin tables. They cover the admin features (prompt versions and defaults, connectors, the MCP server, monitoring maths),  the tax engine against hand-worked ATO examples, PII masking, the full sample pipeline (which must give exactly $806.68 in deductions and a $400.24 refund), audit-ledger tamper detection, and the hallucination guard.

## Deploy

See **[docs/DEPLOY.md](docs/DEPLOY.md)**. It uses GitHub and Vercel, both free.

## Environment variables (set in Vercel, never in code)

| Name | Needed? | What |
|---|---|---|
| `GEMINI_API_KEY` | for cloud AI (option 1) | key from aistudio.google.com, used first if set |
| `GROQ_API_KEY` | for cloud AI (option 2) | key from console.groq.com |
| `AI_MODEL` | optional | force a model name (otherwise the app tries a list of current models, then asks the provider) |
| `AI_BASE_URL` | optional | use another OpenAI-compatible provider, e.g. `http://localhost:11434/v1` for Ollama |
| `MCP_TOKEN` | optional | turns on the MCP address `/api/mcp`; clients send it as `Authorization: Bearer ...` (mark it Sensitive) |

Without a key, the site still works fully using the on-device agents.
