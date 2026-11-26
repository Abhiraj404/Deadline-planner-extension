/**
 * Measures document processing time on synthetic briefs in Node (PDF.js legacy build,
 * Mammoth without a worker). Browser timings are measured by `npm run smoke:import`.
 *
 *   npm run measure
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { buildDocx, buildPdf, paginate, SAMPLE_BRIEF_LINES } from './lib/synthetic-documents.mjs';
import { processDocxBuffer } from '../src/documents/docx-reader.js';
import { createImportPipeline, mapWithConcurrency } from '../src/documents/pipeline.js';
import { extractAssessments } from '../src/extraction/engine.js';
import { DEFAULT_SETTINGS } from '../src/models/settings.js';

const limits = { ...DEFAULT_SETTINGS.importLimits, maxPdfPages: 500, maxTextChars: 1_000_000 };
const pipeline = createImportPipeline({
  loadPdfjs: async () => pdfjs,
  readDocx: (buffer, options) => processDocxBuffer(buffer, { mammoth, ...options }),
});
const asFile = (bytes, name) => Object.assign(new Blob([bytes]), { name });
const run = (bytes, name) =>
  pipeline.processFile(asFile(bytes, name), {
    limits,
    timeZone: 'Europe/Dublin',
    referenceDate: '2026-11-26',
  });

const lines = (count) =>
  Array.from({ length: count }, (_, i) =>
    i < SAMPLE_BRIEF_LINES.length
      ? SAMPLE_BRIEF_LINES[i]
      : `Paragraph ${i}: reading list and notes.`,
  );

async function median(task, repeats = 5) {
  const times = [];
  for (let i = 0; i < repeats; i += 1) {
    const started = performance.now();
    await task();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

const rows = [];
await run(buildPdf([['warm-up']]), 'warm.pdf'); // load PDF.js once

for (const pages of [1, 10, 50, 100]) {
  const bytes = buildPdf(paginate(lines(pages * 45), 45));
  const ms = await median(() => run(bytes.slice(), `brief-${pages}.pdf`));
  rows.push([
    `PDF, ${pages} page${pages === 1 ? '' : 's'}`,
    `${(bytes.length / 1024).toFixed(0)} KB`,
    ms,
  ]);
}
for (const paragraphs of [20, 500, 2400]) {
  const bytes = buildDocx(lines(paragraphs));
  const ms = await median(() => run(bytes.slice(), `brief-${paragraphs}.docx`));
  rows.push([`DOCX, ${paragraphs} paragraphs`, `${(bytes.length / 1024).toFixed(0)} KB`, ms]);
}
const text = lines(4500).join('\n');
rows.push([
  'Extraction only, 4,500 lines',
  `${(text.length / 1024).toFixed(0)} KB text`,
  await median(() => extractAssessments(text)),
]);

const batch = Array.from({ length: 10 }, (_, i) =>
  i % 2 ? [buildDocx(lines(200)), `b${i}.docx`] : [buildPdf(paginate(lines(450), 45)), `b${i}.pdf`],
);
for (const concurrency of [1, 2]) {
  const ms = await median(
    () => mapWithConcurrency(batch, concurrency, ([bytes, name]) => run(bytes.slice(), name)),
    3,
  );
  rows.push([`Batch of 10 (5 × 10-page PDF, 5 × DOCX), ${concurrency} at a time`, '', ms]);
}

console.log(`Node ${process.version} · median of 5 runs (3 for batches)\n`);
for (const [label, size, ms] of rows) {
  console.log(`${label.padEnd(58)} ${size.padStart(9)}  ${ms.toFixed(1).padStart(8)} ms`);
}
