/**
 * Settings → Backup and data: export with a privacy warning, restore with a preview,
 * demo data, storage usage, and a clearly separated reset.
 */

import { DEFAULT_SETTINGS } from '../models/settings.js';
import { backupFileName, createBackup, parseBackup, planRestore } from '../services/backup.js';
import { loadDemoData, removeDemoData } from '../services/demo.js';
import { fileStore } from '../services/file-store.js';
import { formatBytes, h } from '../utils/dom.js';
import { confirmDialog, openDialog } from './dialog.js';
import { icon } from './icons.js';
import { showToast } from './toast.js';

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportBackup(app) {
  const confirmed = await confirmDialog({
    title: 'Export a backup?',
    message:
      'The backup file contains your deadlines, modules, notes, completion status, reminder settings and document details (not the documents themselves). Keep it somewhere private.',
    confirmLabel: 'Download backup',
  });
  if (!confirmed) return;
  const { assessments, settings, documents } = app.getState();
  downloadJson(createBackup({ assessments, settings, documents }), backupFileName());
  showToast('Backup downloaded');
}

const titles = (items) =>
  items.length
    ? `: ${items
        .slice(0, 4)
        .map((item) => `“${item.title}”`)
        .join(', ')}${items.length > 4 ? '…' : ''}`
    : '';

/** Show what a restore will change, then apply it only on confirmation. */
export async function restoreBackup(app, file) {
  const parsed = parseBackup(await file.text());
  if (!parsed.ok) return showToast(parsed.error, { tone: 'danger' });
  const { assessments, documents = [] } = app.getState();
  const options = {
    currentDocuments: documents,
    incomingDocuments: parsed.documents.map((record) => ({ ...record, fileStored: false })),
  };
  let mode = 'merge';
  const summary = h('div', { class: 'restore-preview' });
  const renderSummary = () => {
    const plan = planRestore(assessments, parsed.assessments, mode, options);
    summary.replaceChildren(
      h(
        'ul',
        { class: 'plain-list' },
        mode === 'replace'
          ? [
              h('li', null, `Remove all ${plan.remove.length} current deadlines`),
              h('li', null, `Restore ${plan.add.length} deadlines from the backup`),
              h('li', null, 'Restore the backup’s settings and document details'),
            ]
          : [
              h(
                'li',
                null,
                `Add ${plan.add.length} new deadline${plan.add.length === 1 ? '' : 's'}${titles(plan.add)}`,
              ),
              h('li', null, `Update ${plan.update.length} with newer copies${titles(plan.update)}`),
              h(
                'li',
                null,
                `Skip ${plan.duplicates.length + plan.unchanged} already here (no duplicates)`,
              ),
              h(
                'li',
                null,
                `Add ${plan.documents.add} document record${plan.documents.add === 1 ? '' : 's'}; your settings stay as they are`,
              ),
            ],
      ),
      parsed.skipped
        ? h(
            'p',
            { class: 'field-hint' },
            `${parsed.skipped} invalid records in the file will be ignored.`,
          )
        : null,
    );
    return plan;
  };
  const modeName = `restore-mode-${Date.now()}`;
  const modeInputs = ['merge', 'replace'].map((value) => {
    const input = h('input', { type: 'radio', name: modeName, value, checked: value === mode });
    input.addEventListener('change', () => {
      mode = value;
      renderSummary();
    });
    return h(
      'label',
      { class: 'radio-row' },
      input,
      h(
        'span',
        null,
        value === 'merge'
          ? 'Merge with my current data (recommended)'
          : 'Replace everything with the backup',
      ),
    );
  });
  renderSummary();

  const result = await new Promise((resolve) => {
    let confirmed = false;
    const handle = openDialog({
      title: 'Restore backup',
      size: 'sm',
      body: [
        h(
          'p',
          { class: 'confirm-message' },
          `Backup from ${new Date(parsed.exportedAt ?? Date.now()).toLocaleString()} with ${parsed.assessments.length} deadlines.`,
        ),
        h(
          'fieldset',
          { class: 'fieldset' },
          h('legend', { class: 'field-label' }, 'How to restore'),
          modeInputs,
        ),
        summary,
      ],
      footer: [
        h(
          'button',
          { type: 'button', class: 'btn', on: { click: () => handle.close() } },
          'Cancel',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            on: { click: () => ((confirmed = true), handle.close()) },
          },
          'Restore',
        ),
      ],
      onClose: () => resolve(confirmed),
    });
  });
  if (!result) return;
  if (mode === 'replace') {
    const sure = await confirmDialog({
      title: 'Replace all data?',
      message:
        'Your current deadlines, settings and document details will be replaced by the backup. This cannot be undone.',
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!sure) return;
  }
  const plan = planRestore(app.getState().assessments, parsed.assessments, mode, {
    ...options,
    currentDocuments: app.getState().documents ?? [],
  });
  await app.storage.replaceAll({
    assessments: plan.result,
    settings: mode === 'replace' ? parsed.settings : app.getSettings(),
    documents: plan.resultDocuments,
  });
  showToast(
    mode === 'replace'
      ? 'Backup restored'
      : `Restored: ${plan.add.length} added, ${plan.update.length} updated`,
    { tone: 'success' },
  );
}

