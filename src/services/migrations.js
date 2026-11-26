/**
 * Storage migrations.
 *
 * Each migration upgrades the whole stored snapshot by one schema version. They are
 * pure functions (data in, data out) so they are easy to test and never touch
 * chrome.storage directly. To change the stored shape later:
 *   1. bump CURRENT_SCHEMA_VERSION,
 *   2. add `MIGRATIONS[newVersion] = (snapshot) => upgradedSnapshot`,
 *   3. add a test in tests/storage.test.js.
 */

import { normalizeAssessment } from '../models/assessment.js';
import { normalizeDocumentRecord } from '../models/document.js';
import { normalizeSettings } from '../models/settings.js';

export const CURRENT_SCHEMA_VERSION = 3;

/**
 * Version 0 is the shape sketched in the original Deadline Planner extension plan:
 * `{ id, title, module, due, time, weighting: "40%", notes, completed, created_at,
 *    source_file_name }`. It is upgraded to the camelCase model.
 */
function fromLegacyItem(item) {
  if (!item || typeof item !== 'object') return null;
  const weighting =
    typeof item.weighting === 'string' ? Number.parseFloat(item.weighting) : item.weighting;
  return {
    ...item,
    moduleName: item.moduleName ?? item.module ?? null,
    dueDate: item.dueDate ?? item.due ?? null,
    dueTime: item.dueTime ?? item.time ?? null,
    weighting: Number.isFinite(weighting) ? weighting : null,
    createdAt: item.createdAt ?? item.created_at,
    updatedAt: item.updatedAt ?? item.updated_at ?? item.created_at,
    sourceType: item.sourceType ?? 'manual',
  };
}

const MIGRATIONS = {
  1(snapshot) {
    const items = Array.isArray(snapshot.assessments) ? snapshot.assessments : [];
    return {
      ...snapshot,
      assessments: items.map(fromLegacyItem),
      settings: normalizeSettings(snapshot.settings),
    };
  },
  /**
   * Version 2 (Stage 2) adds the document library (`documents`) and new assessment
   * fields (submissionMethod, wordCount, groupSize, instructions, markingCriteria,
   * relatedDates). Existing deadlines get empty values; nothing is invented.
   */
  2(snapshot) {
    return { ...snapshot, documents: Array.isArray(snapshot.documents) ? snapshot.documents : [] };
  },
  /**
   * Version 3 (Stage 3) adds `pinned` and `isDemo` to deadlines (both false for existing
   * records, filled in by normalisation) and the separate `reminderState` key.
   */
  3(snapshot) {
    return snapshot;
  },
};

/**
 * Upgrade a snapshot `{ schemaVersion, assessments, settings }` to the current version.
 * Records that cannot be repaired are dropped and counted in `dropped`.
 * A snapshot from a newer version is returned unchanged with `readOnly: true`,
 * so an older build never overwrites data it does not understand.
 */
export function migrateSnapshot(snapshot) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const startVersion = Number.isInteger(input.schemaVersion) ? input.schemaVersion : 0;

  if (startVersion > CURRENT_SCHEMA_VERSION) {
    return {
      snapshot: input,
      changed: false,
      readOnly: true,
      dropped: 0,
      fromVersion: startVersion,
    };
  }

  let current = { ...input };
  for (let version = startVersion + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
    current = MIGRATIONS[version](current);
    current.schemaVersion = version;
  }

  const rawItems = Array.isArray(current.assessments) ? current.assessments : [];
  const seenIds = new Set();
  const assessments = [];
  for (const raw of rawItems) {
    const item = normalizeAssessment(raw);
    if (!item || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    assessments.push(item);
  }

  const documentIds = new Set();
  const documents = [];
  for (const raw of Array.isArray(current.documents) ? current.documents : []) {
    const record = normalizeDocumentRecord(raw);
    if (!record || documentIds.has(record.id)) continue;
    documentIds.add(record.id);
    documents.push(record);
  }

  return {
    snapshot: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      assessments,
      settings: normalizeSettings(current.settings),
      documents,
    },
    changed: startVersion !== CURRENT_SCHEMA_VERSION,
    readOnly: false,
    dropped: rawItems.length - assessments.length,
    fromVersion: startVersion,
  };
}
