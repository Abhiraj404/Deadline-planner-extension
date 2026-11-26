import { describe, expect, it } from 'vitest';
import { applyChanges, createAssessment } from '../src/models/assessment.js';
import {
  applyDocumentChanges,
  compareWithExtraction,
  createDocumentReference,
  MAX_DOCUMENT_BYTES,
  validateDocumentFile,
} from '../src/services/documents.js';
import { sequentialIds } from './helpers/chrome-mock.js';

const now = new Date('2026-11-25T10:00:00Z');
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

describe('validateDocumentFile', () => {
  it('accepts real PDF and DOCX files', () => {
    expect(validateDocumentFile({ name: 'Brief.PDF', size: 1000 }, PDF)).toEqual({
      ok: true,
      sourceType: 'pdf',
    });
    expect(validateDocumentFile({ name: 'brief.docx', size: 1000 }, ZIP)).toEqual({
      ok: true,
      sourceType: 'docx',
    });
  });

  it('rejects renamed, macro-enabled, empty, oversized and unsupported files', () => {
    expect(validateDocumentFile({ name: 'fake.pdf', size: 10 }, ZIP).ok).toBe(false);
    expect(validateDocumentFile({ name: 'macro.docm', size: 10 }, ZIP).error).toMatch(/docm/);
    expect(validateDocumentFile({ name: 'empty.pdf', size: 0 }, PDF).ok).toBe(false);
    expect(validateDocumentFile({ name: 'huge.pdf', size: MAX_DOCUMENT_BYTES + 1 }, PDF).ok).toBe(
      false,
    );
    expect(validateDocumentFile({ name: 'notes.txt', size: 10 }, PDF).ok).toBe(false);
  });

  it('creates a metadata-only reference', () => {
    const ref = createDocumentReference({ name: 'brief.pdf', size: 1234 }, 'pdf', {
      now,
      idFactory: () => 'doc-1',
    });
    expect(ref).toEqual({
      id: 'doc-1',
      name: 'brief.pdf',
      type: 'pdf',
      size: 1234,
      attachedAt: now.toISOString(),
    });
  });
});

describe('attaching a document to an existing manual deadline', () => {
  const manual = () => {
    const base = createAssessment(
      {
        title: 'My essay',
        dueDate: '2026-12-11',
        notes: 'Started the intro',
        reminderOffsets: [4320],
        checklist: [{ text: 'Outline', done: true }],
      },
      { now, idFactory: sequentialIds('m') },
    );
    return base;
  };

  const extraction = {
    sourceType: 'pdf',
    confidence: 'high',
    fields: {
      title: { value: 'CA2 Essay', confidence: 'high', sourceText: 'Assessment title: CA2 Essay' },
      moduleCode: { value: 'ENG2001', confidence: 'medium' },
      dueDate: { value: '2026-12-14', confidence: 'high' },
      weighting: { value: 30, confidence: 'high' },
    },
    deliverables: [{ value: 'Outline' }, { value: 'Final PDF' }],
  };

  it('highlights differences and protects confirmed fields', () => {
    const differences = compareWithExtraction(manual(), extraction);
    const byField = Object.fromEntries(differences.map((d) => [d.field, d]));
    // The user typed the title and date, so they are not pre-selected for replacement.
    expect(byField.title).toMatchObject({
      status: 'different',
      confirmed: true,
      selectedByDefault: false,
    });
    expect(byField.dueDate).toMatchObject({
      current: '2026-12-11',
      proposed: '2026-12-14',
      selectedByDefault: false,
    });
    // Empty fields are filled by default.
    expect(byField.moduleCode).toMatchObject({ status: 'new', selectedByDefault: true });
    expect(byField.weighting).toMatchObject({ status: 'new', selectedByDefault: true });
    // Only new deliverables are proposed.
    expect(byField.checklist.proposed).toEqual(['Final PDF']);
  });

  it('applies only the selected fields and preserves notes, progress and reminders', () => {
    const existing = applyChanges(manual(), { completed: true }, { now }).assessment;
    const doc = {
      id: 'doc-9',
      name: 'brief.pdf',
      type: 'pdf',
      size: 99,
      attachedAt: now.toISOString(),
    };
    const updated = applyDocumentChanges(existing, extraction, ['weighting', 'checklist'], {
      now,
      document: doc,
      idFactory: sequentialIds('n'),
    });
    expect(updated.title).toBe('My essay');
    expect(updated.dueDate).toBe('2026-12-11');
    expect(updated.weighting).toBe(30);
    expect(updated.notes).toBe('Started the intro');
    expect(updated.reminderOffsets).toEqual([4320]);
    expect(updated.completed).toBe(true);
    expect(updated.checklist.map((item) => [item.text, item.done])).toEqual([
      ['Outline', true],
      ['Final PDF', false],
    ]);
    expect(updated.sourceDocument).toEqual(doc);
    expect(updated.sourceType).toBe('manual');
    expect(updated.confirmedFields).toEqual(expect.arrayContaining(['weighting', 'checklist']));
  });

  it('changes nothing when no fields are selected and no document is given', () => {
    const existing = manual();
    expect(applyDocumentChanges(existing, extraction, [], { now })).toBe(existing);
  });

  it('ignores invalid extracted values rather than breaking the record', () => {
    const existing = manual();
    const bad = { fields: { dueDate: { value: 'next friday', confidence: 'low' } } };
    expect(applyDocumentChanges(existing, bad, ['dueDate'], { now })).toBe(existing);
  });
});
