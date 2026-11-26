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

export function createBackup({ assessments, settings }, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    assessments,
    settings,
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
    skipped: result.dropped,
  };
}

/**
 * Combine a backup with current data.
 * - replace: the backup becomes the whole list.
 * - merge: records are matched by id and the most recently updated copy wins;
 *   records only in one side are kept.
 */
export function mergeAssessments(current, incoming, mode = 'merge') {
  if (mode === 'replace') return incoming.slice();
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}
