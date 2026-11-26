import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, migrateSnapshot } from '../src/services/migrations.js';
import { createStorage } from '../src/services/storage.js';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/models/settings.js';
import { normalizeDocumentRecord } from '../src/models/document.js';
import { createAssessmentService } from '../src/services/assessments.js';
import { createMemoryStorageArea } from './helpers/chrome-mock.js';

const HASH = 'a'.repeat(64);

describe('schema version 2', () => {
  it('upgrades a version 1 snapshot, adding the document library and new fields', () => {
    const v1 = {
      schemaVersion: 1,
      settings: { theme: 'dark' },
      assessments: [{ id: 'a', title: 'Essay', dueDate: '2026-12-11', notes: 'keep' }],
    };
    const { snapshot, changed, fromVersion } = migrateSnapshot(v1);
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(fromVersion).toBe(1);
    expect(changed).toBe(true);
    expect(snapshot.documents).toEqual([]);
    expect(snapshot.assessments[0]).toMatchObject({
      notes: 'keep',
      submissionMethod: null,
      wordCount: null,
      groupSize: null,
      instructions: [],
      markingCriteria: [],
      relatedDates: [],
    });
    expect(snapshot.settings.theme).toBe('dark');
    expect(snapshot.settings.retainDocumentFiles).toBe(false);
  });

  it('drops invalid library records', () => {
    const { snapshot } = migrateSnapshot({
      schemaVersion: 2,
      assessments: [],
      documents: [
        { id: 'ok', hash: HASH, fileType: 'pdf', fileName: 'a.pdf' },
        { id: 'bad-hash', hash: 'xyz', fileType: 'pdf' },
        { id: 'bad-type', hash: HASH, fileType: 'exe' },
      ],
    });
    expect(snapshot.documents.map((record) => record.id)).toEqual(['ok']);
  });

  it('migrates stored v1 data on first load', async () => {
    const area = createMemoryStorageArea({
      schemaVersion: 1,
      settings: {},
      assessments: [{ id: 'a', title: 'Essay', dueDate: '2026-12-11' }],
    });
    await createStorage(area).init();
    expect(area.dump()).toMatchObject({ schemaVersion: 3, documents: [] });
  });
});

describe('import limits', () => {
  it('uses safe defaults and clamps invalid values', () => {
    expect(normalizeSettings({}).importLimits).toEqual(DEFAULT_SETTINGS.importLimits);
    const limits = normalizeSettings({
      importLimits: { maxFileSizeMB: 5, maxPdfPages: 99999, maxBatchSize: 'x' },
    }).importLimits;
    expect(limits.maxFileSizeMB).toBe(5);
    expect(limits.maxPdfPages).toBe(DEFAULT_SETTINGS.importLimits.maxPdfPages);
    expect(limits.maxBatchSize).toBe(DEFAULT_SETTINGS.importLimits.maxBatchSize);
  });
});

describe('library storage', () => {
  it('writes deadlines and documents in a single storage call', async () => {
    const area = createMemoryStorageArea();
    const storage = createStorage(area);
    await storage.init();
    const writes = area.writes;
    await storage.updateLibrary(() => ({
      assessments: [{ id: 'a', title: 'Essay', dueDate: '2026-12-11' }],
      documents: [{ id: 'd', hash: HASH, fileType: 'docx', fileName: 'brief.docx' }],
    }));
    expect(area.writes).toBe(writes + 1);
    const state = await storage.getState();
    expect(state.documents[0]).toEqual(
      normalizeDocumentRecord({ id: 'd', hash: HASH, fileType: 'docx', fileName: 'brief.docx' }),
    );
  });

  it('notifies subscribers about library changes', async () => {
    const area = createMemoryStorageArea();
    const storage = createStorage(area);
    await storage.init();
    const updates = [];
    storage.subscribe((update) => updates.push(update));
    await storage.updateDocuments(() => [
      { id: 'd', hash: HASH, fileType: 'pdf', fileName: 'x.pdf' },
    ]);
    expect(updates.at(-1).documents).toHaveLength(1);
  });
});

describe('manual deadlines with Stage 2 fields', () => {
  it('creates, edits and validates requirements, instructions and related dates', async () => {
    const storage = createStorage(createMemoryStorageArea());
    const service = createAssessmentService({ storage });
    const { assessment } = await service.create({
      title: 'Group presentation',
      dueDate: '2026-12-07',
      submissionMethod: 'Brightspace',
      groupSize: '3–4 students',
      instructions: 'Use the template\nCite sources',
      relatedDates: [
        { label: 'presentation', date: '2026-12-08', time: '10:00', note: '15 minutes' },
      ],
    });
    expect(assessment.instructions).toEqual(['Use the template', 'Cite sources']);
    expect(assessment.relatedDates[0]).toMatchObject({ label: 'presentation', date: '2026-12-08' });
    expect(assessment.confirmedFields).toEqual(
      expect.arrayContaining(['submissionMethod', 'relatedDates']),
    );

    const bad = await service.update(assessment.id, {
      relatedDates: [{ label: 'presentation', date: '2026-02-30' }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.relatedDates).toBeTruthy();

    const edited = await service.update(assessment.id, {
      markingCriteria: ['Delivery 50%'],
      wordCount: '1,000 words',
    });
    expect(edited.assessment).toMatchObject({
      markingCriteria: ['Delivery 50%'],
      wordCount: '1,000 words',
    });
  });
});
