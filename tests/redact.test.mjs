/**
 * Tests for the Level-2 PII masking (NFR-002).
 * The key test: after masking, the server-side checker finds NO personal data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTFN, isValidABN, isValidLuhn, createMaskingSession, detectUnmaskedPII } from '../public/js/engine/redact.js';

test('checksums: TFN, ABN, card', () => {
  assert.equal(isValidTFN('123456782'), true);
  assert.equal(isValidTFN('123456789'), false);
  assert.equal(isValidABN('33102417032'), true);
  assert.equal(isValidABN('33102417033'), false);
  assert.equal(isValidLuhn('4111111111111111'), true);
  assert.equal(isValidLuhn('4111111111111112'), false);
});

test('masks TFN, ABN, name, address, email, phone, account number', () => {
  const s = createMaskingSession({ knownNames: ['Alex Nguyen'] });
  const lines = [
    'Employee: Alex Nguyen',
    'TFN: 123 456 782',
    'Employer ABN: 33 102 417 032',
    'Address: 14 Banksia Street, Footscray VIC 3011',
    'Email: alex.nguyen@example.com',
    'Mobile number: 0412 345 678',
    'Account number: 7700123456',
    'Card 4111 1111 1111 1111'
  ];
  const masked = lines.map((l) => s.mask(l).text);
  const joined = masked.join('\n');
  for (const secret of ['Alex', 'Nguyen', '123 456 782', '33 102 417 032', 'Banksia', 'alex.nguyen@', '0412', '7700123456', '4111']) {
    assert.ok(!joined.includes(secret), `"${secret}" should be masked but got:\n${joined}`);
  }
  assert.deepEqual(detectUnmaskedPII(joined), []);
});

test('does NOT mask money, dates or ordinary words', () => {
  const s = createMaskingSession({ knownNames: ['Alex Nguyen'] });
  for (const line of ['Gross payments  $98,500.00', 'Date: 29/12/2025', 'Total charges for the year  $1,200.00', 'Week starting: 2025-07-07 | Location: Home | Hours: 25']) {
    assert.equal(s.mask(line).text, line);
  }
});

test('same value gets the same token, and re-hydration restores it locally', () => {
  const s = createMaskingSession({ knownNames: ['Alex Nguyen'] });
  const a = s.mask('TFN: 123 456 782').text;
  const b = s.mask('Tax File Number 123456782 again').text;
  assert.match(a, /<PII_TFN_1>/);
  assert.ok(b.includes('<PII_TFN_1>'), 'same TFN written differently gets the same token');
  s.mask('Employee: Alex Nguyen');
  assert.equal(s.rehydrate('Hello <PII_PERSON_1>'), 'Hello Alex Nguyen');
});

test('token map can be exported and re-imported (for the encrypted vault)', () => {
  const s1 = createMaskingSession({ knownNames: ['Alex Nguyen'] });
  s1.mask('Employee: Alex Nguyen TFN 123 456 782');
  const s2 = createMaskingSession();
  s2.importMap(s1.exportMap());
  assert.equal(s2.rehydrate('<PII_PERSON_1>'), 'Alex Nguyen');
});

test('an ABN is labelled ABN, never TFN (ABN checked first)', () => {
  const s = createMaskingSession();
  // the last 9 digits of this ABN happen to pass the TFN checksum too
  assert.equal(s.mask('Employer ABN: 33 102 417 032').text, 'Employer ABN: <PII_ABN_1>');
});

test('email containing the taxpayer name is masked as one EMAIL token', () => {
  const s = createMaskingSession({ knownNames: ['Alex Nguyen'] });
  assert.equal(s.mask('Email: alex.nguyen@example.com').text, 'Email: <PII_EMAIL_1>');
});
