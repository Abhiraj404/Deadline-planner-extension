/**
 * Assessment card used by the popup and dashboard lists.
 *
 * Cards carry `data-id` and buttons carry `data-action`; the list container handles
 * clicks with one delegated listener instead of one listener per card.
 * Urgency is shown with text and an icon as well as colour.
 */

import { categoryLabel } from '../models/settings.js';
import { getDeadlineState } from '../services/query.js';
import { formatDate, formatTime } from '../utils/dates.js';
import { h } from '../utils/dom.js';
import { icon } from './icons.js';

const PRIORITY_TEXT = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };
const TONE_ICON = {
  overdue: 'alert',
  urgent: 'clock',
  soon: 'clock',
  normal: 'calendar',
  done: 'check',
};

export function priorityIndicator(priority, { showLabel = false } = {}) {
  const level = { low: 1, medium: 2, high: 3 }[priority] ?? 2;
  return h(
    'span',
    { class: `priority priority-${priority}`, title: PRIORITY_TEXT[priority] },
    h(
      'span',
      { class: 'priority-bars', 'aria-hidden': 'true' },
      [1, 2, 3].map((bar) => h('span', { class: bar <= level ? 'on' : '' })),
    ),
    h('span', { class: showLabel ? 'priority-label' : 'sr-only' }, PRIORITY_TEXT[priority]),
  );
}

export function dueText(assessment) {
  const date = formatDate(assessment.dueDate);
  return assessment.dueTime ? `${date} · ${formatTime(assessment.dueTime)}` : date;
}

export function dueBadge(state) {
  return h(
    'span',
    { class: `due-badge tone-${state.tone}` },
    icon(TONE_ICON[state.tone], { size: 13 }),
    state.label,
  );
}

/**
 * @param {object} assessment
 * @param {object} context { now, settings, compact }
 */
export function renderAssessmentCard(assessment, { now, settings, compact = false }) {
  const state = getDeadlineState(assessment, { now, dueSoonDays: settings.dueSoonDays });
  const module = assessment.moduleCode ?? assessment.moduleName;
  const doneCount = assessment.checklist.filter((item) => item.done).length;

  const chips = [
    priorityIndicator(assessment.priority, { showLabel: !compact }),
    assessment.weighting !== null
      ? h('span', { class: 'chip', title: 'Weighting' }, `${assessment.weighting}%`)
      : null,
    assessment.checklist.length > 0
      ? h(
          'span',
          { class: 'chip', title: 'Checklist progress' },
          icon('check', { size: 12 }),
          `${doneCount}/${assessment.checklist.length}`,
        )
      : null,
    assessment.sourceType !== 'manual' || assessment.sourceDocument
      ? h(
          'span',
          {
            class: 'chip',
            title: assessment.sourceDocument
              ? `Document: ${assessment.sourceDocument.name}`
              : 'Imported',
          },
          icon('file', { size: 12 }),
          (assessment.sourceDocument?.type ?? assessment.sourceType).toUpperCase(),
        )
      : null,
    !compact && assessment.tags.length > 0
      ? assessment.tags.slice(0, 3).map((tag) => h('span', { class: 'chip chip-tag' }, `#${tag}`))
      : null,
  ];

  return h(
    'article',
    {
      class: [
        'card',
        `tone-${state.tone}`,
        assessment.completed && 'is-done',
        compact && 'card-compact',
      ],
      dataset: { id: assessment.id },
    },
    h(
      'button',
      {
        type: 'button',
        class: 'check-button',
        dataset: { action: 'toggle-complete' },
        'aria-pressed': String(assessment.completed),
        'aria-label': assessment.completed
          ? `Mark “${assessment.title}” as not done`
          : `Mark “${assessment.title}” as done`,
        title: assessment.completed ? 'Restore' : 'Mark as done',
      },
      icon('check', { size: 12 }),
    ),
    h(
      'div',
      { class: 'card-main' },
      h(
        'button',
        { type: 'button', class: 'card-title', dataset: { action: 'open' } },
        assessment.title,
      ),
      h(
        'div',
        { class: 'card-meta' },
        module ? h('span', { class: 'card-module' }, module) : null,
        h('span', null, categoryLabel(assessment.category, settings)),
      ),
      h('div', { class: 'card-chips' }, chips),
    ),
    h(
      'div',
      { class: 'card-side' },
      dueBadge(state),
      h(
        'span',
        { class: 'card-date' },
        h('time', { datetime: assessment.dueDate }, dueText(assessment)),
      ),
    ),
  );
}

/**
 * Render a list efficiently: cards are cached by id and only rebuilt when the
 * record object (or the day, or settings) changes, then reordered in one call.
 */
export function createCardList(container, { compact = false } = {}) {
  const cache = new Map();
  return function renderList(assessments, { now, settings, empty }) {
    const dayKey = `${now.toDateString()}|${now.getHours()}|${settings.dueSoonDays}|${settings.customCategories.length}`;
    const nodes = [];
    const live = new Set();
    for (const assessment of assessments) {
      live.add(assessment.id);
      const cached = cache.get(assessment.id);
      if (cached && cached.record === assessment && cached.dayKey === dayKey) {
        nodes.push(cached.node);
        continue;
      }
      const node = renderAssessmentCard(assessment, { now, settings, compact });
      cache.set(assessment.id, { record: assessment, dayKey, node });
      nodes.push(node);
    }
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    if (nodes.length === 0 && empty) container.replaceChildren(empty);
    else container.replaceChildren(...nodes);
  };
}

export function emptyState({ title, message, action }) {
  return h(
    'div',
    { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon('inbox', { size: 22 })),
    h('p', { class: 'empty-title' }, title),
    message ? h('p', { class: 'empty-message' }, message) : null,
    action ?? null,
  );
}
