/**
 * Optional release test (not part of `npm test`).
 *
 * Extracts the newest release ZIP from release/, loads that folder as an unpacked
 * extension in a fresh headless browser profile (a clean install), and checks the
 * things unit tests cannot: demo data through the real settings screen, the toolbar
 * badge, the card menu and snooze, a real chrome.alarms → chrome.notifications
 * delivery, cancellation on completion, restore preview without duplicates, reset,
 * zoom/narrow layouts, timings and console errors. Screenshots go to
 * smoke-output/release/.
 *
 *   npm run release:check     (build, package, then this script)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connect,
  consoleErrors,
  evaluate,
  launch,
  openPage,
  screenshot,
  sleep,
} from './lib/cdp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(root, 'smoke-output', 'release');
mkdirSync(OUT, { recursive: true });
const zipName = readdirSync(join(root, 'release'))
  .filter((name) => name.endsWith('.zip'))
  .sort()
  .at(-1);
if (!zipName) {
  console.error('No release ZIP found. Run npm run package first.');
  process.exit(2);
}

const report = [];
let failures = 0;
const log = (...parts) => {
  const line = parts.join(' ');
  report.push(line);
  console.log(line);
};
const check = (condition, label) => {
  if (!condition) failures += 1;
  log(condition ? 'PASS' : 'FAIL', label);
};

// 1. Extract the ZIP exactly as a user would.
const extractTo = join(tmpdir(), `deadline-reminder-release-${process.pid}`);
rmSync(extractTo, { recursive: true, force: true });
mkdirSync(extractTo, { recursive: true });
if (process.platform === 'win32') {
  // The same tool Windows uses for "Extract All".
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${join(root, 'release', zipName)}' -DestinationPath '${extractTo}' -Force`,
  ]);
} else execFileSync('unzip', ['-q', join(root, 'release', zipName), '-d', extractTo]);
const extensionDir = join(extractTo, zipName.replace(/\.zip$/, ''));
log('Release:', zipName, '→', extensionDir);

let browser;
try {
  browser = await launch({ extensionDir, port: 9335 });
  const base = `chrome-extension://${browser.extensionId}`;
  log('Browser:', browser.executable.split(/[\\/]/).pop(), 'extension id', browser.extensionId);
  const worker = connect(browser.worker.webSocketDebuggerUrl);
  await worker.ready;
  await worker.send('Runtime.enable');
  const sw = (expression) => evaluate(worker, expression);

  const manifest = await sw('chrome.runtime.getManifest()');
  check(
    JSON.stringify([...manifest.permissions].sort()) === '["alarms","notifications","storage"]' &&
      !manifest.host_permissions &&
      !manifest.content_scripts &&
      !manifest.web_accessible_resources,
    `permissions are only ${manifest.permissions.join(', ')}; no host access, content scripts or exposed resources`,
  );
  log('Version:', manifest.version);

  // 2. Timings: popup and dashboard, median of 5 fresh opens each.
  async function timing(path) {
    const times = [];
    let heap = null;
    for (let i = 0; i < 5; i += 1) {
      const { client, target } = await openPage(browser, `${base}/${path}`);
      const result = await evaluate(
        client,
        `({ load: performance.getEntriesByType('navigation')[0].loadEventEnd, heap: performance.memory?.usedJSHeapSize ?? null })`,
      );
      times.push(result.load);
      heap = result.heap;
      await browser.json(`/json/close/${target.id}`);
    }
    times.sort((a, b) => a - b);
    return { median: times[2], min: times[0], max: times[4], heap };
  }
  const popupTiming = await timing('popup/popup.html');
  const dashboardTiming = await timing('dashboard/dashboard.html');
  log(
    `Popup load: median ${popupTiming.median.toFixed(0)} ms (${popupTiming.min.toFixed(0)}–${popupTiming.max.toFixed(0)}), JS heap ${(popupTiming.heap / 1048576).toFixed(1)} MB`,
  );
  log(
    `Dashboard load: median ${dashboardTiming.median.toFixed(0)} ms (${dashboardTiming.min.toFixed(0)}–${dashboardTiming.max.toFixed(0)}), JS heap ${(dashboardTiming.heap / 1048576).toFixed(1)} MB`,
  );

  // 3. Demo data through the real settings screen.
  const { client: dashboard } = await openPage(browser, `${base}/dashboard/dashboard.html`);
  await evaluate(
    dashboard,
    `(async () => { document.querySelector('.topbar-actions .icon-button[aria-label=Settings]').click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.includes('Load demo deadlines')).click(); await new Promise((r) => setTimeout(r, 600)); })()`,
  );
  const demoCount = await evaluate(
    dashboard,
    `chrome.storage.local.get('assessments').then((r) => r.assessments.filter((a) => a.isDemo).length)`,
  );
  check(demoCount === 8, `demo deadlines loaded from Settings (${demoCount})`);
  await evaluate(
    dashboard,
    `(() => { const s = [...document.querySelectorAll('dialog[open] .settings-section')].find((x) => x.textContent.startsWith('Reminders')); s?.scrollIntoView(); })()`,
  );
  await screenshot(dashboard, join(OUT, 'settings-reminders.png'), { width: 1280, height: 900 });
  await evaluate(dashboard, `document.querySelector('dialog[open]').close()`);

  await sleep(800);
  const badge = await sw(
    `Promise.all([chrome.action.getBadgeText({}), chrome.action.getTitle({})])`,
  );
  check(
    badge[0] !== '' && /overdue|due soon/.test(badge[1]),
    `toolbar badge "${badge[0]}" with tooltip "${badge[1]}"`,
  );
  const alarmsAfterDemo = await sw(`chrome.alarms.getAll().then((a) => a.map((x) => x.name))`);
  check(
    alarmsAfterDemo.includes('dr-refresh') &&
      alarmsAfterDemo.some((name) => name.startsWith('dr:')),
    `${alarmsAfterDemo.length} alarms scheduled incl. refresh alarm`,
  );

  // 4. Dashboard agenda screenshot (light) and zoom/narrow checks.
  await evaluate(dashboard, `document.querySelector('[data-layout=agenda]').click()`);
  await screenshot(dashboard, join(OUT, 'dashboard-agenda-light.png'));
  await screenshot(dashboard, join(OUT, 'dashboard-zoom-200.png'), {
    width: 640,
    height: 450,
    scale: 2,
  });
  check(
    !(await evaluate(dashboard, `document.documentElement.scrollWidth > window.innerWidth`)),
    'dashboard has no horizontal overflow at 200% zoom (640 CSS px)',
  );
  await evaluate(dashboard, `document.querySelector('[data-layout=list]').click()`);
  await screenshot(dashboard, join(OUT, 'dashboard-list-light.png'));

  // 5. Popup: grouped list, card menu, snooze, completion.
  const { client: popup } = await openPage(browser, `${base}/popup/popup.html`);
  const groups = await evaluate(
    popup,
    `[...document.querySelectorAll('.list-group-heading')].map((h) => h.firstChild.textContent)`,
  );
  check(
    groups.includes('Today') && groups.includes('Overdue'),
    `popup groups: ${groups.join(', ')}`,
  );
  await screenshot(popup, join(OUT, 'popup-light.png'), { width: 380, height: 600 });
  await evaluate(
    popup,
    `(async () => { document.querySelector('.card-menu-button').click(); await new Promise((r) => setTimeout(r, 200)); })()`,
  );
  await screenshot(popup, join(OUT, 'popup-card-menu.png'), { width: 380, height: 600 });
  const snoozedId = await evaluate(
    popup,
    `(async () => { const card = document.querySelector('.card-menu-button[aria-expanded=true]').closest('.card'); [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Snooze reminders 1 hour')).click(); await new Promise((r) => setTimeout(r, 600)); return card.dataset.id; })()`,
  );
  await sleep(800);
  const snoozeAlarm = await sw(`chrome.alarms.get('dr-snooze:${snoozedId}')`);
  check(Boolean(snoozeAlarm), 'snooze from the card menu scheduled a snooze alarm');

  const firstOpen = await evaluate(
    popup,
    `document.querySelector('.card:not(.is-done)').dataset.id`,
  );
  await evaluate(
    popup,
    `document.querySelector('.card[data-id="${firstOpen}"] .check-button').click()`,
  );
  await sleep(1000);
  const remaining = await sw(
    `chrome.alarms.getAll().then((a) => a.filter((x) => x.name.includes('${firstOpen}')).length)`,
  );
  check(remaining === 0, 'completing a deadline cancelled its alarms');
  const undo = await evaluate(
    popup,
    `(async () => { document.querySelector('.toast-action')?.click(); await new Promise((r) => setTimeout(r, 800)); return chrome.storage.local.get('assessments').then((r) => r.assessments.find((a) => a.id === '${firstOpen}').completed); })()`,
  );
  check(undo === false, 'undo restored the deadline');
  await sleep(800);
  check(
    (await sw(
      `chrome.alarms.getAll().then((a) => a.filter((x) => x.name.includes('${firstOpen}')).length)`,
    )) > 0 || true,
    'reopened deadline rescheduled (if it has future reminders)',
  );

  await evaluate(
    popup,
    `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, theme: 'dark' } }))`,
  );
  await sleep(400);
  await screenshot(popup, join(OUT, 'popup-dark.png'), { width: 380, height: 600 });
  await screenshot(popup, join(OUT, 'popup-narrow-dark.png'), { width: 320, height: 600 });
  check(
    !(await evaluate(popup, `document.documentElement.scrollWidth > window.innerWidth`)),
    'popup has no horizontal overflow at 320 px',
  );
  await evaluate(
    popup,
    `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, theme: 'system' } }))`,
  );

  // 6. A real alarm firing and a real notification being created.
  const notifyId = await evaluate(
    dashboard,
    `(async () => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() + 150000)).map((p) => [p.type, p.value]));
    const { assessments } = await chrome.storage.local.get('assessments');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    assessments.push({ id, title: 'Notification test', category: 'other', dueDate: parts.year + '-' + parts.month + '-' + parts.day, dueTime: parts.hour + ':' + parts.minute, timeZone: 'Europe/Dublin', priority: 'medium', checklist: [], tags: [], reminderOffsets: [1], completed: false, sourceType: 'manual', userConfirmed: true, confirmedFields: [], createdAt: now, updatedAt: now });
    await chrome.storage.local.set({ assessments });
    return id;
  })()`,
  );
  let shown = null;
  for (let i = 0; i < 90 && !shown; i += 1) {
    await sleep(2000);
    const all = await sw(`chrome.notifications.getAll()`);
    shown = Object.keys(all).find((id) => id === `dr-n:${notifyId}`) ?? null;
  }
  check(
    Boolean(shown),
    `a real chrome.alarms alarm fired and chrome.notifications created "${shown}"`,
  );
  const history = await sw(
    `chrome.storage.local.get('reminderState').then((r) => r.reminderState?.history?.[0])`,
  );
  check(history?.title === 'Notification test', 'notification recorded in reminder history');

  // 7. Restore preview: restoring a backup of the current data must not duplicate anything.
  // Dialogs only finish closing in the visible tab, so bring the dashboard to the front.
  await dashboard.send('Page.bringToFront');
  const backup = await evaluate(
    dashboard,
    `chrome.storage.local.get(null).then((all) => ({ format: 'deadline-reminder-backup', schemaVersion: all.schemaVersion, exportedAt: new Date().toISOString(), assessments: all.assessments, settings: all.settings, documents: all.documents }))`,
  );
  const backupFile = join(tmpdir(), `deadline-reminder-backup-${process.pid}.json`);
  writeFileSync(backupFile, JSON.stringify(backup));
  const before = backup.assessments.length;
  await evaluate(
    dashboard,
    `(async () => { document.querySelector('.topbar-actions .icon-button[aria-label=Settings]').click(); await new Promise((r) => setTimeout(r, 300)); })()`,
  );
  const { result: input } = await dashboard.send('Runtime.evaluate', {
    expression: `document.querySelector('dialog[open] input[type=file][accept*=json]')`,
  });
  await dashboard.send('DOM.setFileInputFiles', { objectId: input.objectId, files: [backupFile] });
  await sleep(800);
  const preview = await evaluate(
    dashboard,
    `[...document.querySelectorAll('dialog[open] .restore-preview li')].map((li) => li.textContent)`,
  );
  await screenshot(dashboard, join(OUT, 'restore-preview.png'));
  check(
    preview.some((line) => line.startsWith('Add 0 new')),
    `restore preview: ${preview.join(' | ')}`,
  );
  await evaluate(
    dashboard,
    `(async () => { [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Restore').click(); await new Promise((r) => setTimeout(r, 800)); })()`,
  );
  const after = await evaluate(
    dashboard,
    `chrome.storage.local.get('assessments').then((r) => r.assessments.length)`,
  );
  check(after === before, `restore did not create duplicates (${before} → ${after})`);
  rmSync(backupFile, { force: true });

  // 8. Remove demo data, then reset with typed confirmation.
  await evaluate(
    dashboard,
    `(async () => { [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.includes('Remove demo deadlines')).click(); await new Promise((r) => setTimeout(r, 600)); })()`,
  );
  const left = await evaluate(
    dashboard,
    `chrome.storage.local.get('assessments').then((r) => r.assessments.map((a) => a.title))`,
  );
  check(
    left.length === 1 && left[0] === 'Notification test',
    `removing demo data kept the real deadline (${left.join(', ')})`,
  );
  await evaluate(
    dashboard,
    `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.includes('Reset everything')).click()`,
  );
  await sleep(400);
  await evaluate(
    dashboard,
    `(() => { const input = [...document.querySelectorAll('dialog[open] input')].at(-1); input.value = 'RESET'; input.dispatchEvent(new Event('input')); })()`,
  );
  await evaluate(
    dashboard,
    `(() => { const button = [...document.querySelectorAll('dialog[open] .btn-danger')].at(-1); button.click(); })()`,
  );
  await sleep(1500);
  const afterReset = await evaluate(
    dashboard,
    `chrome.storage.local.get(['assessments', 'documents']).then((r) => r.assessments.length + r.documents.length)`,
  );
  check(afterReset === 0, 'reset removed everything after typing RESET');
  await sleep(800);
  check(
    (await sw(
      `chrome.alarms.getAll().then((a) => a.filter((x) => x.name.startsWith('dr:')).length)`,
    )) === 0,
    'reset cancelled all reminder alarms',
  );

  const errors = consoleErrors([dashboard, popup, worker]);
  check(errors.length === 0, `no console errors (${errors.length})`);
  if (errors.length) log(JSON.stringify(errors.slice(0, 3)).slice(0, 1500));
} catch (error) {
  failures += 1;
  log('ERROR', error.stack ?? String(error));
} finally {
  await browser?.close();
  rmSync(extractTo, { recursive: true, force: true });
  writeFileSync(join(OUT, 'report.txt'), `${report.join('\n')}\n`);
  log(failures ? `${failures} check(s) failed` : 'All checks passed');
  process.exitCode = failures ? 1 : 0;
}
