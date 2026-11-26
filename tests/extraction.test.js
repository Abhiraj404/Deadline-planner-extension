import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  confidenceCategory,
  extractAssessments,
  overallConfidence,
} from '../src/extraction/engine.js';
import { daylightSavingNote, findDates, suggestYears } from '../src/extraction/date-parser.js';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/extraction-cases.json', import.meta.url), 'utf8'),
);

function resolvePath(object, path) {
  return path.split('.').reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return key === 'length' ? value.length : value[/^\d+$/.test(key) ? Number(key) : key];
  }, object);
}

const first = (text, options) => extractAssessments(text, options).assessments[0];

describe('shared fixture cases (ported from the Python planner)', () => {
  for (const testCase of fixtures.cases) {
    it(testCase.name, () => {
      const candidate = first(testCase.text);
      for (const [path, expected] of Object.entries(testCase.expected)) {
        expect(resolvePath(candidate, path), path).toEqual(expected);
      }
    });
  }
});

describe('date formats', () => {
  const value = (text) => first(text).submissionDeadline?.value;

  it('recognises the common written forms', () => {
    expect(value('Due date: 04/12/2026')).toBe('2026-12-04');
    expect(value('Due date: 4 December 2026')).toBe('2026-12-04');
    expect(value('Due date: Friday, 4th December 2026')).toBe('2026-12-04');
    expect(value('Due date: 2026-12-04')).toBe('2026-12-04');
    expect(value('Due date: December 4, 2026')).toBe('2026-12-04');
    expect(value('Due date: 4th of Dec. 2026')).toBe('2026-12-04');
  });

  it('reads 12- and 24-hour times', () => {
    expect(first('Submit by 04/12/2026 at 23:59').submissionDeadline.time).toBe('23:59');
    expect(first('Deadline: 4 December 2026 at 11:59 PM').submissionDeadline.time).toBe('23:59');
    expect(first('Deadline: 4 December 2026, 5 p.m.').submissionDeadline.time).toBe('17:00');
    expect(first('Deadline: 4 December 2026 at 12am').submissionDeadline.time).toBe('00:00');
  });

  it('offers the US reading of an ambiguous numeric date instead of choosing it', () => {
    const deadline = first('Submit by 04/12/2026 at 23:59').submissionDeadline;
    expect(deadline.value).toBe('2026-12-04');
    expect(deadline.confidence).toBe('medium');
    expect(deadline.alternatives).toEqual([
      { date: '2026-04-12', reason: 'Month/day/year (US format)' },
    ]);
    expect(confidenceCategory(deadline)).toBe('review');
  });

  it('does not offer an alternative when only one reading is possible', () => {
    expect(first('Due: 25/12/2026').submissionDeadline.alternatives).toEqual([]);
  });

  it('never fills in a missing year, but suggests the next occurrence', () => {
    const candidate = first('Submit by 4 December at 11:59 PM', { referenceDate: '2026-11-26' });
    const deadline = candidate.submissionDeadline;
    expect(deadline.value).toBeNull();
    expect(deadline.yearMissing).toBe(true);
    expect(deadline.time).toBe('23:59');
    expect(deadline.suggestions[0]).toBe('2026-12-04');
    expect(candidate.needsConfirmation).toBe(true);
  });

  it('suggests next year for early-January dates seen in December', () => {
    expect(suggestYears(1, 8, '2026-12-20')[0]).toBe('2027-01-08');
    expect(suggestYears(2, 29, '2026-12-20')).toEqual(['2028-02-29']);
  });

  it('uses a weekday to narrow the suggested year', () => {
    const deadline = first('Deadline: Friday 4 December', {
      referenceDate: '2025-06-01',
    }).submissionDeadline;
    expect(deadline.value).toBeNull();
    expect(deadline.suggestions[0]).toBe('2026-12-04'); // the year when 4 Dec is a Friday
  });

  it('reports "due by Friday at 5 PM" as a suggestion only', () => {
    const candidate = first('Due by Friday at 5 PM', { referenceDate: '2026-11-26' });
    const deadline = candidate.submissionDeadline;
    expect(deadline.value).toBeNull();
    expect(deadline.weekdayOnly).toBe(true);
    expect(deadline.time).toBe('17:00');
    expect(deadline.suggestions).toEqual(['2026-11-27', '2026-12-04']);
    expect(candidate.needsConfirmation).toBe(true);
  });

  it('reports impossible dates instead of correcting them', () => {
    const result = extractAssessments('Deadline: 31/02/2027\nDue: 30 February 2027');
    expect(result.assessments[0].submissionDeadline).toBeNull();
    expect(result.invalidDates).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/not a real date/);
  });

  it('reads midnight as the end of the day and flags it', () => {
    const deadline = first('Deadline: 4 December 2026 at midnight').submissionDeadline;
    expect(deadline.time).toBe('23:59');
    expect(deadline.confidence).toBe('medium');
    expect(deadline.notes.join(' ')).toMatch(/Midnight/);
  });

  it('flags times that do not exist or happen twice because of daylight saving', () => {
    expect(daylightSavingNote('2026-03-29', '01:30', 'Europe/Dublin')).toMatch(/does not exist/);
    expect(daylightSavingNote('2026-10-25', '01:30', 'Europe/Dublin')).toMatch(/happens twice/);
    expect(daylightSavingNote('2026-12-04', '17:00', 'Europe/Dublin')).toBeNull();
    const deadline = first('Deadline: 29 March 2026 at 01:30').submissionDeadline;
    expect(deadline.confidence).toBe('low');
  });

  it('keeps the earliest, longest match for overlapping patterns', () => {
    const { dates } = findDates('Friday 11 December 2026');
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe('Friday 11 December 2026');
  });
});

