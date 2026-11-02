# Remaining work (80% → 100%)

## Done for the 80% demo (week 1)
- Taxpayer portal: upload, read, mask, five agents, deterministic engine, refund meter, source highlighting, Copilot
- Accountant workspace: risk queue, side-by-side verification, overrides with justification, sign-off, audit dossier
- Sovereign Mode (no network) and dual-engine mode (Groq)
- Hash-chained audit ledger and an encrypted on-device vault
- 22 automated tests

## Weeks 2-3
1. **Real accounts and a database (Supabase, Sydney region, free plan)**
   - Supabase Auth email logins for taxpayers and accountants (FR-001/002)
   - Tables: `tenants`, `tax_profiles`, `ingested_documents`, `finalized_assessments`, `audit_log` (Capstone 1 Appendix A)
   - Accountants see their clients' submitted returns from any computer
   - The audit log moves to an append-only table
2. **Measure and evaluate** for the analysis report (LO3, LO4)
   - Time per document, with and without the cloud AI (NFR-008)
   - Masking recall on a set of test documents with known PII
   - Agreement rate between the AI agents and the on-device rules
   - OCR accuracy on 10 to 20 real receipt photos (with owners' permission)
3. **Polish:** XLSX upload, the actual cost method comparison, more asset types
4. **Documents:** analysis report (technical implementation document), user manual, e-poster, presentation

## Out of scope (explain in the report)
Rental property and investment calculations, LayoutLMv3, Electron desktop app, Docker/VPS deployment, ATO lodgement (needs DSP accreditation), billing (Stripe/Keygen).
