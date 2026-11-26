/**
 * Import validation and reading, using real synthetic PDF and DOCX files built in
 * memory (scripts/lib/synthetic-documents.mjs). PDF.js runs with its Node build;
 * Mammoth runs directly instead of in a worker.
 */
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import {
  SAMPLE_BRIEF_LINES,
  buildDocx,
  buildPdf,
  buildZip,
  paginate,
} from '../scripts/lib/synthetic-documents.mjs';
import {
  ImportError,
  checkFileBasics,
  checkZipExpansion,
  inspectPdfStructure,
  inspectZip,
  sha256Hex,
} from '../src/documents/file-checks.js';
import { itemsToLines, readPdf } from '../src/documents/pdf-reader.js';
import { processDocxBuffer } from '../src/documents/docx-reader.js';
import { createImportPipeline, mapWithConcurrency } from '../src/documents/pipeline.js';
import { DEFAULT_SETTINGS } from '../src/models/settings.js';

const limits = { ...DEFAULT_SETTINGS.importLimits };
const MB = 1024 * 1024;

const asFile = (bytes, name, type = '') => {
  const file = new Blob([bytes], { type });
  return Object.assign(file, { name });
};

const pipeline = createImportPipeline({
  loadPdfjs: async () => pdfjs,
  readDocx: (buffer, options) => processDocxBuffer(buffer, { mammoth, ...options }),
});
const importFile = (file, extra = {}) =>
  pipeline.processFile(file, {
    limits,
    timeZone: 'Europe/Dublin',
    referenceDate: '2026-11-26',
    ...extra,
  });

const expectImportError = async (promise, code) => {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(ImportError);
  expect(error.code).toBe(code);
};

