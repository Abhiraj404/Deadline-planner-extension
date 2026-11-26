/**
 * Full dashboard: list, agenda and calendar views with filtering, sorting and
 * settings. Opens in a normal tab (also registered as the extension's options page).
 *
 * Hash routes: #settings opens settings, #deadline=<id> opens a deadline.
 */

import { createCardList, emptyState, renderAssessmentCard } from '../components/assessment-card.js';
import {
  openDeadlineDetails,
  openDeadlineEditor,
  toggleComplete,
} from '../components/deadline-dialogs.js';
import { icon } from '../components/icons.js';
import { openSettings } from '../components/settings-panel.js';
import { getCategories } from '../models/settings.js';
import { createApp } from '../services/app.js';
import {
  filterAssessments,
  getDeadlineState,
  groupForAgenda,
  listModules,
  sortAssessments,
  summarize,
} from '../services/query.js';
import { THEME_LABELS, nextTheme } from '../services/theme.js';
import { daysBetween, formatDate, monthGrid, todayInTimeZone } from '../utils/dates.js';
import { debounce, h, isTypingTarget } from '../utils/dom.js';

const THEME_ICONS = { system: 'system', light: 'sun', dark: 'moon' };
const STATUSES = [
  { id: 'upcoming', label: 'Upcoming', icon: 'calendar' },
  { id: 'overdue', label: 'Overdue', icon: 'alert' },
  { id: 'completed', label: 'Completed', icon: 'check' },
  { id: 'all', label: 'All deadlines', icon: 'list' },
];
const VIEWS = [
  { id: 'list', label: 'List', icon: 'list' },
  { id: 'agenda', label: 'Agenda', icon: 'agenda' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
];
const SOURCES = [
  { value: '', label: 'All sources' },
  { value: 'manual', label: 'Added manually' },
  { value: 'pdf', label: 'From PDF' },
  { value: 'docx', label: 'From Word' },
];
const VIEW_PREFERENCE_KEY = 'dr-dashboard-view';

function readViewPreference() {
  try {
    const value = localStorage.getItem(VIEW_PREFERENCE_KEY);
    return VIEWS.some((view) => view.id === value) ? value : 'list';
  } catch {
    return 'list';
  }
}

async function main() {
  const root = document.getElementById('app');
  let app;
  try {
    app = await createApp();
  } catch (error) {
    root.replaceChildren(
      h(
        'p',
        { class: 'form-error page-error' },
        error?.message ?? 'Could not load your deadlines.',
      ),
    );
    return;
  }

  const initialSettings = app.getSettings();
  const today = todayInTimeZone(initialSettings.timeZone);
  const view = {
    status: 'upcoming',
    layout: readViewPreference(),
    search: '',
    module: '',
    source: '',
    category: '',
    sort: initialSettings.defaultSort,
    month: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
  };

  // ---------- Top bar ----------
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search title, module, notes, tags…',
    'aria-label': 'Search deadlines',
    autocomplete: 'off',
  });
  searchInput.addEventListener(
    'input',
    debounce(() => {
      view.search = searchInput.value;
      render();
    }, 120),
  );
  const themeButton = h('button', {
    type: 'button',
    class: 'icon-button',
    on: {
      click: () => {
        const settings = app.getSettings();
        app.storage.saveSettings({ ...settings, theme: nextTheme(settings.theme) });
      },
    },
  });

  const topbar = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark' }, icon('logo', { size: 16 })),
      h('h1', { class: 'brand-name' }, 'Deadline Reminder'),
    ),
    h(
      'div',
      { class: 'search topbar-search' },
      icon('search', { size: 14 }),
      searchInput,
      h('kbd', null, '/'),
    ),
    h(
      'div',
      { class: 'topbar-actions' },
      themeButton,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': 'Settings',
          title: 'Settings',
          on: { click: () => openSettings(app) },
        },
        icon('settings'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn topbar-import',
          title: 'Import a PDF or Word brief',
          on: { click: () => openDeadlineEditor(app, { tab: 'import' }) },
        },
        icon('upload', { size: 15 }),
        h('span', { class: 'label-wide' }, 'Import document'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          title: 'Add deadline (N)',
          on: { click: () => openDeadlineEditor(app) },
        },
        icon('plus', { size: 15 }),
        'Add deadline',
      ),
    ),
  );

  // ---------- Sidebar ----------
  const statusButtons = new Map();
  const statusNav = h(
    'nav',
    { class: 'status-nav', 'aria-label': 'Filter by status' },
    STATUSES.map((status) => {
      const count = h('span', { class: 'nav-count' });
      const button = h(
        'button',
        {
          type: 'button',
          class: 'nav-item',
          dataset: { status: status.id },
          on: {
            click: () => {
              view.status = status.id;
              render();
            },
          },
        },
        icon(status.icon, { size: 15 }),
        h('span', { class: 'nav-label' }, status.label),
        count,
      );
      statusButtons.set(status.id, { button, count });
      return button;
    }),
  );
  const moduleNav = h('div', { class: 'module-nav' });
  moduleNav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-module]');
    if (!button) return;
    view.module = button.dataset.module;
    render();
  });
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    statusNav,
    h(
      'div',
      { class: 'sidebar-section' },
      h('h2', { class: 'sidebar-heading' }, 'Modules'),
      moduleNav,
    ),
    h(
      'div',
      { class: 'sidebar-footer' },
      h('p', null, h('kbd', null, 'N'), ' new deadline'),
      h('p', null, h('kbd', null, '/'), ' search'),
      h('p', null, h('kbd', null, 'Esc'), ' close dialog'),
    ),
  );

  // ---------- Toolbar ----------
  const viewTitle = h('h2', { class: 'view-title' });
  const viewCount = h('span', { class: 'view-count' });
  const layoutButtons = VIEWS.map((item) =>
    h(
      'button',
      {
        type: 'button',
        class: 'segment',
        role: 'radio',
        dataset: { layout: item.id },
        title: `${item.label} view`,
        on: {
          click: () => {
            view.layout = item.id;
            try {
              localStorage.setItem(VIEW_PREFERENCE_KEY, item.id);
            } catch {
              // Preference is optional.
            }
            render();
          },
        },
      },
      icon(item.icon, { size: 14 }),
      h('span', { class: 'label-wide' }, item.label),
    ),
  );
  const makeSelect = (label, key) => {
    const element = h('select', { class: 'input select toolbar-select', 'aria-label': label });
    element.addEventListener('change', () => {
      view[key] = element.value;
      render();
    });
    return element;
  };
  const moduleSelect = makeSelect('Filter by module', 'module');
  const sourceSelect = makeSelect('Filter by source', 'source');
  const categorySelect = makeSelect('Filter by category', 'category');
  const sortSelect = makeSelect('Sort by', 'sort');
  sortSelect.append(
    h('option', { value: 'deadline' }, 'Sort: Deadline'),
    h('option', { value: 'priority' }, 'Sort: Priority'),
    h('option', { value: 'title' }, 'Sort: Title'),
  );
  sourceSelect.append(
    ...SOURCES.map((source) => h('option', { value: source.value }, source.label)),
  );

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'toolbar-title' }, viewTitle, viewCount),
    h(
      'div',
      { class: 'toolbar-controls' },
      moduleSelect,
      categorySelect,
      sourceSelect,
      sortSelect,
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Layout' }, layoutButtons),
    ),
  );
  const mobileStatus = h(
    'div',
    { class: 'segmented mobile-status', role: 'radiogroup', 'aria-label': 'Filter by status' },
    STATUSES.map((status) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: 'segment',
          dataset: { status: status.id },
          on: {
            click: () => {
              view.status = status.id;
              render();
            },
          },
        },
        status.id === 'all' ? 'All' : status.label,
      ),
    ),
  );

  const body = h('div', { class: 'view-body' });
  const listContainer = h('div', { class: 'card-list' });
  const renderList = createCardList(listContainer);

  // One delegated click handler for every card in every view.
  body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const id = target.closest('[data-id]')?.dataset.id;
    if (target.dataset.action === 'month') {
      shiftMonth(Number(target.dataset.delta));
      return;
    }
    if (target.dataset.action === 'add') {
      openDeadlineEditor(app, {
        initial: target.dataset.date ? { dueDate: target.dataset.date } : undefined,
      });
      return;
    }
    const assessment = id && app.getAssessment(id);
    if (!assessment) return;
    if (target.dataset.action === 'toggle-complete') toggleComplete(app, assessment);
    else openDeadlineDetails(app, id);
  });

  root.replaceChildren(
    topbar,
    h(
      'div',
      { class: 'layout' },
      sidebar,
      h('main', { class: 'content', id: 'main' }, mobileStatus, toolbar, body),
    ),
  );
  root.removeAttribute('aria-busy');

  function shiftMonth(delta) {
    if (delta === 0) {
      const now = todayInTimeZone(app.getSettings().timeZone);
      view.month = { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) };
    } else {
      const index = view.month.year * 12 + (view.month.month - 1) + delta;
      view.month = { year: Math.floor(index / 12), month: (index % 12) + 1 };
    }
    render();
  }

  function fillOptions(select, options, value) {
    const signature = JSON.stringify(options);
    if (select.dataset.signature !== signature) {
      select.replaceChildren(
        ...options.map((option) => h('option', { value: option.value }, option.label)),
      );
      select.dataset.signature = signature;
    }
    if (!options.some((option) => option.value === value)) return '';
    select.value = value;
    return value;
  }

  function emptyFor(status) {
    if (view.search || view.module || view.source || view.category) {
      return emptyState({
        title: 'No matching deadlines',
        message: 'Try a different search or clear the filters.',
      });
    }
    const add = h(
      'button',
      { type: 'button', class: 'btn btn-primary btn-sm', dataset: { action: 'add' } },
      icon('plus', { size: 14 }),
      'Add deadline',
    );
    const messages = {
      upcoming: {
        title: 'No upcoming deadlines',
        message: 'Add a deadline manually or link an assessment brief.',
        action: add,
      },
      overdue: { title: 'Nothing overdue', message: 'You are on top of everything.' },
      completed: {
        title: 'Nothing completed yet',
        message: 'Mark a deadline as done and it will appear here.',
      },
      all: {
        title: 'No deadlines yet',
        message: 'Your deadlines are stored only in this browser.',
        action: add,
      },
    };
    return emptyState(messages[status]);
  }

  function renderAgenda(items, context, settings) {
    if (items.length === 0) return body.replaceChildren(emptyFor(view.status));
    const groups = groupForAgenda(sortAssessments(items, 'deadline'), context);
    const todayIso = todayInTimeZone(settings.timeZone, context.now);
    body.replaceChildren(
      ...groups.map((group) => {
        let label;
        let sub = '';
        if (group.key === 'overdue') label = 'Overdue';
        else {
          const days = daysBetween(todayIso, group.date);
          label = formatDate(group.date, { weekday: 'long', day: 'numeric', month: 'long' });
          if (days === 0) sub = 'Today';
          else if (days === 1) sub = 'Tomorrow';
          else if (days === -1) sub = 'Yesterday';
          else if (days > 1 && days < 7) sub = `In ${days} days`;
        }
        return h(
          'section',
          { class: ['agenda-group', group.key === 'overdue' && 'is-overdue'] },
          h(
            'h3',
            { class: 'agenda-heading' },
            label,
            sub ? h('span', { class: 'agenda-sub' }, sub) : null,
          ),
          h(
            'div',
            { class: 'card-list' },
            group.items.map((item) => renderAssessmentCard(item, { now: context.now, settings })),
          ),
        );
      }),
    );
  }

  function renderCalendar(items, context, settings) {
    const { year, month } = view.month;
    const days = monthGrid(year, month, settings.weekStartsOn);
    const todayIso = todayInTimeZone(settings.timeZone, context.now);
    const byDate = new Map();
    for (const item of sortAssessments(items, 'deadline')) {
      if (!byDate.has(item.dueDate)) byDate.set(item.dueDate, []);
      byDate.get(item.dueDate).push(item);
    }
    const monthLabel = new Intl.DateTimeFormat(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(Date.UTC(year, month - 1, 1));
    const weekdayNames = days.slice(0, 7).map((day) => formatDate(day, { weekday: 'short' }));

    const cells = days.map((day) => {
      const entries = byDate.get(day) ?? [];
      const inMonth = Number(day.slice(5, 7)) === month;
      const visible = entries.slice(0, 3);
      return h(
        'div',
        {
          class: ['calendar-cell', !inMonth && 'is-outside', day === todayIso && 'is-today'],
          role: 'gridcell',
          'aria-label': `${formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}, ${entries.length} deadline${entries.length === 1 ? '' : 's'}`,
        },
        h(
          'button',
          {
            type: 'button',
            class: 'calendar-day',
            dataset: { action: 'add', date: day },
            title: 'Add a deadline on this day',
            'aria-label': `Add a deadline on ${formatDate(day, { day: 'numeric', month: 'long' })}`,
          },
          String(Number(day.slice(8))),
        ),
        h(
          'div',
          { class: 'calendar-items' },
          visible.map((item) => {
            const state = getDeadlineState(item, context);
            return h(
              'button',
              {
                type: 'button',
                class: `calendar-item tone-${state.tone}`,
                dataset: { action: 'open', id: item.id },
                title: `${item.title} · ${state.label}`,
              },
              h('span', { class: 'calendar-dot', 'aria-hidden': 'true' }),
              h('span', { class: 'calendar-item-title' }, item.title),
              h('span', { class: 'sr-only' }, `, ${state.label}`),
            );
          }),
          entries.length > visible.length
            ? h('span', { class: 'calendar-more' }, `+${entries.length - visible.length} more`)
            : null,
        ),
      );
    });

    body.replaceChildren(
      h(
        'div',
        { class: 'calendar' },
        h(
          'div',
          { class: 'calendar-header' },
          h('h3', { class: 'calendar-title' }, monthLabel),
          h(
            'div',
            { class: 'inline-row' },
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                dataset: { action: 'month', delta: '-1' },
                'aria-label': 'Previous month',
              },
              icon('chevronLeft'),
            ),
            h(
              'button',
              { type: 'button', class: 'btn btn-sm', dataset: { action: 'month', delta: '0' } },
              'Today',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                dataset: { action: 'month', delta: '1' },
                'aria-label': 'Next month',
              },
              icon('chevronRight'),
            ),
          ),
        ),
        h(
          'div',
          { class: 'calendar-grid', role: 'grid', 'aria-label': monthLabel },
          h(
            'div',
            { class: 'calendar-weekdays', role: 'row' },
            weekdayNames.map((name) => h('div', { role: 'columnheader' }, name)),
          ),
          h('div', { class: 'calendar-days' }, cells),
        ),
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

    const counts = {
      upcoming: summary.upcoming,
      overdue: summary.overdue,
      completed: summary.completed,
      all: summary.total,
    };
    for (const [id, { button, count }] of statusButtons) {
      count.textContent = String(counts[id]);
      button.setAttribute('aria-current', view.status === id ? 'page' : 'false');
      button.classList.toggle('is-alert', id === 'overdue' && counts.overdue > 0);
    }
    for (const button of mobileStatus.children) {
      button.setAttribute('aria-checked', String(button.dataset.status === view.status));
      button.setAttribute('aria-selected', String(button.dataset.status === view.status));
    }

    // Module filter (sidebar list + select for narrow screens).
    const modules = listModules(assessments);
    view.module = fillOptions(
      moduleSelect,
      [
        { value: '', label: 'All modules' },
        ...modules.map((module) => ({ value: module.key, label: module.label })),
      ],
      view.module,
    );
    moduleNav.replaceChildren(
      ...[
        h(
          'button',
          {
            type: 'button',
            class: 'nav-item nav-item-sm',
            dataset: { module: '' },
            'aria-current': String(view.module === ''),
          },
          h('span', { class: 'nav-label' }, 'All modules'),
        ),
        ...modules.map((module) =>
          h(
            'button',
            {
              type: 'button',
              class: 'nav-item nav-item-sm',
              dataset: { module: module.key },
              'aria-current': String(view.module === module.key),
              title: module.label,
            },
            h('span', { class: 'nav-label' }, module.label),
            h('span', { class: 'nav-count' }, String(module.open)),
          ),
        ),
        modules.length === 0
          ? h(
              'p',
              { class: 'sidebar-empty' },
              'Modules appear here when you add them to deadlines.',
            )
          : null,
      ].filter(Boolean),
    );
    view.category = fillOptions(
      categorySelect,
      [
        { value: '', label: 'All categories' },
        ...getCategories(settings).map((category) => ({
          value: category.id,
          label: category.label,
        })),
      ],
      view.category,
    );
    sourceSelect.value = view.source;
    sortSelect.value = view.sort;
    sortSelect.hidden = view.layout !== 'list';
    for (const button of layoutButtons) {
      button.setAttribute('aria-checked', String(button.dataset.layout === view.layout));
      button.setAttribute('aria-selected', String(button.dataset.layout === view.layout));
    }

    const filters = {
      status: view.status,
      search: view.search,
      module: view.module || null,
      source: view.source || null,
      category: view.category || null,
    };
    const items = filterAssessments(assessments, filters, context);
    viewTitle.textContent = STATUSES.find((status) => status.id === view.status).label;
    viewCount.textContent = `${items.length}`;
    document.title = summary.overdue
      ? `(${summary.overdue} overdue) Deadline Reminder`
      : 'Deadline Reminder';

    if (view.layout === 'calendar') renderCalendar(items, context, settings);
    else if (view.layout === 'agenda') renderAgenda(items, context, settings);
    else {
      const sorted = sortAssessments(items, view.sort, {
        descending: view.status === 'completed' && view.sort === 'deadline',
      });
      renderList(sorted, { now, settings, empty: emptyFor(view.status) });
      if (body.firstChild !== listContainer) body.replaceChildren(listContainer);
    }
  }

  function handleHash() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) return;
    history.replaceState(null, '', location.pathname);
    if (hash === 'settings') openSettings(app);
    else if (hash.startsWith('deadline=')) openDeadlineDetails(app, hash.slice('deadline='.length));
  }

  app.onChange(render);
  render();
  handleHash();
  window.addEventListener('hashchange', handleHash);
  // Relative labels ("Tomorrow") go stale if the tab stays open overnight.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render();
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('dialog[open]') || isTypingTarget(event.target)) return;
    if (event.key === '/') {
      event.preventDefault();
      searchInput.focus();
    } else if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      openDeadlineEditor(app);
    }
  });
}

main();
