/**
 * Creates the demo documents in public/samples/ for Use Case 1 (WFH claims).
 * All people, companies and numbers are made up and every page says SAMPLE.
 * Run with:  node scripts/make-samples.mjs   (needs the pdf-lib package)
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

async function makePdf(fileName, title, lines) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText('SAMPLE DOCUMENT - FOR TESTING ONLY', { x: 50, y: 800, size: 9, font: bold, color: rgb(0.75, 0.1, 0.1) });
  page.drawText(title, { x: 50, y: 770, size: 18, font: bold });
  let y = 735;
  for (const line of lines) {
    if (line === '') { y -= 12; continue; }
    const [left, right] = Array.isArray(line) ? line : [line, null];
    page.drawText(left, { x: 50, y, size: 11, font });
    if (right) page.drawText(right, { x: 545 - font.widthOfTextAtSize(right, 11), y, size: 11, font: bold });
    y -= 20;
  }
  writeFileSync(new URL(fileName, OUT), await pdf.save());
}

await makePdf('income-statement-2025-26.pdf', 'Employer income statement 2025-26', [
  'Employer: Brightwave Software Pty Ltd',
  'Employer ABN: 33 102 417 032',
  'Employee: Alex Nguyen',
  'TFN: 123 456 782',
  'Address: 14 Banksia Street, Footscray VIC 3011',
  'Period: 1 July 2025 to 30 June 2026',
  '',
  ['Gross payments', '$98,500.00'],
  ['Tax withheld', '$22,450.00'],
  ['Reportable employer super contributions', '$0.00'],
  ['Allowances', '$0.00']
]);

await makePdf('ergonomic-chair-invoice.pdf', 'Tax invoice INV-20817', [
  'ErgoHub Furniture Pty Ltd',
  'Date: 29/12/2025',
  'Sold to: Alex Nguyen',
  'Email: alex.nguyen@example.com',
  '',
  ['Ergonomic office chair - mesh, adjustable  1 x', '$450.00'],
  ['GST included', '$40.91'],
  ['Total', '$450.00'],
  '',
  'Paid by card ending 4421'
]);

await makePdf('electricity-annual-statement.pdf', 'Electricity annual statement', [
  'Brightside Energy (sample retailer)',
  'Customer name: Alex Nguyen',
  'Account number: 7700123456',
  'Supply address: 14 Banksia Street, Footscray VIC 3011',
  'Period: 1 Jul 2025 to 30 Jun 2026',
  'Usage: 4,800 kWh',
  '',
  ['Total charges for the year', '$1,200.00']
]);

await makePdf('internet-annual-statement.pdf', 'Internet annual statement', [
  'Kite Broadband (sample provider)',
  'Account name: Alex Nguyen',
  'Account number: KB-5521909',
  'Plan: NBN 100 home internet',
  'Period: 1 Jul 2025 to 30 Jun 2026',
  '',
  ['Total charges for the year', '$960.00']
]);

await makePdf('mobile-annual-statement.pdf', 'Mobile phone annual statement', [
  'Orbit Mobile (sample provider)',
  'Account name: Alex Nguyen',
  'Mobile number: 0412 345 678',
  'Email: alex.nguyen@example.com',
  'Plan: Mobile 40GB',
  'Period: 1 Jul 2025 to 30 Jun 2026',
  '',
  ['Total charges for the year', '$720.00']
]);

// WFH timesheet CSV: 32 weeks x 25h + 10 weeks x 32h at home = 1,120 hours
const rows = [['Week starting', 'Location', 'Hours', 'Notes']];
const start = Date.UTC(2025, 6, 7); // Monday 7 July 2025
let homeWeeks = 0;
for (let w = 0; w < 48; w++) {
  const d = new Date(start + w * 7 * 86400000).toISOString().slice(0, 10);
  if (w % 8 === 7) { rows.push([d, 'Office', '38', 'In office all week']); continue; }
  homeWeeks++;
  rows.push([d, 'Home', homeWeeks <= 32 ? '25' : '32', 'Worked from home']);
}
writeFileSync(new URL('wfh-timesheet-2025-26.csv', OUT), rows.map((r) => r.join(',')).join('\n') + '\n');
console.log('Samples written. Home hours =', rows.filter((r) => r[1] === 'Home').reduce((s, r) => s + Number(r[2]), 0));
