# Luminara Ledger: Capstone 2 build

**Sovereign dual-engine AI tax assistant.** This release covers Use Case 1: a salaried employee claiming work-from-home deductions.
NIT3004 IT Capstone Project 2, Victoria University · Luminara Digital team.

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

## Project layout

```
public/                  the website (served as-is, no build step)
  index.html             landing page + sign in
  app.html               taxpayer portal (3 panels: documents | tax position | copilot)
  accountant.html        accountant queue, side-by-side verification, audit ledger
  rules/fy2025-26.json   ALL tax numbers live here, not in code (FR-018)
  samples/               fictional demo documents for Use Case 1
  js/engine/             the core logic (pure JavaScript, unit tested)
    extract.js           Engine A: read PDF / CSV / image (OCR) with bounding boxes
    redact.js            Engine A: Level-2 PII masking + checksums (TFN, ABN, Luhn)
    localAgents.js       the 5 agents as on-device rules (Sovereign Mode + fallback)
    coordinator.js       merges cloud + local results, hallucination guard
    taxEngine.js         deterministic tax calculation
    auditLedger.js       tamper-evident SHA-256 hash chain
    vault.js             AES-256-GCM encrypted storage on the device
  js/ui/                 page code (taxpayer, accountant, copilot, viewer)
  vendor/pdfjs/          pdf.js (Mozilla, Apache-2.0), self-hosted
api/                     Engine B: Vercel serverless functions
  agents.js              POST: five parallel AI agents (masked data only)
  copilot.js             POST: plain-English explanations
  health.js              GET: is the cloud AI configured?
lib/llm.js               talks to Gemini or Groq (or any OpenAI-compatible API, e.g. Ollama)
supabase/schema.sql      the database: tables, security rules, hash-chained audit log
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

There are 22 tests, plus 17 database security tests in `supabase/test-security.sh`. They cover the tax engine against hand-worked ATO examples, PII masking, the full sample pipeline (which must give exactly $806.68 in deductions and a $400.24 refund), audit-ledger tamper detection, and the hallucination guard.

## Deploy

See **[docs/DEPLOY.md](docs/DEPLOY.md)**. It uses GitHub and Vercel, both free.

## Environment variables (set in Vercel, never in code)

| Name | Needed? | What |
|---|---|---|
| `GEMINI_API_KEY` | for cloud AI (option 1) | key from aistudio.google.com, used first if set |
| `GROQ_API_KEY` | for cloud AI (option 2) | key from console.groq.com |
| `AI_MODEL` | optional | force a model name (otherwise the app tries a list of current models, then asks the provider) |
| `AI_BASE_URL` | optional | use another OpenAI-compatible provider, e.g. `http://localhost:11434/v1` for Ollama |

Without a key, the site still works fully using the on-device agents.
