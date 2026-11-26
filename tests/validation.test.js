import { describe, expect, it } from 'vitest';
import { validateAssessmentInput } from '../src/utils/validation.js';

const base = { title: 'A', dueDate: '2026-12-11' };

describe('validateAssessmentInput', () => {
  it('needs only a title and a due date', () => {
    const result = validateAssessmentInput({ title: '  Essay  ', dueDate: '2026-12-11' });
    expect(result.valid).toBe(true);
    expect(result.value).toMatchObject({
      title: 'Essay',
      dueDate: '2026-12-11',
      dueTime: null,
      weighting: null,
      moduleName: null,
      moduleCode: null,
      submissionUrl: null,
      estimatedMinutes: null,
      reminderOffsets: null,
      priority: 'medium',
      tags: [],
      checklist: [],
    });
  });

  it('reports missing required fields', () => {
    const result = validateAssessmentInput({ title: ' ', dueDate: '' });
    expect(result.valid).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual(['dueDate', 'title']);
  });

  it('rejects impossible dates, bad times and out-of-range years', () => {
    expect(validateAssessmentInput({ ...base, dueDate: '2026-02-30' }).errors.dueDate).toBeTruthy();
    expect(validateAssessmentInput({ ...base, dueDate: '1900-01-01' }).errors.dueDate).toBeTruthy();
    expect(validateAssessmentInput({ ...base, dueTime: '25:00' }).errors.dueTime).toBeTruthy();
  });

  it('parses weighting as a percentage and rejects invalid values', () => {
    expect(validateAssessmentInput({ ...base, weighting: '40%' }).value.weighting).toBe(40);
    expect(validateAssessmentInput({ ...base, weighting: '' }).value.weighting).toBeNull();
    expect(validateAssessmentInput({ ...base, weighting: '150' }).errors.weighting).toBeTruthy();
    expect(validateAssessmentInput({ ...base, weighting: 'abc' }).errors.weighting).toBeTruthy();
  });

  it('only allows http(s) submission links', () => {
    const ok = validateAssessmentInput({
      ...base,
      submissionUrl: 'https://moodle.example.ie/mod/assign',
    });
    expect(ok.valid).toBe(true);
    for (const url of ['javascript:alert(1)', 'not a url', 'ftp://example.com']) {
      expect(
        validateAssessmentInput({ ...base, submissionUrl: url }).errors.submissionUrl,
      ).toBeTruthy();
    }
  });

  it('checks category against the allowed list when given', () => {
    const options = { categoryIds: ['assignment', 'exam'] };
    expect(validateAssessmentInput({ ...base, category: 'exam' }, options).valid).toBe(true);
    expect(
      validateAssessmentInput({ ...base, category: 'made-up' }, options).errors.category,
    ).toBeTruthy();
  });

  it('normalises tags, checklist, reminders and estimate', () => {
    const result = validateAssessmentInput({
      ...base,
      tags: 'report, Group, report ,',
      checklist: [{ text: ' Draft ' }, { text: '' }, 'Final copy'],
      reminderOffsets: [1440, 10080, 1440],
      estimatedMinutes: 90,
    });
    expect(result.valid).toBe(true);
    expect(result.value.tags).toEqual(['report', 'Group']);
    expect(result.value.checklist.map((item) => item.text)).toEqual(['Draft', 'Final copy']);
    expect(result.value.reminderOffsets).toEqual([10080, 1440]);
    expect(result.value.estimatedMinutes).toBe(90);
  });

  it('rejects invalid reminders, estimates and time zones', () => {
    expect(
      validateAssessmentInput({ ...base, reminderOffsets: [-5] }).errors.reminderOffsets,
    ).toBeTruthy();
    expect(
      validateAssessmentInput({ ...base, reminderOffsets: [999999] }).errors.reminderOffsets,
    ).toBeTruthy();
    expect(
      validateAssessmentInput({ ...base, estimatedMinutes: Number.NaN }).errors.estimatedMinutes,
    ).toBeTruthy();
    expect(
      validateAssessmentInput({ ...base, timeZone: 'Mars/Olympus' }).errors.timeZone,
    ).toBeTruthy();
  });

  it('copes with missing input entirely', () => {
    const result = validateAssessmentInput(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors.title).toBeTruthy();
  });
});