describe('basic file checks', () => {
  const pdfHeader = buildPdf([['x']]).subarray(0, 1024);
  const docxHeader = buildDocx(['x']).subarray(0, 1024);

  it('accepts PDF and DOCX with matching signatures and MIME types', () => {
    expect(
      checkFileBasics({ name: 'a.PDF', size: 10, type: 'application/pdf' }, pdfHeader, limits)
        .sourceType,
    ).toBe('pdf');
    expect(
      checkFileBasics({ name: 'a.docx', size: 10, type: '' }, docxHeader, limits).sourceType,
    ).toBe('docx');
  });

  it('refuses legacy, macro-enabled and other formats by extension', () => {
    for (const name of [
      'brief.doc',
      'brief.docm',
      'brief.rtf',
      'brief.odt',
      'brief.txt',
      'brief',
    ]) {
      expect(() => checkFileBasics({ name, size: 10 }, docxHeader, limits)).toThrow(ImportError);
    }
  });

  it('refuses mismatched MIME types, empty and oversized files', () => {
    expect(() =>
      checkFileBasics({ name: 'a.pdf', size: 10, type: 'text/html' }, pdfHeader, limits),
    ).toThrow(/text\/html/);
    expect(() => checkFileBasics({ name: 'a.pdf', size: 0 }, pdfHeader, limits)).toThrow(/empty/);
    expect(() => checkFileBasics({ name: 'a.pdf', size: 21 * MB }, pdfHeader, limits)).toThrow(
      /20 MB/,
    );
  });

  it('refuses renamed files whose bytes do not match the extension', () => {
    expect(() => checkFileBasics({ name: 'fake.pdf', size: 10 }, docxHeader, limits)).toThrow(
      /real PDF/,
    );
    expect(() => checkFileBasics({ name: 'fake.docx', size: 10 }, pdfHeader, limits)).toThrow(
      /real Word/,
    );
  });

  it('explains password-protected Word files (OLE container)', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(() => checkFileBasics({ name: 'locked.docx', size: 10 }, ole, limits)).toThrow(
      /password/,
    );
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('PDF structure and reading', () => {
  it('warns about truncated files and active content without running it', () => {
    const truncated = buildPdf([['Deadline: 4 December 2026']]).subarray(0, 300);
    expect(inspectPdfStructure(truncated).warnings[0]).toMatch(/incomplete/);
    const active = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF',
    );
    expect(inspectPdfStructure(active).warnings[0]).toMatch(/active content/);
  });

  it('orders text into lines and separates table columns with tabs', () => {
    const lines = itemsToLines([
      { str: '4 December 2026', transform: [11, 0, 0, 11, 230, 700], width: 80 },
      { str: 'Submission date', transform: [11, 0, 0, 11, 50, 700], width: 80 },
      { str: 'Module: X', transform: [11, 0, 0, 11, 50, 720], width: 50 },
      { str: ' ', transform: [11, 0, 0, 11, 140, 700], width: 3 },
    ]);
    expect(lines).toEqual(['Module: X', 'Submission date\t4 December 2026']);
  });

  it('reads a multi-page brief with page numbers', async () => {
    const pdf = buildPdf(paginate(SAMPLE_BRIEF_LINES, 8));
    const content = await readPdf(pdf, { pdfjs, limits });
    expect(content.pageCount).toBe(3);
    expect(content.blocks[0]).toMatchObject({ text: SAMPLE_BRIEF_LINES[0], location: 'Page 1' });
    expect(content.blocks.find((block) => block.text.startsWith('Deliverables')).ref.page).toBe(2);
    expect(content.scanned).toBe(false);
  });

  it('reports empty pages and image-only (scanned) PDFs', async () => {
    const mixed = await readPdf(buildPdf([['Deadline: 4 December 2026'], { image: true }]), {
      pdfjs,
      limits,
    });
    expect(mixed.emptyPages).toEqual([2]);
    expect(mixed.warnings[0]).toMatch(/Page 2 has no readable text/);
    const scanned = await readPdf(buildPdf([{ image: true }, { image: true }]), { pdfjs, limits });
    expect(scanned.scanned).toBe(true);
    expect(scanned.blocks).toEqual([]);
    expect(scanned.warnings[0]).toMatch(/scanned/);
  });

  it('stops at the page and text limits and says so', async () => {
    const pdf = buildPdf(
      paginate(
        Array.from({ length: 60 }, (_, i) => `Line ${i}`),
        10,
      ),
    );
    const byPages = await readPdf(pdf, { pdfjs, limits: { ...limits, maxPdfPages: 2 } });
    expect(byPages.truncated).toBe(true);
    expect(byPages.warnings.join(' ')).toMatch(/first 2 of 6 pages/);
    const byText = await readPdf(
      buildPdf(
        paginate(
          Array.from({ length: 60 }, (_, i) => `Line ${i}`),
          10,
        ),
      ),
      {
        pdfjs,
        limits: { ...limits, maxTextChars: 50 },
      },
    );
    expect(byText.truncated).toBe(true);
    expect(byText.textLength).toBeLessThanOrEqual(50);
  });

  it('rejects password-protected and corrupted PDFs with clear errors', async () => {
    await expectImportError(
      readPdf(buildPdf([['Secret']], { password: 'pw' }), { pdfjs, limits }),
      'password',
    );
    await expectImportError(
      readPdf(new TextEncoder().encode('%PDF-1.4 not really a pdf'), { pdfjs, limits }),
      'corrupted',
    );
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectImportError(
      readPdf(buildPdf([['x']]), { pdfjs, limits, signal: controller.signal }),
      'cancelled',
    );
  });
});

describe('DOCX structure and reading', () => {
  const brief = buildDocx([
    { type: 'heading', text: 'CA2 Group Project Report' },
    'Module: COMP3010 Software Engineering',
    'Submission deadline: Friday 11 December 2026 at 17:00',
    { type: 'heading', text: 'Deliverables' },
    { type: 'list', items: ['Project report (PDF)', 'Source code link'] },
    { type: 'heading', text: 'Marking criteria' },
    {
      type: 'table',
      rows: [
        ['Criterion', 'Marks'],
        ['Design', '30%'],
        ['Testing', '20%'],
      ],
    },
  ]);

  it('keeps headings, list items and table rows with references', async () => {
    const content = await processDocxBuffer(brief.slice().buffer, { mammoth, limits });
    const kinds = content.blocks.map((block) => block.kind);
    expect(kinds).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'heading',
      'listItem',
      'listItem',
      'heading',
      'tableRow',
      'tableRow',
      'tableRow',
    ]);
    expect(content.blocks[4].location).toBe('Paragraph 5 · Deliverables');
    expect(content.blocks[8]).toMatchObject({
      text: 'Design\t30%',
      location: 'Table 1, row 2 · Marking criteria',
    });
  });

  it('rejects macros, encrypted parts and non-Word ZIP files', () => {
    expect(() => inspectZip(buildDocx(['x'], { macro: true }), limits)).toThrow(/macros/);
    expect(() => inspectZip(buildZip([{ name: 'a.txt', data: 'hello' }]), limits)).toThrow(
      /not a Word document/,
    );
    const encrypted = buildDocx(['x'], {
      extraEntries: [{ name: 'word/secret.xml', data: 'x', encrypted: true }],
    });
    expect(() => inspectZip(encrypted, limits)).toThrow(/encrypted/);
    expect(() => inspectZip(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), limits)).toThrow(/damaged/);
  });

  it('stops archive bombs that declare their real size', () => {
    const bomb = buildDocx([], { documentXml: Buffer.alloc(60 * MB, 0x20) });
    expect(() => inspectZip(bomb, limits)).toThrow(/expands to more than 50 MB|suspicious/);
  });

  it('stops archive bombs that lie about their size', async () => {
    const liar = buildDocx(['x'], {
      extraEntries: [
        { name: 'word/media/big.bin', data: Buffer.alloc(8 * MB), declaredSize: 1000 },
      ],
    });
    const { entries } = inspectZip(liar, limits); // the headers alone look fine
    await expect(checkZipExpansion(liar, entries, limits)).rejects.toThrow(/archive bomb/);
  });

  it('notes embedded objects without opening them', () => {
    const embedded = buildDocx(['x'], {
      extraEntries: [{ name: 'word/embeddings/oleObject1.bin', data: 'ole' }],
    });
    expect(inspectZip(embedded, limits).warnings[0]).toMatch(/Embedded objects/);
  });

  it('rejects a damaged document part', async () => {
    const broken = buildDocx([], { documentXml: '<w:document><w:body><w:p>' });
    await expectImportError(
      processDocxBuffer(broken.slice().buffer, { mammoth, limits }),
      'corrupted',
    );
  });
});

