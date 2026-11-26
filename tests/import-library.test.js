/**
 * Duplicate detection, saving reviewed imports and the document library, with the
 * in-memory chrome.storage mock. Runs the real pipeline on synthetic files.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { buildDocx, buildPdf, SAMPLE_BRIEF_LINES } from '../scripts/lib/synthetic-documents.mjs';
import { processDocxBuffer } from '../src/documents/docx-reader.js';
import { createImportPipeline } from '../src/documents/pipeline.js';
import { createAssessmentService } from '../src/services/assessments.js';
import { classifyImport, fileStem, titleSimilarity } from '../src/services/duplicates.js';
import { candidateToExtraction, createImportService } from '../src/services/imports.js';
import { createStorage } from '../src/services/storage.js';
import { createBackup, parseBackup } from '../src/services/backup.js';
import { DEFAULT_SETTINGS } from '../src/models/settings.js';
import { createMemoryStorageArea, sequentialIds } from './helpers/chrome-mock.js';

const pipeline = createImportPipeline({
  loadPdfjs: async () => pdfjs,
  readDocx: (buffer, options) => processDocxBuffer(buffer, { mammoth, ...options }),
});
const asFile = (bytes, name) => Object.assign(new Blob([bytes]), { name });
const process = (bytes, name) =>
  pipeline.processFile(asFile(bytes, name), {
    limits: DEFAULT_SETTINGS.importLimits,
    timeZone: 'Europe/Dublin',
    referenceDate: '2026-11-26',
  });

/** Turn a candidate into form values the way the review screen does by default. */
function draftFrom(candidate) {
  return {
    candidate,
    values: {
      title: candidate.title?.value ?? 'Untitled',
      dueDate: candidate.submissionDeadline?.value ?? '2026-12-31',
      dueTime: candidate.submissionTime?.value ?? null,
      moduleName: candidate.moduleName?.value ?? null,
      moduleCode: candidate.moduleCode?.value ?? null,
      weighting: candidate.weighting?.value ?? null,
      submissionMethod: candidate.submissionMethod?.value ?? null,
      wordCount: candidate.wordCount?.value ?? null,
      groupSize: candidate.groupSize?.value ?? null,
      checklist: candidate.deliverables.map((item) => ({ text: item.value })),
      instructions: candidate.instructions.map((item) => item.value),
      markingCriteria: candidate.markingCriteria.map((item) => item.value),
      category: candidate.assessmentType?.value ?? 'assignment',
    },
  };
}

const summaries = (processed) =>
  processed.extraction.assessments.map((candidate) => ({
    title: candidate.title?.value,
    moduleCode: candidate.moduleCode?.value,
    dueDate: candidate.submissionDeadline?.value,
  }));

let area;
let storage;
let imports;
let assessments;
const now = new Date('2026-11-26T10:00:00Z');

beforeEach(() => {
  area = createMemoryStorageArea();
  storage = createStorage(area);
  const ids = sequentialIds();
  imports = createImportService({ storage, now: () => now, idFactory: ids });
  assessments = createAssessmentService({ storage, now: () => now, idFactory: ids });
});

const library = async () => {
  const state = await storage.getState();
  return { documents: state.documents, assessments: state.assessments };
};

describe('helpers', () => {
  it('normalises file names for version comparison', () => {
    expect(fileStem('CA2_Brief_v3 (1) FINAL.pdf')).toBe('ca2 brief');
    expect(fileStem('Copy of CA2 Brief - updated 2026-11-20.docx')).toBe('ca2 brief');
    expect(fileStem('CA1 Brief.pdf')).not.toBe(fileStem('CA2 Brief.pdf'));
  });

  it('measures title similarity', () => {
    expect(titleSimilarity('CA2 Group Project Report', 'CA2 group project report')).toBe(1);
    expect(titleSimilarity('Essay', 'Lab report')).toBe(0);
  });
});

