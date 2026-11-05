# Capstone 1 requirements → Capstone 2 build

Status: ✅ done · 🟡 partly done (with justification) · ⏳ planned (see ROADMAP) · ✖ out of scope for this release

| ID | Requirement (short) | Status | Where / how |
|---|---|---|---|
| FR-001 | Roles: taxpayer, accountant, admin | ✅ | Supabase Auth accounts. The role is decided by the database (an accountant needs the practice code) and enforced by Row Level Security (`supabase/schema.sql`, 17 attack tests). An admin role exists in the schema; there is no admin screen yet. |
| FR-002 | JWT sessions, lockout, idle lock | 🟡 | JWT sessions (Supabase) with automatic refresh, and sign-out after 30 minutes idle. Supabase rate-limits failed logins; there's no custom 5-attempt lockout. |
| FR-003 | PDF, image, CSV ingestion | ✅ | `extract.js`. XLSX is not supported yet. **New beyond Capstone 1:** import attachments from Gmail (read-only, user-selected, browser-direct, access revoked after; `gmail.js`). |
| FR-004 | UUID, SHA-256, encrypted storage, queue | ✅ | SHA-256 fingerprint as the document ID with duplicate detection, plus an AES-256-GCM encrypted file vault (`vault.js`). |
| FR-005 | Live status: ingest → parse → mask → swarm → ready | ✅ | Pipeline chips in panel 1. |
| FR-006 | Binarize, deskew | 🟡 | Tesseract does basic pre-processing. There's no custom deskew. |
| FR-007 | LayoutLMv3 segmentation | 🟡 | Replaced by pdf.js text-layer positions for PDFs and Tesseract for images. LayoutLMv3 needs a GPU server, which conflicts with free, in-browser hosting. |
| FR-008 | Bounding boxes on a 0-1000 scale | ✅ | Every line has `bbox`, and the viewer highlights it. |
| FR-009 | Flag OCR confidence below 85% | ✅ | `LOW_OCR_CONFIDENCE` flag. |
| FR-010 | Employment Income Agent | ✅ | Cloud and on-device versions. |
| FR-011 | Investment Income Agent | ✖ | Present in the swarm. It reports documents but doesn't calculate (WFH scope). |
| FR-012 | Rental Property Agent | ✖ | Same as above. |
| FR-013 | Deduction Agent (WFH, assets over $300) | ✅ | Fixed rate (70c), with immediate deduction or decline in value. |
| FR-014 | Compliance Agent, risk score | ✅ | Deterministic checks plus AI advisory notes. Risk score from 0 to 100. |
| FR-015 | Coordinator | ✅ | `coordinator.js` adds the hallucination guard and the disagreement flag. |
| FR-016 | No LLM arithmetic | ✅ | The AI even hands timesheet hours back for code to add up. |
| FR-017 | Brackets, LITO, Medicare, MLS, SAPTO | 🟡 | Brackets, LITO and Medicare are done. MLS is a flag only. SAPTO is out of scope. |
| FR-018 | Rules in versioned JSON | ✅ | `public/rules/fy2025-26.json`, `fy2024-25.json`. |
| FR-019 | Taxpayer dashboard, refund meter, risk meter | ✅ | Panel 2. |
| FR-020 | Accountant queue sorted by risk | ✅ | `accountant.html`. |
| FR-021 | Side-by-side source highlighting | ✅ | Hover a field and its source line is highlighted. |
| FR-022 | ATO XML and PDF audit dossier | 🟡 | Printable audit dossier and JSON export. ATO XML (SBR) needs DSP accreditation. |
| FR-023 | Copilot explains and cites law | ✅ | Cloud and on-device modes. |
| FR-024 | Active capture of missing documents | ✅ | Copilot nudges with an upload button. |
| NFR-001 | Local-only mode | ✅ | Sovereign Mode makes zero network calls (verified in testing). |
| NFR-002 | Level-2 PII masking + encrypted map | ✅ | Checksums, labelled fields and an AES-GCM token map. The NER model is replaced by rules. |
| NFR-003 | AES-256 at rest, TLS in transit | ✅ | Vault on the device. Vercel serves HTTPS. |
| NFR-004 | Secrets separate from code | ✅ | Vercel environment variables. |
| NFR-005 | 99.9% availability | 🟡 | Vercel hosting, plus fallback to on-device agents if the AI is down. |
| NFR-007 | Plain-language errors | ✅ | Toasts and flags. |
| NFR-008 | ≤45 s per document | ✅ | To be measured in the analysis report. |
| NFR-010 | Source lineage for every value | ✅ | "Source" chips. |
| NFR-011 | Override with justification, audit | ✅ | Justification is required. The ledger records the field, old and new values, user, time and refs. |
| NFR-012 | Immutable audit log, 12 months | ✅ | `audit_log` table: append-only (no update or delete for any user), with the SHA-256 chain computed by the database and `verify_audit_chain()`. Retention is the database's (no automatic deletion). |
| NFR-013 | One-command Docker on VPS | ✖ | Replaced by Vercel git deploy, which is simpler for the client and free. |
| NFR-014 | nomic-embed-text embeddings | ✖ | Not needed for the WFH scope. |
