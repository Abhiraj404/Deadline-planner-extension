import { beforeEach, describe, expect, it } from 'vitest';
import { createAssessmentService } from '../src/services/assessments.js';
import { createStorage } from '../src/services/storage.js';
import { createMemoryStorageArea, sequentialIds } from './helpers/chrome-mock.js';

let area;
let storage;
let service;
let clock;

beforeEach(() => {
  area = createMemoryStorageArea();
  storage = createStorage(area);
  clock = new Date('2026-11-25T10:00:00Z');
  service = createAssessmentService({ storage, now: () => clock, idFactory: sequentialIds() });
});

describe('creating deadlines without documents', () => {
  it('creates a deadline from only a title and date', async () => {
    const result = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    expect(result.ok).toBe(true);
    expect(result.assessment).toMatchObject({
      title: 'Essay',
      sourceType: 'manual',
      sourceDocument: null,
      category: 'assignment',
      priority: 'medium',
      reminderOffsets: null, // uses the default reminders
    });
    expect(await service.list()).toHaveLength(1);
  });

  it('applies user defaults for category, priority and time zone', async () => {
    await storage.saveSettings({
      defaultCategory: 'personal',
      defaultPriority: 'high',
      timeZone: 'America/New_York',
    });
    const { assessment } = await service.create({ title: 'Dentist', dueDate: '2026-12-02' });
    expect(assessment.category).toBe('personal');
    expect(assessment.priority).toBe('high');
    expect(assessment.timeZone).toBe('America/New_York');
  });

  it('supports non-academic categories and custom ones', async () => {
    await storage.saveSettings({ customCategories: [{ id: 'work', label: 'Work' }] });
    expect(
      (await service.create({ title: 'Shift', dueDate: '2026-12-02', category: 'work' })).ok,
    ).toBe(true);
    expect(
      (await service.create({ title: 'GP', dueDate: '2026-12-02', category: 'appointment' })).ok,
    ).toBe(true);
    const bad = await service.create({ title: 'X', dueDate: '2026-12-02', category: 'unknown' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.category).toBeTruthy();
  });

  it('returns validation errors and stores nothing', async () => {
    const result = await service.create({ title: '', dueDate: '2026-02-30' });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveProperty('title');
    expect(result.errors).toHaveProperty('dueDate');
    expect(await service.list()).toEqual([]);
  });

  it('stores all optional fields when provided', async () => {
    const { assessment } = await service.create({
      title: 'CA2 Report',
      dueDate: '2026-12-11',
      dueTime: '17:00',
      moduleName: 'Software Engineering',
      moduleCode: 'COMP3010',
      weighting: '40',
      priority: 'high',
      description: 'Group report',
      notes: 'Meet Tuesday',
      submissionUrl: 'https://moodle.example.ie/assign/1',
      checklist: [{ text: 'Draft' }, { text: 'Final' }],
      reminderOffsets: [4320],
      estimatedMinutes: 600,
      tags: 'group, report',
    });
    expect(assessment).toMatchObject({
      dueTime: '17:00',
      moduleCode: 'COMP3010',
      weighting: 40,
      reminderOffsets: [4320],
      estimatedMinutes: 600,
      tags: ['group', 'report'],
    });
    expect(assessment.checklist).toHaveLength(2);
  });
});

describe('editing, completing and deleting', () => {
  it('edits a manual deadline and keeps untouched fields', async () => {
    const { assessment } = await service.create({
      title: 'Essay',
      dueDate: '2026-12-11',
      notes: 'Keep me',
    });
    clock = new Date('2026-11-26T10:00:00Z');
    const result = await service.update(assessment.id, { dueDate: '2026-12-14', dueTime: '12:00' });
    expect(result.ok).toBe(true);
    expect(result.assessment).toMatchObject({
      dueDate: '2026-12-14',
      dueTime: '12:00',
      notes: 'Keep me',
    });
    expect(result.assessment.updatedAt).toBe(clock.toISOString());
    expect(result.assessment.createdAt).toBe('2026-11-25T10:00:00.000Z');
  });

  it('rejects invalid edits without saving them', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    const result = await service.update(assessment.id, { weighting: '300' });
    expect(result.ok).toBe(false);
    expect((await service.get(assessment.id)).weighting).toBeNull();
  });

  it('allows edits to records whose custom category was later removed', async () => {
    await storage.saveSettings({ customCategories: [{ id: 'work', label: 'Work' }] });
    const { assessment } = await service.create({
      title: 'Shift',
      dueDate: '2026-12-02',
      category: 'work',
    });
    await storage.saveSettings({ customCategories: [] });
    expect((await service.update(assessment.id, { notes: 'Bring badge' })).ok).toBe(true);
  });

  it('does not write when an edit changes nothing', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    const writes = area.writes;
    const result = await service.update(assessment.id, { title: 'Essay' });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(area.writes).toBe(writes);
  });

  it('completes and reopens a deadline', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    const done = await service.setCompleted(assessment.id, true);
    expect(done.assessment.completed).toBe(true);
    expect(done.assessment.completedAt).toBe(clock.toISOString());
    const reopened = await service.setCompleted(assessment.id, false);
    expect(reopened.assessment.completed).toBe(false);
    expect(reopened.assessment.completedAt).toBeNull();
  });

  it('toggles checklist items without touching others', async () => {
    const { assessment } = await service.create({
      title: 'Lab',
      dueDate: '2026-12-11',
      checklist: [{ text: 'Data' }, { text: 'Write-up' }],
    });
    const [first, second] = assessment.checklist;
    const result = await service.toggleChecklistItem(assessment.id, first.id);
    expect(result.assessment.checklist.find((item) => item.id === first.id).done).toBe(true);
    expect(result.assessment.checklist.find((item) => item.id === second.id).done).toBe(false);
  });

  it('deletes a deadline and can restore it (undo)', async () => {
    const { assessment } = await service.create({ title: 'Essay', dueDate: '2026-12-11' });
    await service.create({ title: 'Other', dueDate: '2026-12-12' });
    const removed = await service.remove(assessment.id);
    expect(removed.id).toBe(assessment.id);
    expect((await service.list()).map((item) => item.title)).toEqual(['Other']);
    await service.restore(removed);
    expect(await service.get(assessment.id)).toEqual(assessment);
  });

  it('reports a missing deadline instead of throwing', async () => {
    expect((await service.update('nope', { title: 'x' })).ok).toBe(false);
    expect(await service.remove('nope')).toBeNull();
  });
});