describe('classifying dates', () => {
  const brief = [
    'Assignment released: 1 October 2026',
    'Revision session: 30 November 2026',
    'Final submission: 4 December 2026 at 17:00',
    'Examination: 14 January 2027 at 09:30',
    'Results will be released on 20 February 2027',
    'The library closes early on 23 December 2026',
  ].join('\n');

  it('separates submission, release, revision, exam and feedback dates', () => {
    const candidate = first(brief);
    expect(candidate.submissionDeadline.value).toBe('2026-12-04');
    const labels = Object.fromEntries(candidate.otherDates.map((item) => [item.value, item.label]));
    expect(labels['2026-10-01']).toBe('release');
    expect(labels['2026-11-30']).toBe('revision');
    expect(labels['2027-01-14']).toBe('exam');
    expect(labels['2027-02-20']).toBe('feedback');
  });

  it('lists every distinct submission date when they conflict', () => {
    const candidate = first('Submit by 4 December 2026.\nSubmission closes 6 December 2026.');
    expect(candidate.submissionDeadline).toBeNull();
    expect(candidate.deadlineCandidates.map((item) => item.value)).toEqual([
      '2026-12-04',
      '2026-12-06',
    ]);
    expect(candidate.warnings[0]).toMatch(/Several possible submission dates/);
  });

  it('does not turn unrelated dates into deadlines', () => {
    const candidate = first(
      'Lecture notes updated 3 March 2027.\nThe module started on 2 February 2027.',
    );
    expect(candidate.submissionDeadline).toBeNull();
    expect(candidate.deadlineCandidates).toEqual([]);
    expect(candidate.otherDates).toHaveLength(2);
  });

  it('warns when a deadline has no time', () => {
    expect(first('Deadline: 4 December 2026').warnings.join(' ')).toMatch(/No submission time/);
  });
});

describe('assessment fields', () => {
  const brief = [
    'Module code: COMP 3010',
    'Module: Software Engineering',
    'Assignment name: Sprint Retrospective Presentation',
    'Assessment type: Presentation',
    'This assessment is worth 15% of the final grade.',
    'Submission method: Upload slides to Brightspace',
    'Each group presentation lasts 15-20 minutes.',
    'Group size: 3-5',
    'Presentation date: Tuesday 8 December 2026 at 10:00',
    'Submit slides by 7 December 2026 at 12 noon.',
    'Maximum length 1500 words for the accompanying summary.',
  ].join('\n');
  const candidate = first(brief);

  it('extracts module, title and type', () => {
    expect(candidate.moduleCode.value).toBe('COMP3010');
    expect(candidate.moduleName.value).toBe('Software Engineering');
    expect(candidate.title.value).toBe('Sprint Retrospective Presentation');
    expect(candidate.assessmentType).toMatchObject({ value: 'presentation', confidence: 'high' });
  });

  it('extracts weighting, method, duration, group size and word count', () => {
    expect(candidate.weighting).toMatchObject({ value: 15, confidence: 'high' });
    expect(candidate.submissionMethod.value).toBe('Upload slides to Brightspace');
    expect(candidate.presentation.duration).toMatchObject({ value: '15–20 minutes', minutes: 20 });
    expect(candidate.groupSize).toMatchObject({ value: '3–5 students', minimum: 3, maximum: 5 });
    expect(candidate.wordCount).toMatchObject({ maximum: 1500 });
  });

  it('separates the presentation date from the submission deadline', () => {
    expect(candidate.submissionDeadline).toMatchObject({ value: '2026-12-07', time: '12:00' });
    expect(candidate.presentation.dates[0]).toMatchObject({ value: '2026-12-08', time: '10:00' });
  });

  it('finds an inline submission method and individual work', () => {
    const other = first(
      'You must submit your essay through Turnitin.\nThis is an individual assignment.',
    );
    expect(other.submissionMethod.value).toBe('Turnitin');
    expect(other.groupSize.value).toBe('Individual');
  });

  it('flags several percentages as a weighting that needs review', () => {
    const other = first('Worth 30%.\nThe exam is weighted 70% of the module grade.');
    expect(other.weighting.confidence).toBe('low');
    expect(other.weighting.alternatives).toEqual([30, 70]);
  });

  it('returns nulls and empty lists when nothing is stated', () => {
    const empty = first('Read chapter four.');
    expect(empty).toMatchObject({
      title: null,
      weighting: null,
      submissionMethod: null,
      wordCount: null,
      groupSize: null,
      assessmentType: null,
      deliverables: [],
      markingCriteria: [],
    });
    expect(overallConfidence(empty)).toBe('unknown');
  });
});

