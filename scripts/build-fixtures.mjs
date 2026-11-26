/**
 * Writes the synthetic test documents to ./fixtures-output (git-ignored) so they can
 * be imported by hand or by `npm run smoke:import`. None of them is a real brief.
 *
 *   npm run fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SAMPLE_BRIEF_LINES, buildDocx, buildPdf, paginate } from './lib/synthetic-documents.mjs';

const OUT = fileURLToPath(new URL('../fixtures-output/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const updatedLines = SAMPLE_BRIEF_LINES.map((line) =>
  line.startsWith('Submission deadline')
    ? 'Submission deadline: Monday 14 December 2026 at 17:00'
    : line,
);
const longLines = Array.from({ length: 2400 }, (_, i) =>
  i === 3
    ? 'Submission deadline: 4 December 2026 at 17:00'
    : `Section ${i}: background reading and notes for week ${i % 12}.`,
);

export const FIXTURES = {
  'clear-brief.pdf': buildPdf(paginate(SAMPLE_BRIEF_LINES, 12)),
  'clear-brief (copy).pdf': buildPdf(paginate(SAMPLE_BRIEF_LINES, 12)),
  'clear-brief v2.pdf': buildPdf(paginate(updatedLines, 12)),
  'structured-brief.docx': buildDocx([
    { type: 'heading', text: 'CA3 Database Design Report' },
    'Module: COMP2001 Databases',
    'Assessment type: Individual report',
    'Submission deadline: Friday, 4th December 2026 at 11:59 PM',
    'Submit through Brightspace.',
    { type: 'heading', text: 'Deliverables' },
    { type: 'list', items: ['ER diagram (PDF)', 'SQL scripts', 'Reflection (500 words)'] },
    { type: 'heading', text: 'Marking criteria' },
    {
      type: 'table',
      rows: [
        ['Criterion', 'Marks'],
        ['Design', '40%'],
        ['Normalisation', '30%'],
        ['Report', '30%'],
      ],
    },
    'Important: Late work loses 10% per day.',
  ]),
  'ambiguous-dates.pdf': buildPdf([
    [
      'Module: HIST2001 Modern History',
      'Assessment title: Source Analysis Essay',
      'This essay is worth 25% of the module grade.',
      'Due: 03/04/2027 by 5pm',
      'Word limit: 1,500 words',
    ],
  ]),
  'two-assessments.docx': buildDocx([
    'Module: MATH1002 Statistics',
    { type: 'heading', text: 'CA1 – Problem Set' },
    'Weighting: 15%',
    'Submit by 16 October 2026 at 17:00',
    { type: 'heading', text: 'CA2 – Group Data Project' },
    'Weighting: 35%',
    'Work in groups of 3 to 4 students.',
    'Deadline: 11 December 2026 at 23:59',
    'Presentations: 15 December 2026, 10:00. Each presentation lasts 10 minutes.',
  ]),
  'missing-year.pdf': buildPdf([
    ['Assessment title: Lab Report 3', 'Submit by 4 December at 11:59 PM'],
  ]),
  'scanned.pdf': buildPdf([{ image: true }, { image: true }]),
  'password.pdf': buildPdf([['Secret brief']], { password: 'letmein' }),
  'corrupted.pdf': buildPdf([['Deadline: 4 December 2026']]).subarray(0, 220),
  'macro.docx': buildDocx(['Deadline: 4 December 2026'], { macro: true }),
  'archive-bomb.docx': buildDocx(['x'], {
    extraEntries: [
      { name: 'word/media/big.bin', data: Buffer.alloc(8 * 1024 * 1024), declaredSize: 1000 },
    ],
  }),
  'long-brief.pdf': buildPdf(paginate(longLines, 48)),
  'long-brief.docx': buildDocx(longLines),
};

for (const [name, bytes] of Object.entries(FIXTURES)) writeFileSync(`${OUT}${name}`, bytes);

// `--demo` also refreshes the small set of synthetic briefs kept in the repository
// (demo/briefs/) for people who want to try importing without their own documents.
if (process.argv.includes('--demo')) {
  const DEMO = fileURLToPath(new URL('../demo/briefs/', import.meta.url));
  mkdirSync(DEMO, { recursive: true });
  const demo = {
    'demo-group-project-brief.pdf': FIXTURES['clear-brief.pdf'],
    'demo-database-report-brief.docx': FIXTURES['structured-brief.docx'],
    'demo-two-assessments.docx': FIXTURES['two-assessments.docx'],
    'demo-ambiguous-date.pdf': FIXTURES['ambiguous-dates.pdf'],
  };
  for (const [name, bytes] of Object.entries(demo)) writeFileSync(`${DEMO}${name}`, bytes);
  console.log(`Wrote ${Object.keys(demo).length} demo briefs to ${DEMO}`);
}
console.log(`Wrote ${Object.keys(FIXTURES).length} files to ${OUT}`);
