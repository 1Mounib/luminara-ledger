/**
 * Short, checked facts the Copilot may quote. Kept here so answers are
 * grounded in real ATO rules rather than the model's memory.
 * Also used by the on-device Copilot when the cloud AI is off.
 */
export const KNOWLEDGE_ITEMS = [
  {
    topic: 'fixed rate',
    keywords: ['fixed', 'rate', '70', 'cents', 'method', 'wfh', 'home'],
    text: 'Fixed rate method (ATO, PCG 2023/1): claim 70 cents for each hour worked from home in 2024-25 and 2025-26. The rate covers electricity and gas, home and mobile internet and data, phone usage, and stationery and computer consumables, so these cannot also be claimed separately.'
  },
  {
    topic: 'records',
    keywords: ['record', 'timesheet', 'diary', 'evidence', 'proof', 'hours', 'keep'],
    text: 'Records: you must keep a record of the ACTUAL hours worked from home for the whole year (timesheet, roster or diary); estimates are not accepted. Also keep at least one bill for each type of expense the rate covers. Keep records for 5 years from lodging.'
  },
  {
    topic: 'depreciation',
    keywords: ['chair', 'desk', 'laptop', 'depreciat', 'decline', 'asset', 'equipment', 'furniture', '300'],
    text: 'Equipment and furniture (chairs, desks, computers) can be claimed separately from the fixed rate. Items costing $300 or less are claimed in full straight away (ITAA 1997 s 40-80(2)). Items over $300 are claimed over their effective life as "decline in value" (Division 40). Prime cost formula: cost x (days held / 365) x (1 / effective life) x work-use %.'
  },
  {
    topic: 'actual cost',
    keywords: ['actual', 'cost', 'dedicated', 'office', 'occupancy', 'rent', 'mortgage'],
    text: 'Actual cost method: claim the real extra costs of working from home, with detailed records of every expense and the work-use share. Occupancy costs (rent, mortgage interest, rates) are only claimable in limited cases such as a dedicated home office used as a place of business. This release uses the fixed rate method.'
  },
  {
    topic: 'tax rates',
    keywords: ['bracket', 'tax rate', 'how much tax', 'income tax', 'stage 3', '30%', '16%'],
    text: 'Resident tax rates 2025-26: 0% to $18,200; 16% to $45,000; $4,288 + 30% to $135,000; $31,288 + 37% to $190,000; $51,638 + 45% above. Medicare levy is generally 2% of taxable income. The low income tax offset (up to $700) phases out by $66,667.'
  },
  {
    topic: 'privacy',
    keywords: ['privacy', 'private', 'safe', 'secure', 'data', 'tfn', 'cloud', 'sovereign', 'mask'],
    text: 'Privacy: documents are read inside your browser. Before anything is sent to the cloud AI, your name, TFN, ABN, address, phone, email and account numbers are replaced with tokens such as <PII_TFN_1>. The real values stay on your device (Australian Privacy Principle 11). In Sovereign Mode nothing is sent at all.'
  },
  {
    topic: 'private health',
    keywords: ['health', 'insurance', 'surcharge', 'mls', 'medicare levy surcharge'],
    text: 'Medicare levy surcharge: singles earning above about $101,000 (2025-26) without private hospital cover may pay an extra 1% to 1.5%. Upload your private health insurance statement so your accountant can check this.'
  }
];

export const KNOWLEDGE = KNOWLEDGE_ITEMS.map((k) => `- ${k.text}`).join('\n');
