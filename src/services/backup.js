/**
 * Backup and restore as a JSON file.
 *
 * A backup is a plain snapshot plus a small header. Restoring runs the same
 * migrations and normalisation as normal start-up, so an old or hand-edited file
 * cannot put invalid records into storage.
 */

import { CURRENT_SCHEMA_VERSION, migrateSnapshot } from './migrations.js';

export const BACKUP_FORMAT = 'deadline-reminder-backup';
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

export function createBackup({ assessments, settings, documents = [] }, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    assessments,
    settings,
    documents,
  };
}

export function backupFileName(now = new Date()) {
  return `deadline-reminder-backup-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Parse and validate backup text.
 * @returns {{ ok: true, assessments, settings, skipped } | { ok: false, error }}
 */
export function parseBackup(text) {
  if (typeof text !== 'string' || text.length === 0)
    return { ok: false, error: 'The file is empty.' };
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, error: 'The backup file is too large.' };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This is not a valid backup file (invalid JSON).' };
  }
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.assessments)) {
    return { ok: false, error: 'This file is not a Deadline Reminder backup.' };
  }
  const result = migrateSnapshot(data);
  if (result.readOnly) {
    return {
      ok: false,
      error: 'This backup was made by a newer version. Update the extension first.',
    };
  }
  return {
    ok: true,
    assessments: result.snapshot.assessments,
    settings: result.snapshot.settings,
    documents: result.snapshot.documents,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
    skipped: result.dropped,
  };
}

/** Same title, due date and module: treated as the same deadline even with another id. */
function contentKey(assessment) {
  return [
    assessment.title.trim().toLowerCase(),
    assessment.dueDate,
    (assessment.moduleCode ?? assessment.moduleName ?? '').toLowerCase(),
  ].join('|');
}

/**
 * Work out what a restore would do, without changing anything, so the user can see a
 * preview first. In "merge" mode records are matched by id (the newer copy wins) and
 * by content, so restoring the same backup twice, or a backup of deadlines that were
 * re-created by hand, never produces duplicates. "replace" swaps everything.
 * @returns {{ mode, add: object[], update: object[], unchanged: number, duplicates: object[],
 *   remove: object[], documents: { add: number, update: number }, result: object[] }}
 */
export function planRestore(
  current,
  incoming,
  mode = 'merge',
  { currentDocuments = [], incomingDocuments = [] } = {},
) {
  if (mode === 'replace') {
    return {
      mode,
      add: incoming,
      update: [],
      unchanged: 0,
      duplicates: [],
      remove: current,
      documents: { add: incomingDocuments.length, update: 0 },
      result: incoming.slice(),
      resultDocuments: incomingDocuments.slice(),
    };
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  const byContent = new Map(current.map((item) => [contentKey(item), item]));
  const add = [];
  const update = [];
  const duplicates = [];
  let unchanged = 0;
  const result = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (existing) {
      if (item.updatedAt > existing.updatedAt) {
        update.push(item);
        result.set(item.id, item);
      } else unchanged += 1;
      continue;
    }
    if (byContent.has(contentKey(item))) {
      duplicates.push(item);
      continue;
    }
    byContent.set(contentKey(item), item);
    add.push(item);
    result.set(item.id, item);
  }
  const docIds = new Set(currentDocuments.map((record) => record.id));
  const docHashes = new Set(currentDocuments.map((record) => record.hash));
  const newDocuments = incomingDocuments.filter(
    (record) => !docIds.has(record.id) && !docHashes.has(record.hash),
  );
  return {
    mode,
    add,
    update,
    unchanged,
    duplicates,
    remove: [],
    documents: { add: newDocuments.length, update: 0 },
    result: [...result.values()],
    resultDocuments: [...currentDocuments, ...newDocuments],
  };
}
