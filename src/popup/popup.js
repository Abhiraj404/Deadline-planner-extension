/**
 * Browser popup: quick glance and quick add.
 * Detailed management lives in the dashboard; the popup stays small and fast.
 */

import { createCardList, dueBadge, dueText, emptyState } from '../components/assessment-card.js';
import {
  openDeadlineDetails,
  openDeadlineEditor,
  toggleComplete,
} from '../components/deadline-dialogs.js';
import { icon } from '../components/icons.js';
import { showToast } from '../components/toast.js';
import { getCategories } from '../models/settings.js';
import { createApp } from '../services/app.js';
import {
  filterAssessments,
  getDeadlineState,
  sortAssessments,
  summarize,
} from '../services/query.js';
import { THEME_LABELS, nextTheme } from '../services/theme.js';
import { todayInTimeZone } from '../utils/dates.js';
import { debounce, h, isTypingTarget } from '../utils/dom.js';

const THEME_ICONS = { system: 'system', light: 'sun', dark: 'moon' };

async function main() {
  const root = document.getElementById('app');
  let app;
  try {
    app = await createApp();
  } catch (error) {
    root.replaceChildren(
      h(
        'p',
        { class: 'form-error popup-error' },
        error?.message ?? 'Could not load your deadlines.',
      ),
    );
    return;
  }

  const view = { tab: 'upcoming', search: '' };

  // ---------- Header ----------
  const themeButton = h('button', { type: 'button', class: 'icon-button' });
  themeButton.addEventListener('click', async () => {
    const settings = app.getSettings();
    await app.storage.saveSettings({ ...settings, theme: nextTheme(settings.theme) });
  });
  const header = h(
    'header',
    { class: 'popup-header' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark' }, icon('logo', { size: 16 })),
      h('h1', { class: 'brand-name' }, 'Deadline Reminder'),
    ),
    h(
      'div',
      { class: 'header-actions' },
      themeButton,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': 'Settings',
          title: 'Settings',
          on: { click: () => openDashboard('#settings') },
        },
        icon('settings'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': 'Open full dashboard',
          title: 'Open full dashboard',
          on: { click: () => openDashboard() },
        },
        icon('expand'),
      ),
    ),
  );

  // ---------- Summary ----------
  const nextSlot = h('section', { class: 'next-up', 'aria-label': 'Next deadline' });
  const stat = (label) => {
    const value = h('span', { class: 'stat-value' }, '0');
    return {
      value,
      node: h('div', { class: 'stat' }, value, h('span', { class: 'stat-label' }, label)),
    };
  };
  const stats = {
    upcoming: stat('Upcoming'),
    dueSoon: stat('Due soon'),
    completed: stat('Completed'),
  };
  const statsRow = h(
    'div',
    { class: 'stats', role: 'group', 'aria-label': 'Summary' },
    stats.upcoming.node,
    stats.dueSoon.node,
    stats.completed.node,
  );

  // ---------- Quick add ----------
  const quickTitle = h('input', {
    class: 'input',
    type: 'text',
    name: 'title',
    placeholder: 'What is due?',
    'aria-label': 'Deadline title',
    maxlength: 200,
    autocomplete: 'off',
  });
  const quickDate = h('input', {
    class: 'input',
    type: 'date',
    name: 'dueDate',
    'aria-label': 'Due date',
  });
  const quickCategory = h('select', {
    class: 'input select',
    name: 'category',
    'aria-label': 'Category',
  });
  const quickError = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const quickForm = h(
    'form',
    { class: 'quick-add', hidden: true, novalidate: true, 'aria-label': 'Quick add deadline' },
    quickTitle,
    h('div', { class: 'quick-row' }, quickDate, quickCategory),
    quickError,
    h(
      'div',
      { class: 'quick-actions' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-ghost',
          on: {
            click: () => {
              const initial = {
                title: quickTitle.value,
                dueDate: quickDate.value,
                category: quickCategory.value,
              };
              closeQuickAdd();
              openDeadlineEditor(app, { initial, openAdvanced: true });
            },
          },
        },
        'Advanced options',
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn-sm', on: { click: () => closeQuickAdd() } },
        'Cancel',
      ),
      h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'Add'),
    ),
  );

  function fillCategories() {
    const settings = app.getSettings();
    const current = quickCategory.value || settings.defaultCategory;
    quickCategory.replaceChildren(
      ...getCategories(settings).map((category) =>
        h('option', { value: category.id, selected: category.id === current }, category.label),
      ),
    );
  }

  function openQuickAdd() {
    fillCategories();
    if (!quickDate.value) quickDate.value = todayInTimeZone(app.getSettings().timeZone);
    quickForm.hidden = false;
    addButton.setAttribute('aria-expanded', 'true');
    quickTitle.focus();
  }

  function closeQuickAdd() {
    quickForm.hidden = true;
    quickForm.reset();
    quickError.hidden = true;
    addButton.setAttribute('aria-expanded', 'false');
  }

  quickForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await app.service.create({
      title: quickTitle.value,
      dueDate: quickDate.value,
      category: quickCategory.value,
    });
    if (!result.ok) {
      const message =
        result.errors.title ?? result.errors.dueDate ?? Object.values(result.errors)[0];
      quickError.textContent = message;
      quickError.hidden = false;
      (result.errors.title ? quickTitle : quickDate).focus();
      return;
    }
    closeQuickAdd();
    view.tab = 'upcoming';
    showToast(`Added “${result.assessment.title}”`, { tone: 'success' });
  });
  quickForm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickAdd();
      addButton.focus();
    }
  });

  const addButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary add-button',
      'aria-expanded': 'false',
      title: 'Add deadline (N)',
      on: { click: () => (quickForm.hidden ? openQuickAdd() : closeQuickAdd()) },
    },
    icon('plus', { size: 15 }),
    'Add deadline',
  );
  const actions = h(
    'div',
    { class: 'popup-actions' },
    addButton,
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        title: 'Import a PDF or Word brief',
        on: { click: () => openDeadlineEditor(app, { tab: 'import' }) },
      },
      icon('upload', { size: 15 }),
      'Import',
    ),
  );

  // ---------- Tabs, search, list ----------
  const tabButtons = {};
  const tabList = h(
    'div',
    { class: 'segmented', role: 'tablist', 'aria-label': 'Deadline list' },
    ['upcoming', 'completed'].map((tab) => {
      const count = h('span', { class: 'segment-count' });
      const button = h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'segment',
          id: `tab-${tab}`,
          'aria-controls': 'deadline-list',
          on: {
            click: () => {
              view.tab = tab;
              render();
            },
          },
        },
        tab === 'upcoming' ? 'Upcoming' : 'Completed',
        count,
      );
      tabButtons[tab] = { button, count };
      return button;
    }),
  );
  tabList.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      view.tab = view.tab === 'upcoming' ? 'completed' : 'upcoming';
      render();
      tabButtons[view.tab].button.focus();
    }
  });

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search',
    'aria-label': 'Search deadlines',
    autocomplete: 'off',
  });
  const search = h(
    'div',
    { class: 'search' },
    icon('search', { size: 14 }),
    searchInput,
    h('kbd', null, '/'),
  );
  searchInput.addEventListener(
    'input',
    debounce(() => {
      view.search = searchInput.value;
      render();
    }, 120),
  );

  const list = h('div', { class: 'card-list', id: 'deadline-list', role: 'tabpanel' });
  const renderList = createCardList(list, { compact: true });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    const card = event.target.closest('.card');
    if (!button || !card) return;
    const assessment = app.getAssessment(card.dataset.id);
    if (!assessment) return;
    if (button.dataset.action === 'toggle-complete') toggleComplete(app, assessment);
    else openDeadlineDetails(app, assessment.id);
  });

  const footer = h(
    'footer',
    { class: 'popup-footer' },
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: () => openDashboard() } },
      'Open full dashboard',
      icon('chevronRight', { size: 14 }),
    ),
  );

  root.replaceChildren(
    header,
    h(
      'main',
      { class: 'popup-main' },
      nextSlot,
      statsRow,
      actions,
      quickForm,
      h('div', { class: 'list-tools' }, tabList, search),
      list,
    ),
    footer,
  );
  root.removeAttribute('aria-busy');

  function openDashboard(hash) {
    app.openDashboard(hash);
    if (app.isExtension) window.close();
  }

  function renderNext(summary, settings, now) {
    const next = summary.next;
    if (!next) {
      nextSlot.replaceChildren(
        h('p', { class: 'next-label' }, 'Next deadline'),
        h(
          'p',
          { class: 'next-empty' },
          summary.overdue
            ? 'Nothing upcoming, but some deadlines are overdue.'
            : 'Nothing due. Add a deadline to get started.',
        ),
      );
      return;
    }
    const state = getDeadlineState(next, { now, dueSoonDays: settings.dueSoonDays });
    const module = next.moduleCode ?? next.moduleName;
    nextSlot.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: 'next-card',
          on: { click: () => openDeadlineDetails(app, next.id) },
        },
        h(
          'span',
          { class: 'next-top' },
          h('span', { class: 'next-label' }, 'Next deadline'),
          dueBadge(state),
        ),
        h('span', { class: 'next-title' }, next.title),
        h('span', { class: 'next-meta' }, [module, dueText(next)].filter(Boolean).join(' · ')),
      ),
    );
  }

  function render() {
    const { assessments, settings } = app.getState();
    const now = app.now();
    const context = { now, dueSoonDays: settings.dueSoonDays };
    const summary = summarize(assessments, context);

    themeButton.replaceChildren(icon(THEME_ICONS[settings.theme]));
    themeButton.setAttribute('aria-label', `${THEME_LABELS[settings.theme]}. Switch theme`);
    themeButton.title = `${THEME_LABELS[settings.theme]} (click to switch)`;

    renderNext(summary, settings, now);
    stats.upcoming.value.textContent = String(summary.upcoming);
    stats.dueSoon.value.textContent = String(summary.dueSoon);
    stats.completed.value.textContent = String(summary.completed);
    statsRow
      .querySelector('.stat:nth-child(2)')
      .classList.toggle('is-warning', summary.dueSoon > 0);

    const open = summary.upcoming + summary.overdue;
    tabButtons.upcoming.count.textContent = String(open);
    tabButtons.completed.count.textContent = String(summary.completed);
    for (const [tab, { button }] of Object.entries(tabButtons)) {
      button.setAttribute('aria-selected', String(view.tab === tab));
      button.tabIndex = view.tab === tab ? 0 : -1;
    }
    list.setAttribute('aria-labelledby', `tab-${view.tab}`);

    const status = view.tab === 'completed' ? 'completed' : 'open';
    const filtered = filterAssessments(assessments, { status, search: view.search }, context);
    const sorted = sortAssessments(filtered, 'deadline', { descending: status === 'completed' });

    let empty;
    if (view.search)
      empty = emptyState({ title: 'No matches', message: `Nothing matches “${view.search}”.` });
    else if (status === 'completed') {
      empty = emptyState({
        title: 'Nothing completed yet',
        message: 'Tick a deadline when you hand it in.',
      });
    } else {
      empty = emptyState({
        title: 'No upcoming deadlines',
        message: 'Add one manually, or link an assessment brief.',
        action: h(
          'button',
          { type: 'button', class: 'btn btn-sm btn-primary', on: { click: openQuickAdd } },
          icon('plus', { size: 14 }),
          'Add deadline',
        ),
      });
    }
    renderList(sorted, { now, settings, empty });
  }

  app.onChange(() => {
    if (!quickForm.hidden) fillCategories();
    render();
  });
  render();

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('dialog[open]') || isTypingTarget(event.target)) return;
    if (event.key === '/') {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      openQuickAdd();
    }
  });
}

main();
