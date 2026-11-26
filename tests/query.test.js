import { describe, expect, it } from 'vitest';
import { createAssessment } from '../src/models/assessment.js';
import {
  filterAssessments,
  getDeadlineState,
  groupForAgenda,
  listModules,
  matchesSearch,
  sortAssessments,
  summarize,
} from '../src/services/query.js';

// 25 Nov 2026, 10:00 in Dublin (GMT).
const now = new Date('2026-11-25T10:00:00Z');
const context = { now, dueSoonDays: 3 };
const make = (input) => createAssessment(input, { now });

const items = [
  make({ title: 'Overdue lab', dueDate: '2026-11-20', moduleCode: 'CHEM1', priority: 'low' }),
  make({ title: 'Due today, no time', dueDate: '2026-11-25', moduleName: 'History' }),
  make({ title: 'Due earlier today', dueDate: '2026-11-25', dueTime: '09:00', priority: 'high' }),
  make({ title: 'Essay', dueDate: '2026-11-27', moduleCode: 'ENG2', tags: ['writing'] }),
  make({ title: 'Big project', dueDate: '2027-01-15', moduleCode: 'ENG2', priority: 'high' }),
  { ...make({ title: 'Finished quiz', dueDate: '2026-11-10' }), completed: true },
  make({ title: 'Imported brief', dueDate: '2026-12-01', sourceType: 'pdf', category: 'exam' }),
];

describe('getDeadlineState', () => {
  it('keeps a date-only deadline open for the whole due day', () => {
    const state = getDeadlineState(items[1], context);
    expect(state).toMatchObject({
      daysRemaining: 0,
      overdue: false,
      dueSoon: true,
      label: 'Due today',
    });
  });

  it('marks a timed deadline overdue once the time has passed', () => {
    const state = getDeadlineState(items[2], context);
    expect(state.overdue).toBe(true);
    expect(state.tone).toBe('overdue');
  });

  it('describes remaining and overdue days', () => {
    expect(getDeadlineState(items[0], context).label).toBe('5 days overdue');
    expect(getDeadlineState(items[3], context).label).toBe('2 days left');
    expect(getDeadlineState(items[4], context).label).toBe('7 weeks left');
    expect(getDeadlineState(items[5], context).tone).toBe('done');
  });

  it('uses the deadline time zone, not UTC', () => {
    const auckland = make({ title: 'NZ', dueDate: '2026-11-25', timeZone: 'Pacific/Auckland' });
    // 23:30 UTC on the 25th is already the 26th in Auckland.
    const state = getDeadlineState(auckland, { now: new Date('2026-11-25T23:30:00Z') });
    expect(state.overdue).toBe(true);
  });
});

describe('filterAssessments', () => {
  const titles = (list) => list.map((item) => item.title);

  it('filters by status', () => {
    expect(titles(filterAssessments(items, { status: 'overdue' }, context))).toEqual([
      'Overdue lab',
      'Due earlier today',
    ]);
    expect(titles(filterAssessments(items, { status: 'completed' }, context))).toEqual([
      'Finished quiz',
    ]);
    expect(filterAssessments(items, { status: 'upcoming' }, context)).toHaveLength(4);
    expect(filterAssessments(items, { status: 'open' }, context)).toHaveLength(6);
    expect(filterAssessments(items, { status: 'all' }, context)).toHaveLength(7);
  });

  it('searches title, module, tags and notes with every word required', () => {
    expect(titles(filterAssessments(items, { search: 'eng2 essay' }))).toEqual(['Essay']);
    expect(titles(filterAssessments(items, { search: 'WRITING' }))).toEqual(['Essay']);
    expect(filterAssessments(items, { search: 'zzz' })).toEqual([]);
    expect(matchesSearch(items[0], '   ')).toBe(true);
  });

  it('filters by module, source and category', () => {
    expect(titles(filterAssessments(items, { module: 'ENG2' }))).toEqual(['Essay', 'Big project']);
    expect(filterAssessments(items, { module: '__none__' })).toHaveLength(3);
    expect(titles(filterAssessments(items, { source: 'pdf' }))).toEqual(['Imported brief']);
    expect(filterAssessments(items, { source: 'manual' })).toHaveLength(6);
    expect(titles(filterAssessments(items, { category: 'exam' }))).toEqual(['Imported brief']);
  });
});

describe('sortAssessments', () => {
  it('sorts by deadline with date-only deadlines at the end of their day', () => {
    const sorted = sortAssessments(items.slice(1, 3), 'deadline');
    expect(sorted.map((item) => item.title)).toEqual(['Due earlier today', 'Due today, no time']);
  });

  it('sorts by title and by priority', () => {
    expect(sortAssessments(items, 'title')[0].title).toBe('Big project');
    const byPriority = sortAssessments(items, 'priority');
    expect(byPriority.slice(0, 2).map((item) => item.priority)).toEqual(['high', 'high']);
    expect(byPriority.at(-1).priority).toBe('low');
  });

  it('does not mutate the input and supports descending order', () => {
    const copy = items.slice();
    const descending = sortAssessments(items, 'deadline', { descending: true });
    expect(items).toEqual(copy);
    expect(descending[0].title).toBe('Big project');
  });
});

describe('summaries and grouping', () => {
  it('counts upcoming, due soon, overdue and completed and finds the next deadline', () => {
    const summary = summarize(items, context);
    expect(summary).toMatchObject({ upcoming: 4, dueSoon: 2, overdue: 2, completed: 1, total: 7 });
    expect(summary.next.title).toBe('Due today, no time');
  });

  it('lists modules with open counts', () => {
    expect(listModules(items)).toEqual([
      { key: 'CHEM1', label: 'CHEM1', open: 1, total: 1 },
      { key: 'ENG2', label: 'ENG2', open: 2, total: 2 },
      { key: 'History', label: 'History', open: 1, total: 1 },
    ]);
  });

  it('groups agenda items with overdue first, then by date', () => {
    const open = sortAssessments(filterAssessments(items, { status: 'open' }, context));
    const groups = groupForAgenda(open, context);
    expect(groups.map((group) => group.key)).toEqual([
      'overdue',
      '2026-11-25',
      '2026-11-27',
      '2026-12-01',
      '2027-01-15',
    ]);
    expect(groups[0].items).toHaveLength(2);
  });
});