describe('full pipeline', () => {
  it('imports a PDF brief and extracts the assessment with page evidence', async () => {
    const pdf = buildPdf(paginate(SAMPLE_BRIEF_LINES, 10));
    const stages = [];
    const result = await importFile(asFile(pdf, 'CA2 brief.pdf', 'application/pdf'), {
      onStage: (stage) => stages.push(stage),
    });
    expect(result.sourceType).toBe('pdf');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    const [candidate] = result.extraction.assessments;
    expect(candidate.title.value).toBe('CA2 Group Project Report');
    expect(candidate.submissionDeadline).toMatchObject({ value: '2026-12-11', time: '17:00' });
    expect(candidate.submissionDeadline.source.location).toBe('Page 1');
    expect(candidate.deliverables.map((item) => item.value)).toEqual([
      'Project report (PDF)',
      'Source code repository link',
    ]);
    expect(candidate.deliverables[0].source.location).toBe('Page 2');
    expect(candidate.groupSize.value).toBe('3–4 students');
    expect(candidate.presentation.duration.value).toBe('10 minutes');
    expect(candidate.submissionMethod.value).toBe('Moodle');
    expect(stages).toEqual(
      expect.arrayContaining(['checking', 'hashing', 'loading', 'reading', 'extracting', 'done']),
    );
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('imports a DOCX brief with the same results', async () => {
    const docx = buildDocx(SAMPLE_BRIEF_LINES.filter(Boolean));
    const result = await importFile(asFile(docx, 'brief.docx'));
    const [candidate] = result.extraction.assessments;
    expect(result.sourceType).toBe('docx');
    expect(candidate.submissionDeadline.value).toBe('2026-12-11');
    expect(candidate.weighting.value).toBe(40);
    expect(candidate.markingCriteria.map((item) => item.value)).toEqual([
      'Requirements analysis 20%',
      'Design 30%',
    ]);
    expect(candidate.submissionDeadline.source.location).toBe('Paragraph 6');
  });

  it('gives identical hashes for renamed copies and different hashes for edits', async () => {
    const pdf = buildPdf([['Deadline: 4 December 2026']]);
    const original = await importFile(asFile(pdf, 'brief.pdf'));
    const renamed = await importFile(asFile(pdf.slice(), 'brief (1).pdf'));
    const edited = await importFile(asFile(buildPdf([['Deadline: 5 December 2026']]), 'brief.pdf'));
    expect(renamed.hash).toBe(original.hash);
    expect(edited.hash).not.toBe(original.hash);
  });

  it('returns no deadline for a scanned PDF', async () => {
    const result = await importFile(asFile(buildPdf([{ image: true }]), 'scan.pdf'));
    expect(result.stats.scanned).toBe(true);
    expect(result.extraction.assessments[0].submissionDeadline).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/scanned/);
  });

  it('fails clearly for oversized, corrupted and cancelled imports', async () => {
    await expectImportError(
      importFile(asFile(new Uint8Array(2 * MB), 'big.pdf'), {
        limits: { ...limits, maxFileSizeMB: 1 },
      }),
      'too-large',
    );
    await expectImportError(
      importFile(asFile(buildPdf([['x']]).subarray(0, 200), 'cut.pdf')),
      'corrupted',
    );
    const controller = new AbortController();
    controller.abort();
    await expectImportError(
      importFile(asFile(buildPdf([['x']]), 'a.pdf'), { signal: controller.signal }),
      'cancelled',
    );
  });

  it('stops files that take too long', async () => {
    const slow = createImportPipeline({
      loadPdfjs: async () => pdfjs,
      readDocx: (_buffer, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new ImportError('cancelled', 'x'))),
        ),
      timeoutMs: 50,
    });
    await expectImportError(
      slow.processFile(asFile(buildDocx(['x']), 'slow.docx'), {
        limits,
        timeZone: 'Europe/Dublin',
        referenceDate: '2026-11-26',
      }),
      'timeout',
    );
  });

  it('treats malicious-looking content as plain text', async () => {
    const docx = buildDocx([
      'Assessment title: <script>alert("x")</script>',
      'Deadline: 4 December 2026',
      'Submission method: javascript:alert(1)',
    ]);
    const result = await importFile(asFile(docx, 'odd.docx'));
    expect(result.extraction.assessments[0].title.value).toBe('<script>alert("x")</script>');
  });

  it('processes batches with bounded concurrency in input order', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
