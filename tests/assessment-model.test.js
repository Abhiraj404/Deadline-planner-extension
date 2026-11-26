import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  createAssessment,
  moduleKey,
  normalizeAssessment,
  setCompleted,
} from '../src/models/assessment.js';
import { sequentialIds } from './helpers/chrome-mock.js';

const now = new Date('2026-11-25T10:00:00Z');

describe('createAssessment', () => {
  it('creates a manual deadline with unknown fields left null', () => {
    const item = createAssessment(
      { title: 'Essay', dueDate: '2026-12-11' },
      { now, idFactory: sequentialIds() },
    );
    expect(item).toMatchObject({
      id: 'id-1',
      title: 'Essay',
      dueDate: '2026-12-11',
      dueTime: null,
      timeZone: 'Europe/Dublin',
      weighting: null,
      moduleName: null,
      moduleCode: null,
      description: null,
      notes: null,
      submissionUrl: null,
      estimatedMinutes: null,
      reminderOffsets: null,
      completed: false,
      completedAt: null,
      sourceType: 'manual',
      sourceDocument: null,
      extractionConfidence: null,
      userConfirmed: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(item.confirmedFields).toEqual(['title', 'category', 'dueDate', 'timeZone', 'priority']);
  });

  it('is JSON round-trippable', () => {
    const item = createAssessment(
      { title: 'Lab', dueDate: '2026-12-01', checklist: ['Report'] },
      { now },
    );
    expect(normalizeAssessment(JSON.parse(JSON.stringify(item)))).toEqual(item);
  });

  it('marks extracted records as unconfirmed until the user confirms them', () => {
    const item = createAssessment(
      { title: 'Brief', dueDate: '2026-12-01', sourceType: 'pdf' },
      { now },
    );
    expect(item.sourceType).toBe('pdf');
    expect(item.userConfirmed).toBe(false);
    expect(item.confirmedFields).toEqual([]);
  });
});

describe('applyChanges', () => {
  const base = createAssessment(
    { title: 'Essay', dueDate: '2026-12-11' },
    { now, idFactory: sequentialIds() },
  );

  it('returns the same object when nothing changes', () => {
    const result = applyChanges(base, { title: 'Essay' }, { now });
    expect(result.changed).toBe(false);
    expect(result.assessment).toBe(base);
  });

  it('updates fields, timestamps and confirmed fields', () => {
    const later = new Date('2026-11-26T10:00:00Z');
    const { assessment, changed } = applyChanges(
      base,
      { weighting: 40, notes: 'Ask about format' },
      { now: later },
    );
    expect(changed).toBe(true);
    expect(assessment.weighting).toBe(40);
    expect(assessment.notes).toBe('Ask about format');
    expect(assessment.updatedAt).toBe(later.toISOString());
    expect(assessment.createdAt).toBe(base.createdAt);
    expect(assessment.confirmedFields).toEqual(expect.arrayContaining(['weighting', 'notes']));
    expect(base.weighting).toBeNull(); // the original is not mutated
  });

  it('tracks completion time and clears it when reopened', () => {
    const done = setCompleted(base, true, { now }).assessment;
    expect(done.completed).toBe(true);
    expect(done.completedAt).toBe(now.toISOString());
    const reopened = setCompleted(done, false, { now }).assessment;
    expect(reopened.completed).toBe(false);
    expect(reopened.completedAt).toBeNull();
  });

  it('refuses to remove the title or date', () => {
    expect(() => applyChanges(base, { title: '' }, { now })).toThrow();
  });
});

describe('normalizeAssessment', () => {
  it('returns null for records without the essentials', () => {
    expect(normalizeAssessment(null)).toBeNull();
    expect(normalizeAssessment({ title: 'x' })).toBeNull();
    expect(normalizeAssessment({ title: '', dueDate: '2026-01-01' })).toBeNull();
    expect(normalizeAssessment({ title: 'x', dueDate: '2026-02-31' })).toBeNull();
  });

  it('repairs invalid optional values instead of inventing data', () => {
    const item = normalizeAssessment({
      id: 'a',
      title: 'x',
      dueDate: '2026-01-01',
      dueTime: '99:99',
      weighting: 'lots',
      priority: 'urgent',
      sourceType: 'email',
      timeZone: 'Nowhere/Here',
      tags: 'a,b',
    });
    expect(item).toMatchObject({
      dueTime: null,
      weighting: null,
      priority: 'medium',
      sourceType: 'manual',
      timeZone: 'Europe/Dublin',
      tags: ['a', 'b'],
    });
  });

  it('uses the module code, then the name, as the grouping key', () => {
    expect(moduleKey({ moduleCode: 'COMP3010', moduleName: 'SE' })).toBe('COMP3010');
    expect(moduleKey({ moduleCode: null, moduleName: 'SE' })).toBe('SE');
    expect(moduleKey({ moduleCode: null, moduleName: null })).toBeNull();
  });
});