describe('structured content and evidence', () => {
  const content = {
    blocks: [
      { text: 'CA1 Essay brief', kind: 'heading', ref: { page: 1 }, location: 'Page 1' },
      {
        text: 'Deadline: 4 December 2026 at 17:00',
        kind: 'paragraph',
        ref: { page: 1 },
        location: 'Page 1',
      },
      { text: 'Marking criteria', kind: 'heading', ref: { page: 2 }, location: 'Page 2' },
      { text: 'Argument\t40%', kind: 'tableRow', ref: { page: 2 }, location: 'Page 2' },
      { text: 'Referencing\t20%', kind: 'tableRow', ref: { page: 2 }, location: 'Page 2' },
      { text: 'Appendix', kind: 'heading', ref: { page: 3 }, location: 'Page 3' },
      { text: 'Old timetable', kind: 'paragraph', ref: { page: 3 }, location: 'Page 3' },
    ],
  };

  it('keeps page references with every value', () => {
    const candidate = first(content);
    expect(candidate.submissionDeadline.source).toMatchObject({
      location: 'Page 1',
      ref: { page: 1 },
    });
    expect(candidate.markingCriteria.map((item) => item.value)).toEqual([
      'Argument — 40%',
      'Referencing — 20%',
    ]);
    expect(candidate.markingCriteria[0].source.location).toBe('Page 2');
  });

  it('collects deliverables from bullet lists and stops at the next heading', () => {
    const candidate = first(
      'Deliverables:\n- Report\n- Code link\nAssessment criteria:\n- Clarity',
    );
    expect(candidate.deliverables.map((item) => item.value)).toEqual(['Report', 'Code link']);
    expect(candidate.markingCriteria.map((item) => item.value)).toEqual(['Clarity']);
  });
});

describe('several assessments in one document', () => {
  const brief = [
    'Module: COMP2001 Databases',
    'Important: All work must be your own.',
    'CA1 – SQL Exercises',
    'Weighting: 20%',
    'Submit by 16 October 2026 at 17:00',
    'CA2 – Database Design Report',
    'Weighting: 30%',
    'Deadline: 4 December 2026 at 23:59',
  ].join('\n');

  it('returns one candidate per assessment with shared module details', () => {
    const result = extractAssessments(brief);
    expect(result.assessments).toHaveLength(2);
    const [ca1, ca2] = result.assessments;
    expect(ca1).toMatchObject({
      title: { value: 'CA1 – SQL Exercises' },
      weighting: { value: 20 },
    });
    expect(ca1.submissionDeadline.value).toBe('2026-10-16');
    expect(ca2.submissionDeadline.value).toBe('2026-12-04');
    expect(ca2.moduleCode.value).toBe('COMP2001');
    expect(ca2.instructions[0].value).toBe('All work must be your own.');
    expect(result.warnings.join(' ')).toMatch(/2 assessments/);
  });

  it('keeps a single assessment when only one section has a deadline', () => {
    const single = extractAssessments(
      'CA1 – Essay\nDeadline: 4 December 2026\nCA2 – Exam\nDetails later.',
    );
    expect(single.assessments).toHaveLength(1);
  });
});

describe('untrusted content', () => {
  it('returns markup as plain text and never interprets it', () => {
    const candidate = first(
      'Assessment title: <img src=x onerror=alert(1)>\nDeadline: 4 December 2026\nSubmission method: javascript:alert(1)',
    );
    expect(candidate.title.value).toBe('<img src=x onerror=alert(1)>');
    expect(typeof candidate.submissionMethod.value).toBe('string');
  });

  it('handles very long, repetitive lines quickly (no catastrophic backtracking)', () => {
    const hostile = [
      '1/'.repeat(50_000),
      'submit '.repeat(20_000),
      `Deadline ${'4 December '.repeat(5_000)}`,
      '9'.repeat(100_000),
    ].join('\n');
    const started = performance.now();
    extractAssessments(hostile);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
