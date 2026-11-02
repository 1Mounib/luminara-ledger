# AI use log (for the reflective documentation VU requires)

VU requires AI-generated content to be flagged through reflective process documentation. Keep adding to this log as the project continues.

| Date | Tool | What the AI did | What the team did / checked |
|---|---|---|---|
| 2 Nov 2026 | Claude (Anthropic) | Proposed the architecture: static site plus Vercel functions, Engine A in the browser, Groq for Engine B. Wrote the first version of all code in `public/`, `api/`, `lib/`, `tests/`, the sample documents and these docs. | *Team to fill in:* reviewed each module, ran `npm test`, checked tax figures against the ATO website, tested on our own laptops. |
| | | | |

## Things the team verified by hand (fill in)
- [ ] 2025-26 tax brackets, LITO and Medicare thresholds against ato.gov.au
- [ ] The 70c/hour WFH rate and record-keeping rules against ato.gov.au
- [ ] Effective life of office chairs against ATO TR 2022/1 (currently 10 years, from Capstone 1 UC1)
- [ ] Each member can explain their module in the Q&A

## Reflection prompts for the report
- Where did AI help most, and where did it get things wrong?
- How did we stop the product's own AI from hallucinating? (the grounding check, and the deterministic engine)
- What did we change in AI-written code, and why?