describe('documents on manual deadlines', () => {
  it('detaches a document reference', async () => {
    const doc = {
      id: 'doc-1',
      name: 'brief.pdf',
      type: 'pdf',
      size: 1200,
      attachedAt: clock.toISOString(),
    };
    const { assessment } = await service.create({
      title: 'Essay',
      dueDate: '2026-12-11',
      notes: 'Mine',
      sourceDocument: doc,
    });
    expect(assessment.sourceDocument).toEqual(doc);
    const detached = await service.detachDocument(assessment.id);
    expect(detached.assessment.sourceDocument).toBeNull();
    expect(detached.assessment.notes).toBe('Mine');
  });

  it('creates a deadline manually with a linked document when extraction is unavailable', async () => {
    const doc = {
      id: 'doc-2',
      name: 'brief.docx',
      type: 'docx',
      size: 5000,
      attachedAt: clock.toISOString(),
    };
    const { assessment } = await service.create({
      title: 'Report',
      dueDate: '2026-12-11',
      sourceDocument: doc,
    });
    expect(assessment.sourceType).toBe('manual');
    expect(assessment.sourceDocument.name).toBe('brief.docx');
  });

  it('applies only the selected extracted fields', async () => {
    const { assessment } = await service.create({
      title: 'Essay',
      dueDate: '2026-12-11',
      notes: 'Mine',
    });
    const extraction = {
      confidence: 'high',
      fields: {
        title: { value: 'CA2 Essay', confidence: 'high' },
        weighting: { value: 30, confidence: 'high' },
      },
    };
    const result = await service.applyExtraction(assessment.id, extraction, ['weighting'], null);
    expect(result.assessment.weighting).toBe(30);
    expect(result.assessment.title).toBe('Essay');
    expect(result.assessment.notes).toBe('Mine');
  });
});
