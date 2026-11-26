/**
 * Assessment service: the operations the UI performs on deadlines.
 *
 * Manual and document-based deadlines go through exactly the same functions and the
 * same storage list; `sourceType` is just a field. Every write re-reads storage first
 * (see storage.updateAssessments) so two open pages do not clobber each other.
 */

import {
  applyChanges,
  createAssessment,
  createId,
  normalizeAssessment,
} from '../models/assessment.js';
import { getCategories } from '../models/settings.js';
import { validateAssessmentInput } from '../utils/validation.js';
import { applyDocumentChanges } from './documents.js';

export function createAssessmentService({ storage, now = () => new Date(), idFactory = createId }) {
  async function categoryIds() {
    const settings = await storage.getSettings();
    return { settings, ids: getCategories(settings).map((category) => category.id) };
  }

  async function list() {
    return storage.getAssessments();
  }

  async function get(id) {
    return (await storage.getAssessments()).find((item) => item.id === id) ?? null;
  }

  /** Create a deadline. Only `title` and `dueDate` are required. */
  async function create(input) {
    const { settings, ids } = await categoryIds();
    const withDefaults = {
      category: settings.defaultCategory,
      priority: settings.defaultPriority,
      ...input,
    };
    const result = validateAssessmentInput(withDefaults, { categoryIds: ids });
    if (!result.valid) return { ok: false, errors: result.errors };

    const assessment = createAssessment(
      {
        ...result.value,
        sourceType: input.sourceType,
        sourceDocument: input.sourceDocument ?? null,
      },
      { now: now(), idFactory, timeZone: settings.timeZone },
    );
    await storage.updateAssessments((items) => [...items, assessment]);
    return { ok: true, assessment };
  }

  async function modify(id, transform) {
    let outcome = { ok: false, errors: { form: 'This deadline no longer exists.' } };
    await storage.updateAssessments(async (items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return items;
      const result = await transform(items[index]);
      if (!result.ok) {
        outcome = result;
        return items;
      }
      outcome = { ok: true, assessment: result.assessment, changed: result.changed };
      if (!result.changed) return items;
      const next = items.slice();
      next[index] = result.assessment;
      return next;
    });
    return outcome;
  }

  /** Edit any user fields. The full merged record is re-validated. */
  async function update(id, changes) {
    const { ids } = await categoryIds();
    return modify(id, (existing) => {
      const merged = { ...existing, ...changes };
      // Only check the category when it is being changed: a record may still use a
      // custom category the user has since removed, and that must not block edits.
      const result = validateAssessmentInput(merged, {
        categoryIds: 'category' in changes ? ids : undefined,
      });
      if (!result.valid) return { ok: false, errors: result.errors };
      const editedValues = {};
      for (const key of Object.keys(changes)) {
        if (key in result.value) editedValues[key] = result.value[key];
      }
      return { ok: true, ...applyChanges(existing, editedValues, { now: now(), idFactory }) };
    });
  }

  async function togglePinned(id) {
    return modify(id, (existing) => ({
      ok: true,
      ...applyChanges(existing, { pinned: !existing.pinned }, { now: now(), idFactory }),
    }));
  }

  async function setCompleted(id, completed) {
    return modify(id, (existing) => ({
      ok: true,
      ...applyChanges(existing, { completed }, { now: now(), idFactory }),
    }));
  }

  async function toggleChecklistItem(id, itemId) {
    return modify(id, (existing) => {
      const checklist = existing.checklist.map((item) =>
        item.id === itemId ? { ...item, done: !item.done } : item,
      );
      return { ok: true, ...applyChanges(existing, { checklist }, { now: now(), idFactory }) };
    });
  }

  async function remove(id) {
    let removed = null;
    await storage.updateAssessments((items) => {
      removed = items.find((item) => item.id === id) ?? null;
      return removed ? items.filter((item) => item.id !== id) : items;
    });
    return removed;
  }

  /** Put back a deleted deadline (used by the Undo toast). */
  async function restore(assessment) {
    const item = normalizeAssessment(assessment);
    if (!item) return false;
    await storage.updateAssessments((items) =>
      items.some((existing) => existing.id === item.id) ? items : [...items, item],
    );
    return true;
  }

  async function detachDocument(id) {
    return modify(id, (existing) => ({
      ok: true,
      changed: existing.sourceDocument !== null,
      assessment: { ...existing, sourceDocument: null, updatedAt: now().toISOString() },
    }));
  }

  /**
   * Apply the fields the user chose from a document extraction (Stage 2 will call
   * this after showing the comparison). Unselected fields are left untouched.
   */
  async function applyExtraction(id, extraction, selectedFields, documentRef) {
    return modify(id, (existing) => {
      const assessment = applyDocumentChanges(existing, extraction, selectedFields, {
        now: now(),
        document: documentRef,
        idFactory,
      });
      return { ok: true, changed: assessment !== existing, assessment };
    });
  }

  return {
    list,
    get,
    create,
    update,
    setCompleted,
    togglePinned,
    toggleChecklistItem,
    remove,
    restore,
    detachDocument,
    applyExtraction,
  };
}
