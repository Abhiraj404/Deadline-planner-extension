import { describe, expect, it } from 'vitest';
import { createAssessment } from '../src/models/assessment.js';
import { normalizeSettings } from '../src/models/settings.js';
import {
  BACKUP_FORMAT,
  backupFileName,
  createBackup,
  planRestore,
  parseBackup,
} from '../src/services/backup.js';
import { sequentialIds } from './helpers/chrome-mock.js';

const now = new Date('2026-11-25T10:00:00Z');
const ids = sequentialIds('m');
const manual = createAssessment(
  {
    title: 'Manual essay',
    dueDate: '2026-12-11',
    notes: 'Notes survive backups',
    checklist: [{ text: 'Draft', done: true }],
    reminderOffsets: [1440],
  },
  { now, idFactory: ids },
);
const settings = normalizeSettings({
  theme: 'dark',
  customCategories: [{ id: 'work', label: 'Work' }],
});

describe('backup and restore', () => {
  it('round-trips manual deadlines and settings exactly', () => {
    const text = JSON.stringify(createBackup({ assessments: [manual], settings }, now));
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.assessments).toEqual([manual]);
    expect(parsed.settings).toEqual(settings);
    expect(parsed.skipped).toBe(0);
  });

  it('rejects invalid files with a clear message', () => {
    expect(parseBackup('').ok).toBe(false);
    expect(parseBackup('{not json').error).toMatch(/invalid JSON/);
    expect(parseBackup(JSON.stringify({ hello: 'world' })).error).toMatch(
      /not a Deadline Reminder backup/,
    );
    expect(
      parseBackup(JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 99, assessments: [] }))
        .error,
    ).toMatch(/newer version/);
  });

  it('skips invalid records but restores the rest', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      schemaVersion: 1,
      assessments: [manual, { title: 'No date' }],
      settings: {},
    });
    const parsed = parseBackup(text);
    expect(parsed.assessments).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it('upgrades a backup made with the legacy v0 shape', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      assessments: [{ id: 'old', title: 'Old', due: '2026-12-01', module: 'Maths' }],
    });
    const parsed = parseBackup(text);
    expect(parsed.assessments[0]).toMatchObject({ dueDate: '2026-12-01', moduleName: 'Maths' });
  });

  it('previews a merge: adds new, updates newer, skips duplicates by id and content', () => {
    const newer = { ...manual, title: 'Edited later', updatedAt: '2026-12-01T00:00:00.000Z' };
    const other = createAssessment(
      { title: 'Other', dueDate: '2026-12-20' },
      { now, idFactory: ids },
    );
    const recreated = createAssessment(
      { title: 'Other', dueDate: '2026-12-20' },
      { now, idFactory: ids },
    );
    const plan = planRestore([manual, recreated], [newer, other]);
    expect(plan.update.map((item) => item.title)).toEqual(['Edited later']);
    expect(plan.add).toEqual([]);
    expect(plan.duplicates.map((item) => item.title)).toEqual(['Other']); // same content, new id
    expect(plan.result).toHaveLength(2);
    // Restoring the same backup twice changes nothing.
    const again = planRestore(plan.result, [newer, other]);
    expect(again.add).toEqual([]);
    expect(again.update).toEqual([]);
  });

  it('keeps the current copy when it is newer than the backup', () => {
    const older = { ...manual, title: 'Old copy', updatedAt: '2020-01-01T00:00:00.000Z' };
    const plan = planRestore([manual], [older]);
    expect(plan.unchanged).toBe(1);
    expect(plan.result[0].title).toBe('Manual essay');
  });

  it('previews a replace and does not duplicate library records on merge', () => {
    const other = createAssessment(
      { title: 'Other', dueDate: '2026-12-20' },
      { now, idFactory: ids },
    );
    const plan = planRestore([manual], [other], 'replace');
    expect(plan.remove).toEqual([manual]);
    expect(plan.result).toEqual([other]);
    const doc = { id: 'd1', hash: 'a'.repeat(64) };
    const merged = planRestore([], [], 'merge', {
      currentDocuments: [doc],
      incomingDocuments: [doc, { id: 'd2', hash: 'a'.repeat(64) }],
    });
    expect(merged.documents.add).toBe(0);
  });

  it('names backup files by date', () => {
    expect(backupFileName(now)).toBe('deadline-reminder-backup-2026-11-25.json');
  });
});
