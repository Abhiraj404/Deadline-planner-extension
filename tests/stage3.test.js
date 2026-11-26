import { describe, expect, it } from 'vitest';
import { createStorage } from '../src/services/storage.js';
import { migrateSnapshot, CURRENT_SCHEMA_VERSION } from '../src/services/migrations.js';
import { demoAssessments, loadDemoData, removeDemoData } from '../src/services/demo.js';
import { createAssessmentService } from '../src/services/assessments.js';
import { normalizeSettings } from '../src/models/settings.js';
import { moduleColorClass, moduleColorIndex } from '../src/utils/module-colors.js';
import { filterAssessments } from '../src/services/query.js';
import { createMemoryStorageArea } from './helpers/chrome-mock.js';

describe('schema version 3', () => {
  it('adds pinned and demo flags to older records without changing them', () => {
    const { snapshot } = migrateSnapshot({
      schemaVersion: 2,
      assessments: [{ id: 'a', title: 'Essay', dueDate: '2026-12-11', notes: 'keep' }],
      documents: [],
    });
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(snapshot.assessments[0]).toMatchObject({ pinned: false, isDemo: false, notes: 'keep' });
  });
});

describe('demo data', () => {
  it('is synthetic, relative to today and clearly marked', () => {
    const items = demoAssessments(normalizeSettings({}), new Date('2026-11-25T10:00:00Z'));
    expect(items.length).toBeGreaterThan(5);
    expect(
      items.every((item) => item.isDemo && item.moduleCode?.startsWith('DEMO') !== false),
    ).toBe(true);
    expect(items.some((item) => item.dueDate === '2026-11-25')).toBe(true);
  });

  it('loads once, never overwrites real deadlines, and removes only demo records', async () => {
    const storage = createStorage(createMemoryStorageArea());
    const service = createAssessmentService({ storage });
    await service.create({ title: 'My real essay', dueDate: '2026-12-11' });
    const added = await loadDemoData(storage);
    expect(added).toBeGreaterThan(5);
    expect(await loadDemoData(storage)).toBe(0);
    expect((await service.list()).length).toBe(added + 1);
    expect(await removeDemoData(storage)).toBe(added);
    expect((await service.list()).map((item) => item.title)).toEqual(['My real essay']);
  });
});

describe('pinning and module colours', () => {
  it('toggles pinned', async () => {
    const storage = createStorage(createMemoryStorageArea());
    const service = createAssessmentService({ storage });
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    expect((await service.togglePinned(assessment.id)).assessment.pinned).toBe(true);
    expect((await service.togglePinned(assessment.id)).assessment.pinned).toBe(false);
  });

  it('gives each module a stable colour', () => {
    expect(moduleColorIndex('COMP3010')).toBe(moduleColorIndex('comp3010'));
    expect(moduleColorClass(null)).toBeNull();
    expect(moduleColorClass('HIST1')).toMatch(/^module-color-[0-7]$/);
  });
});

describe('search and filtering of imported and manual deadlines', () => {
  it('finds by document name and filters by source', () => {
    const items = [
      {
        id: '1',
        title: 'Essay',
        dueDate: '2026-12-11',
        tags: [],
        completed: false,
        sourceType: 'manual',
        category: 'assignment',
        moduleCode: null,
        moduleName: null,
        sourceDocument: null,
      },
      {
        id: '2',
        title: 'Report',
        dueDate: '2026-12-12',
        tags: [],
        completed: false,
        sourceType: 'pdf',
        category: 'assignment',
        moduleCode: 'X1',
        moduleName: null,
        sourceDocument: { name: 'ca2-brief.pdf' },
      },
    ];
    expect(filterAssessments(items, { search: 'ca2-brief' }).map((item) => item.id)).toEqual(['2']);
    expect(filterAssessments(items, { source: 'manual' }).map((item) => item.id)).toEqual(['1']);
  });
});