/** Wipe everything after the user types RESET. */
export async function resetEverything(app) {
  const input = h('input', {
    class: 'input',
    type: 'text',
    autocomplete: 'off',
    'aria-label': 'Type RESET to confirm',
  });
  const confirmButton = h(
    'button',
    { type: 'button', class: 'btn btn-danger', disabled: true },
    'Reset everything',
  );
  input.addEventListener('input', () => (confirmButton.disabled = input.value.trim() !== 'RESET'));
  const confirmed = await new Promise((resolve) => {
    let ok = false;
    confirmButton.addEventListener('click', () => ((ok = true), handle.close()));
    const handle = openDialog({
      title: 'Reset Deadline Reminder?',
      size: 'sm',
      body: [
        h(
          'p',
          { class: 'confirm-message' },
          'This permanently deletes every deadline, the document library, stored files, reminder history and your settings in this browser. Export a backup first if you might need anything.',
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field-label' }, 'Type RESET to confirm'),
          input,
        ),
      ],
      footer: [
        h(
          'button',
          { type: 'button', class: 'btn', on: { click: () => handle.close() } },
          'Cancel',
        ),
        confirmButton,
      ],
      onClose: () => resolve(ok),
    });
    input.focus();
  });
  if (!confirmed) return;
  await app.storage.replaceAll({
    assessments: [],
    settings: DEFAULT_SETTINGS,
    documents: [],
    reminderState: {},
  });
  await fileStore.clear().catch(() => {});
  showToast('Everything was reset');
}

/** Storage used in chrome.storage.local and (for kept files) IndexedDB. */
export async function storageUsage() {
  const local = globalThis.chrome?.storage?.local?.getBytesInUse
    ? await globalThis.chrome.storage.local.getBytesInUse(null)
    : null;
  const estimate = navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => null)
    : null;
  return { local, total: estimate?.usage ?? null };
}

export function storageUsageLine(container) {
  storageUsage().then(({ local, total }) => {
    const parts = [];
    if (local !== null)
      parts.push(
        `${formatBytes(local)} of 10 MB used by deadlines, settings and the document library`,
      );
    if (total !== null)
      parts.push(`${formatBytes(total)} used by the extension in total (including any kept files)`);
    container.textContent = parts.join(' · ') || 'Storage usage is not available here.';
  });
  return container;
}

export function demoControls(app) {
  const hasDemo = app.getState().assessments.some((item) => item.isDemo);
  return h(
    'div',
    { class: 'inline-row wrap' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        disabled: hasDemo,
        on: {
          click: async () => {
            const added = await loadDemoData(app.storage);
            showToast(
              added ? `Added ${added} demo deadlines` : 'Demo deadlines are already loaded',
            );
          },
        },
      },
      icon('plus', { size: 14 }),
      'Load demo deadlines',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        disabled: !hasDemo,
        on: {
          click: async () => {
            const removed = await removeDemoData(app.storage);
            showToast(`Removed ${removed} demo deadlines`);
          },
        },
      },
      icon('trash', { size: 14 }),
      'Remove demo deadlines',
    ),
  );
}
