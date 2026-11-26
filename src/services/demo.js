/**
 * Optional demo data for trying the extension or taking screenshots.
 *
 * Everything here is invented: module codes, titles and dates are synthetic. Demo
 * deadlines carry `isDemo: true`, are only added when the user asks, never replace
 * existing deadlines, and can be removed on their own (Settings → Demo data).
 */

import { createAssessment } from '../models/assessment.js';
import { addDays, todayInTimeZone } from '../utils/dates.js';

/** Demo deadlines relative to today, so the demo always looks current. */
export function demoAssessments(settings, now = new Date()) {
  const today = todayInTimeZone(settings.timeZone, now);
  const day = (offset) => addDays(today, offset);
  const items = [
    {
      title: 'Sprint 2 Retrospective Report',
      moduleCode: 'DEMO1001',
      moduleName: 'Demo Software Engineering',
      category: 'group-project',
      dueDate: day(2),
      dueTime: '17:00',
      weighting: 25,
      priority: 'high',
      submissionMethod: 'Course portal',
      groupSize: '3–4 students',
      checklist: [
        { text: 'Collect team feedback', done: true },
        { text: 'Write retrospective', done: false },
        { text: 'Submit PDF', done: false },
      ],
      instructions: ['One submission per group.'],
    },
    {
      title: 'Lab 5: Sorting Algorithms',
      moduleCode: 'DEMO1002',
      moduleName: 'Demo Algorithms',
      category: 'lab',
      dueDate: day(0),
      dueTime: '23:59',
      weighting: 5,
    },
    {
      title: 'Reflective Essay',
      moduleCode: 'DEMO2001',
      moduleName: 'Demo Professional Practice',
      category: 'assignment',
      dueDate: day(9),
      weighting: 30,
      wordCount: '1,500 words',
      pinned: true,
      notes: 'Draft outline first.',
    },
    {
      title: 'Midterm examination',
      moduleCode: 'DEMO1002',
      moduleName: 'Demo Algorithms',
      category: 'exam',
      dueDate: day(16),
      dueTime: '09:30',
      weighting: 40,
      priority: 'high',
    },
    {
      title: 'Database Design Presentation',
      moduleCode: 'DEMO2002',
      moduleName: 'Demo Databases',
      category: 'presentation',
      dueDate: day(5),
      dueTime: '11:00',
      weighting: 20,
      relatedDates: [{ label: 'presentation', date: day(6), time: '10:00', note: '10 minutes' }],
    },
    {
      title: 'Problem Set 3',
      moduleCode: 'DEMO1003',
      moduleName: 'Demo Statistics',
      category: 'assignment',
      dueDate: day(-1),
      weighting: 10,
    },
    {
      title: 'Problem Set 2',
      moduleCode: 'DEMO1003',
      moduleName: 'Demo Statistics',
      category: 'assignment',
      dueDate: day(-8),
      weighting: 10,
      completed: true,
    },
    {
      title: 'Renew library card',
      category: 'personal',
      dueDate: day(4),
      priority: 'low',
    },
  ];
  return items.map((input) =>
    createAssessment({ ...input, isDemo: true }, { now, timeZone: settings.timeZone }),
  );
}

/** Add demo deadlines (only those not already present). */
export async function loadDemoData(storage, now = new Date()) {
  const settings = await storage.getSettings();
  let added = 0;
  await storage.updateAssessments((items) => {
    if (items.some((item) => item.isDemo)) return items; // already loaded
    const demo = demoAssessments(settings, now);
    added = demo.length;
    return [...items, ...demo];
  });
  return added;
}

/** Remove only demo deadlines; real deadlines are never touched. */
export async function removeDemoData(storage) {
  let removed = 0;
  await storage.updateAssessments((items) => {
    const kept = items.filter((item) => !item.isDemo);
    removed = items.length - kept.length;
    return removed ? kept : items;
  });
  return removed;
}