describe('saving a reviewed import', () => {
  it('saves only what the user confirmed, with a library record and evidence', async () => {
    const processed = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'CA2 brief.pdf');
    const [candidate] = processed.extraction.assessments;
    // Nothing is stored until the user confirms.
    expect((await library()).assessments).toEqual([]);

    const result = await imports.saveReviewedImport(processed, { create: [draftFrom(candidate)] });
    expect(result.ok).toBe(true);
    const { documents, assessments: saved } = await library();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      title: 'CA2 Group Project Report',
      dueDate: '2026-12-11',
      dueTime: '17:00',
      weighting: 40,
      sourceType: 'pdf',
      userConfirmed: true,
      submissionMethod: 'Moodle',
      groupSize: '3–4 students',
      instructions: ['Submit through Moodle only.'],
    });
    expect(saved[0].confirmedFields).toEqual(
      expect.arrayContaining(['title', 'dueDate', 'weighting']),
    );
    expect(saved[0].sourceDocument).toMatchObject({
      id: documents[0].id,
      name: 'CA2 brief.pdf',
      type: 'pdf',
    });
    expect(documents[0]).toMatchObject({
      hash: processed.hash,
      fileType: 'pdf',
      status: 'complete',
      assessmentIds: [saved[0].id],
      pageCount: 1,
    });
    const deadlineEvidence = documents[0].evidence.find((item) => item.field === 'dueDate');
    expect(deadlineEvidence).toMatchObject({ value: '2026-12-11', location: 'Page 1' });
    expect(deadlineEvidence.text).toMatch(/Submission deadline/);
  });

  it('rejects invalid drafts without saving anything', async () => {
    const processed = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'brief.pdf');
    const draft = draftFrom(processed.extraction.assessments[0]);
    const result = await imports.saveReviewedImport(processed, {
      create: [draft, { ...draft, values: { ...draft.values, dueDate: '' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ index: 1 });
    expect((await library()).assessments).toEqual([]);
    expect((await library()).documents).toEqual([]);
  });

  it('creates several assessments from one document', async () => {
    const processed = await process(
      buildDocx([
        'Module: COMP2001 Databases',
        { type: 'heading', text: 'CA1 – SQL Exercises' },
        'Submit by 16 October 2026 at 17:00',
        { type: 'heading', text: 'CA2 – Design Report' },
        'Deadline: 4 December 2026 at 23:59',
      ]),
      'databases.docx',
    );
    expect(processed.extraction.assessments).toHaveLength(2);
    await imports.saveReviewedImport(processed, {
      create: processed.extraction.assessments.map(draftFrom),
    });
    const { documents, assessments: saved } = await library();
    expect(saved.map((item) => item.dueDate)).toEqual(['2026-10-16', '2026-12-04']);
    expect(documents).toHaveLength(1);
    expect(documents[0].assessmentIds).toHaveLength(2);
  });

  it('can keep a scanned document in the library and add the deadline manually', async () => {
    const processed = await process(buildPdf([{ image: true }]), 'scan.pdf');
    const manual = {
      candidate: processed.extraction.assessments[0],
      values: { title: 'Scanned essay brief', dueDate: '2026-12-15' },
    };
    await imports.saveReviewedImport(processed, { create: [manual] });
    const { documents, assessments: saved } = await library();
    expect(documents[0].status).toBe('no-text');
    expect(saved[0].title).toBe('Scanned essay brief');
  });
});

