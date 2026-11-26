import { describe, expect, it } from 'vitest';
import { createStorage, StorageError } from '../src/services/storage.js';
import { CURRENT_SCHEMA_VERSION, migrateSnapshot } from '../src/services/migrations.js';
import { DEFAULT_SETTINGS } from '../src/models/settings.js';
import { createFailingStorageArea, createMemoryStorageArea } from './helpers/chrome-mock.js';

describe('storage initialisation', () => {
  it('writes a fresh snapshot with defaults on first run', async () => {
    const area = createMemoryStorageArea();
    const storage = createStorage(area);
    await storage.init();
    const data = area.dump();
    expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(data.assessments).toEqual([]);
    expect(data.settings).toEqual({
      ...DEFAULT_SETTINGS,
      defaultReminderOffsets: [10080, 1440],
      customCategories: [],
    });
    expect(data.settings.timeZone).toBe('Europe/Dublin');
  });

  it('is idempotent and does not rewrite current data', async () => {
    const area = createMemoryStorageArea();
    await createStorage(area).init();
    const writes = area.writes;
    const second = createStorage(area);
    await second.init();
    await second.init();
    expect(area.writes).toBe(writes);
  });

  it('fills in missing settings keys without losing saved ones', async () => {
    const area = createMemoryStorageArea({
      schemaVersion: 1,
      assessments: [],
      settings: { theme: 'dark', dueSoonDays: 5 },
    });
    const settings = await createStorage(area).getSettings();
    expect(settings.theme).toBe('dark');
    expect(settings.dueSoonDays).toBe(5);
    expect(settings.reminderTime).toBe('09:00');
  });

  it('drops corrupt records and keeps valid ones', async () => {
    const area = createMemoryStorageArea({
      schemaVersion: 1,
      settings: {},
      assessments: [
        { id: 'ok', title: 'Valid', dueDate: '2026-12-11' },
        { id: 'bad-date', title: 'Broken', dueDate: 'soon' },
        null,
        'text',
        { id: 'ok', title: 'Duplicate id', dueDate: '2026-12-12' },
      ],
    });
    const items = await createStorage(area).getAssessments();
    expect(items.map((item) => item.id)).toEqual(['ok']);
  });

  it('wraps storage failures in a readable error', async () => {
    const storage = createStorage(createFailingStorageArea());
    await expect(storage.init()).rejects.toBeInstanceOf(StorageError);
    await expect(storage.init()).rejects.toThrow(/storage is full/i);
  });
});

describe('migrations', () => {
  it('upgrades the legacy v0 shape from the original extension plan', () => {
    const legacy = {
      assessments: [
        {
          id: 'legacy-1',
          title: 'CA2 Group Project Report',
          module: 'Software Engineering',
          due: '2026-12-11',
          time: '17:00',
          weighting: '40%',
          notes: 'Bring printout',
          completed: false,
          created_at: '2026-10-01T09:00:00.000Z',
          source_file_name: 'brief.pdf',
        },
      ],
    };
    const { snapshot, changed, fromVersion } = migrateSnapshot(legacy);
    expect(changed).toBe(true);
    expect(fromVersion).toBe(0);
    expect(snapshot.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(snapshot.assessments[0]).toMatchObject({
      id: 'legacy-1',
      moduleName: 'Software Engineering',
      dueDate: '2026-12-11',
      dueTime: '17:00',
      weighting: 40,
      notes: 'Bring printout',
      sourceType: 'manual',
      createdAt: '2026-10-01T09:00:00.000Z',
    });
  });

  it('migrates legacy data in storage on first load and persists it', async () => {
    const area = createMemoryStorageArea({
      assessments: [{ id: 'x', title: 'Old', due: '2026-01-05', module: 'Maths' }],
    });
    await createStorage(area).init();
    const data = area.dump();
    expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(data.assessments[0].moduleName).toBe('Maths');
    expect(data.assessments[0].dueDate).toBe('2026-01-05');
  });

  it('never overwrites data from a newer schema version', async () => {
    const future = {
      schemaVersion: 99,
      assessments: [{ id: 'f', shape: 'unknown' }],
      settings: {},
    };
    const area = createMemoryStorageArea(future);
    const storage = createStorage(area);
    const result = await storage.init();
    expect(result.readOnly).toBe(true);
    expect(storage.readOnly).toBe(true);
    await expect(storage.saveAssessments([])).rejects.toThrow(/newer version/);
    expect(area.dump()).toEqual(future);
  });

  it('treats missing or garbage snapshots as empty', () => {
    expect(migrateSnapshot(undefined).snapshot.assessments).toEqual([]);
    expect(migrateSnapshot({ assessments: 'nope' }).snapshot.assessments).toEqual([]);
  });
});

describe('storage writes and change events', () => {
  it('persists across storage instances (like reopening the popup)', async () => {
    const area = createMemoryStorageArea();
    await createStorage(area).saveAssessments([{ id: 'a', title: 'Saved', dueDate: '2026-12-11' }]);
    const reopened = createStorage(area);
    expect((await reopened.getAssessments())[0].title).toBe('Saved');
  });

  it('skips the write when an update returns the same list', async () => {
    const area = createMemoryStorageArea();
    const storage = createStorage(area);
    await storage.init();
    const writes = area.writes;
    await storage.updateAssessments((items) => items);
    expect(area.writes).toBe(writes);
  });

  it('notifies subscribers with normalised values', async () => {
    const area = createMemoryStorageArea();
    const storage = createStorage(area);
    await storage.init();
    const updates = [];
    storage.subscribe((update) => updates.push(update));
    await storage.saveSettings({ theme: 'light' });
    expect(updates.at(-1).settings.theme).toBe('light');
    expect(updates.at(-1).settings.timeZone).toBe('Europe/Dublin');
  });
});