describe('duplicate documents', () => {
  it('recognises an identical re-import and a renamed copy by hash', async () => {
    const bytes = buildPdf([SAMPLE_BRIEF_LINES]);
    const first = await process(bytes, 'brief.pdf');
    await imports.saveReviewedImport(first, {
      create: [draftFrom(first.extraction.assessments[0])],
    });

    const again = await process(bytes.slice(), 'brief.pdf');
    expect(classifyImport({ ...again, candidates: summaries(again) }, await library()).kind).toBe(
      'identical',
    );

    const renamed = await process(bytes.slice(), 'Copy of brief.pdf');
    const classified = classifyImport(
      { ...renamed, candidates: summaries(renamed) },
      await library(),
    );
    expect(classified.kind).toBe('renamed');
    expect(classified.assessments).toHaveLength(1);
  });

  it('records a renamed copy as an alias without creating a second record', async () => {
    const bytes = buildPdf([SAMPLE_BRIEF_LINES]);
    const first = await process(bytes, 'brief.pdf');
    await imports.saveReviewedImport(first, {
      create: [draftFrom(first.extraction.assessments[0])],
    });
    const renamed = await process(bytes.slice(), 'brief (1).pdf');
    await imports.saveReviewedImport(renamed, { keepDocumentOnly: true });
    const { documents, assessments: saved } = await library();
    expect(documents).toHaveLength(1);
    expect(documents[0].aliases).toEqual(['brief (1).pdf']);
    expect(saved).toHaveLength(1);
  });

  it('offers an update for a new version and never overwrites confirmed data silently', async () => {
    const first = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'CA2 brief.pdf');
    const saved = await imports.saveReviewedImport(first, {
      create: [draftFrom(first.extraction.assessments[0])],
    });
    const original = saved.created[0];
    await assessments.update(original.id, { notes: 'Meet group on Tuesday' });

    const changedLines = SAMPLE_BRIEF_LINES.map((line) =>
      line.startsWith('Submission deadline')
        ? 'Submission deadline: Monday 14 December 2026 at 17:00'
        : line,
    );
    const second = await process(buildPdf([changedLines]), 'CA2 brief v2.pdf');
    const classified = classifyImport(
      { ...second, candidates: summaries(second) },
      await library(),
    );
    expect(classified.kind).toBe('update');
    expect(classified.matches[0]).toMatchObject({ assessmentId: original.id, kind: 'update' });

    const extraction = candidateToExtraction(second.extraction.assessments[0], 'pdf');
    // Apply nothing: the deadline must not change.
    await imports.saveReviewedImport(second, {
      update: [
        {
          assessmentId: original.id,
          extraction,
          selectedFields: [],
          candidate: second.extraction.assessments[0],
        },
      ],
    });
    let current = (await library()).assessments.find((item) => item.id === original.id);
    expect(current.dueDate).toBe('2026-12-11');
    expect(current.notes).toBe('Meet group on Tuesday');

    // Now the user explicitly approves the new date.
    await imports.saveReviewedImport(second, {
      update: [
        {
          assessmentId: original.id,
          extraction,
          selectedFields: ['dueDate'],
          candidate: second.extraction.assessments[0],
        },
      ],
    });
    const state = await library();
    current = state.assessments.find((item) => item.id === original.id);
    expect(current.dueDate).toBe('2026-12-14');
    expect(current.notes).toBe('Meet group on Tuesday');
    expect(state.assessments).toHaveLength(1);
    const newRecord = state.documents.find((record) => record.hash === second.hash);
    expect(newRecord.previousDocumentId).toBe(original.sourceDocument.id);
    expect(current.sourceDocument.id).toBe(newRecord.id);
  });

  it('treats a different assessment with a similar title as new', async () => {
    const first = await process(
      buildPdf([
        ['Module code: COMP3010', 'Assessment title: CA1 Report', 'Deadline: 6 November 2026'],
      ]),
      'ca1.pdf',
    );
    await imports.saveReviewedImport(first, {
      create: [draftFrom(first.extraction.assessments[0])],
    });
    const second = await process(
      buildPdf([
        ['Module code: COMP3010', 'Assessment title: CA2 Report', 'Deadline: 4 December 2026'],
      ]),
      'ca2.pdf',
    );
    const classified = classifyImport(
      { ...second, candidates: summaries(second) },
      await library(),
    );
    expect(classified.kind).not.toBe('update');
  });

  it('treats the same title in another module as new', async () => {
    const first = await process(
      buildPdf([
        ['Module code: COMP3010', 'Assessment title: Final Report', 'Deadline: 4 December 2026'],
      ]),
      'a.pdf',
    );
    await imports.saveReviewedImport(first, {
      create: [draftFrom(first.extraction.assessments[0])],
    });
    const second = await process(
      buildPdf([
        ['Module code: HIST1001', 'Assessment title: Final Report', 'Deadline: 4 December 2026'],
      ]),
      'b.pdf',
    );
    expect(classifyImport({ ...second, candidates: summaries(second) }, await library()).kind).toBe(
      'new',
    );
  });
});

describe('library maintenance', () => {
  it('deletes document information but keeps the deadlines', async () => {
    const processed = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'brief.pdf');
    await imports.saveReviewedImport(processed, {
      create: [draftFrom(processed.extraction.assessments[0])],
    });
    const { documents } = await library();
    await imports.deleteDocument(documents[0].id);
    const after = await library();
    expect(after.documents).toEqual([]);
    expect(after.assessments).toHaveLength(1);
    expect(after.assessments[0].sourceDocument.name).toBe('brief.pdf');
  });

  it('includes the library in backups and restores it', async () => {
    const processed = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'brief.pdf');
    await imports.saveReviewedImport(processed, {
      create: [draftFrom(processed.extraction.assessments[0])],
    });
    const state = await storage.getState();
    const parsed = parseBackup(JSON.stringify(createBackup(state, now)));
    expect(parsed.ok).toBe(true);
    expect(parsed.documents).toEqual(state.documents);
  });

  it('keeps the stored library small (no document text)', async () => {
    const processed = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'brief.pdf');
    await imports.saveReviewedImport(processed, {
      create: [draftFrom(processed.extraction.assessments[0])],
    });
    const bytes = JSON.stringify(area.dump().documents).length;
    expect(bytes).toBeLessThan(12_000);
  });

  it('keeps manual deadlines working alongside imported ones', async () => {
    await assessments.create({ title: 'Manual task', dueDate: '2026-12-01' });
    const processed = await process(buildPdf([SAMPLE_BRIEF_LINES]), 'brief.pdf');
    await imports.saveReviewedImport(processed, {
      create: [draftFrom(processed.extraction.assessments[0])],
    });
    const all = await assessments.list();
    expect(all.map((item) => item.sourceType)).toEqual(['manual', 'pdf']);
    const manual = all[0];
    expect((await assessments.setCompleted(manual.id, true)).assessment.completed).toBe(true);
  });
});
