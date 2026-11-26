/**
 * Optional browser smoke test (not part of `npm test`).
 *
 * Loads dist/ as an unpacked extension in a headless Chromium browser, drives the
 * popup and dashboard over the Chrome DevTools Protocol, checks for console errors,
 * horizontal overflow and scheduled alarms, and saves screenshots.
 *
 *   npm run build
 *   npm run smoke            # screenshots go to ./smoke-output
 *
 * Google Chrome 137+ ignores --load-extension, so this defaults to Microsoft Edge.
 * Set BROWSER_PATH to use another Chromium build (e.g. Chromium or Chrome for Testing).
 * Uses a throwaway profile; your normal browser profile is never touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const EDGE = CANDIDATES.find((path) => existsSync(path));
if (!EDGE) {
  console.error('No Chromium browser found. Set BROWSER_PATH.');
  process.exit(2);
}
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const OUT = process.argv[2] ?? fileURLToPath(new URL('../smoke-output', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PORT = 9333;
// A throwaway browser profile in the temp directory, removed at the end.
const profile = join(tmpdir(), `deadline-reminder-smoke-${process.pid}`);
mkdirSync(profile, { recursive: true });

const browser = spawn(EDGE, [
  '--headless=new',
  `--user-data-dir=${profile}`,
  `--load-extension=${DIST}`,
  `--disable-extensions-except=${DIST}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=msEdgeFRE',
  'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function json(path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else events.push(msg);
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function shot(client, name, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  log('screenshot', name);
}

try {
  let targets = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      targets = await json('/json/list');
      if (targets.some((t) => t.url.startsWith('chrome-extension://'))) break;
    } catch {
      // The debugging port is not ready yet; try again.
    }
  }
  const sw = targets.find(
    (t) => t.type === 'service_worker' && t.url.includes('background/service-worker.js'),
  );
  if (!sw) {
    log(
      'No extension service worker target found. Targets:',
      targets.map((t) => `${t.type} ${t.url}`),
    );
    process.exit(2);
  }
  const extId = new URL(sw.url).host;
  log('Extension loaded, id', extId, 'service worker:', sw.url);

  const swc = connect(sw.webSocketDebuggerUrl);
  await swc.ready;
  await swc.send('Runtime.enable');
  const manifest = await evaluate(swc, 'chrome.runtime.getManifest()');
  log('manifest permissions', manifest.permissions, 'version', manifest.version);
  const initial = await evaluate(swc, 'chrome.storage.local.get(null)');
  log(
    'storage after install: schemaVersion',
    initial.schemaVersion,
    'assessments',
    initial.assessments?.length,
    'tz',
    initial.settings?.timeZone,
  );

  // Open the popup page in a tab.
  const page = await json(`/json/new?chrome-extension://${extId}/popup/popup.html`, 'PUT');
  const pc = connect(page.webSocketDebuggerUrl);
  await pc.ready;
  await pc.send('Page.enable');
  await pc.send('Runtime.enable');
  await pc.send('Log.enable');
  await pc.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await sleep(800);

  // Empty state screenshot.
  await shot(pc, '01-popup-empty-light', 380, 560);

  // Use the real quick-add UI: click Add deadline, type, submit.
  await evaluate(
    pc,
    `(async () => {
    document.querySelector('.add-button').click();
    const title = document.querySelector('.quick-add input[name=title]');
    title.value = 'Quick-added via UI';
    document.querySelector('.quick-add input[name=dueDate]').value = '2026-11-28';
    document.querySelector('.quick-add').requestSubmit();
    await new Promise(r => setTimeout(r, 400));
    return document.querySelectorAll('.card').length;
  })()`,
  ).then((n) => log('cards after quick add:', n));

  // Validation: empty title must show an error and not save.
  const validation = await evaluate(
    pc,
    `(async () => {
    document.querySelector('.add-button').click();
    document.querySelector('.quick-add input[name=title]').value = '';
    document.querySelector('.quick-add').requestSubmit();
    await new Promise(r => setTimeout(r, 300));
    const err = document.querySelector('.quick-add .field-error');
    const text = err && !err.hidden ? err.textContent : null;
    document.querySelector('.quick-add').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    return text;
  })()`,
  );
  log('quick add validation message:', validation);

  // Seed realistic data through the same storage the UI uses.
  const seed = `(() => {
    const now = new Date().toISOString();
    const mk = (o) => ({ id: crypto.randomUUID(), category: 'assignment', moduleName: null, moduleCode: null, dueTime: null,
      timeZone: 'Europe/Dublin', weighting: null, priority: 'medium', description: null, notes: null, submissionUrl: null,
      checklist: [], reminderOffsets: null, estimatedMinutes: null, tags: [], completed: false, completedAt: null,
      sourceType: 'manual', sourceDocument: null, extractionConfidence: null, userConfirmed: true, confirmedFields: ['title','dueDate'],
      createdAt: now, updatedAt: now, ...o });
    return chrome.storage.local.get('assessments').then(({assessments}) => chrome.storage.local.set({ assessments: [...assessments,
      mk({ title: 'CA2 Group Project Report', moduleName: 'Software Engineering', moduleCode: 'COMP3010', dueDate: '2026-12-11', dueTime: '17:00', weighting: 40, priority: 'high',
           checklist: [{id:'c1',text:'Draft sections',done:true},{id:'c2',text:'Peer review',done:false},{id:'c3',text:'Submit PDF',done:false}],
           notes: 'Meet the group on Tuesday.', submissionUrl: 'https://moodle.example.ie/mod/assign/view.php?id=1', tags: ['group'],
           sourceDocument: { id: 'd1', name: 'CA2-brief.pdf', type: 'pdf', size: 248000, attachedAt: now } }),
      mk({ title: 'Lab 4: Titration write-up', moduleCode: 'CHEM1102', moduleName: 'Analytical Chemistry', category: 'lab', dueDate: '2026-11-27', weighting: 10 }),
      mk({ title: 'Mid-term examination', moduleCode: 'MATH2001', moduleName: 'Linear Algebra', category: 'exam', dueDate: '2026-12-03', dueTime: '09:30', weighting: 25, priority: 'high' }),
      mk({ title: 'Reading reflection', moduleName: 'Ethics in Computing', dueDate: '2026-11-21', priority: 'low' }),
      mk({ title: 'Dentist appointment', category: 'appointment', dueDate: '2026-12-01', dueTime: '14:15', priority: 'low' }),
      mk({ title: 'Portfolio presentation', moduleCode: 'COMP3010', moduleName: 'Software Engineering', category: 'presentation', dueDate: '2027-01-14', weighting: 20 }),
      mk({ title: 'CA1 Requirements Spec', moduleCode: 'COMP3010', moduleName: 'Software Engineering', dueDate: '2026-11-06', weighting: 20, completed: true, completedAt: now }),
    ]}));
  })()`;
  await evaluate(pc, seed);
  await sleep(500);
  const popupState = await evaluate(
    pc,
    `({ cards: document.querySelectorAll('.card').length,
    next: document.querySelector('.next-title')?.textContent, stats: [...document.querySelectorAll('.stat-value')].map(e=>e.textContent),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })`,
  );
  log('popup after seed (live update via storage.onChanged):', JSON.stringify(popupState));
  await shot(pc, '02-popup-light', 380, 600);

  // Search
  const searchCount = await evaluate(
    pc,
    `(async () => { const s = document.querySelector('input[type=search]'); s.value='comp3010'; s.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); const n = document.querySelectorAll('.card').length; s.value=''; s.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); return n; })()`,
  );
  log('popup search "comp3010" cards:', searchCount);

  // Completed tab
  const completedCount = await evaluate(
    pc,
    `(async () => { document.querySelector('#tab-completed').click(); await new Promise(r=>setTimeout(r,100)); const n = document.querySelectorAll('.card').length; document.querySelector('#tab-upcoming').click(); return n; })()`,
  );
  log('popup completed tab cards:', completedCount);

  // Dark theme via theme toggle (system -> light -> dark)
  await evaluate(
    pc,
    `(async () => { const b = document.querySelector('.header-actions .icon-button'); b.click(); await new Promise(r=>setTimeout(r,200)); b.click(); await new Promise(r=>setTimeout(r,300)); return document.documentElement.dataset.theme; })()`,
  ).then((t) => log('theme after two toggles:', t));
  await shot(pc, '03-popup-dark', 380, 600);

  // Open add dialog in dark mode
  await evaluate(
    pc,
    `(async () => { document.querySelector('.add-button').click(); await new Promise(r=>setTimeout(r,200)); [...document.querySelectorAll('.quick-actions .btn')].find((b) => b.textContent === 'Advanced options').click(); await new Promise(r=>setTimeout(r,300)); return !!document.querySelector('dialog[open]'); })()`,
  ).then((t) => log('advanced form dialog open:', t));
  await shot(pc, '04-popup-form-dark', 380, 600);
  await evaluate(pc, `document.querySelector('dialog[open]').close()`);

  // Dashboard
  const dash = await json(`/json/new?chrome-extension://${extId}/dashboard/dashboard.html`, 'PUT');
  const dc = connect(dash.webSocketDebuggerUrl);
  await dc.ready;
  await dc.send('Page.enable');
  await dc.send('Runtime.enable');
  await dc.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await sleep(800);
  await evaluate(
    dc,
    `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({settings: {...settings, theme: 'light'}}))`,
  );
  await sleep(400);
  await shot(dc, '05-dashboard-list-light', 1280, 800);
  const overflow = async (label) =>
    log(
      label,
      'horizontal overflow:',
      await evaluate(dc, 'document.documentElement.scrollWidth > window.innerWidth'),
    );
  await overflow('dashboard 1280');

  await evaluate(dc, `document.querySelector('[data-layout=agenda]').click()`);
  await shot(dc, '06-dashboard-agenda-light', 1280, 800);
  await evaluate(dc, `document.querySelector('[data-layout=calendar]').click()`);
  await sleep(200);
  await evaluate(dc, `document.querySelector('[data-action=month][data-delta="1"]').click()`);
  await shot(dc, '07-dashboard-calendar-light', 1280, 900);

  await evaluate(dc, `document.querySelector('[data-layout=list]').click()`);
  // Details dialog for the first card with a checklist
  await evaluate(
    dc,
    `(async () => { const card=[...document.querySelectorAll('.card')].find(c=>c.textContent.includes('CA2 Group')); card.querySelector('[data-action=open]').click(); await new Promise(r=>setTimeout(r,300)); })()`,
  );
  await shot(dc, '08-dashboard-details-light', 1280, 900);
  const reminders = await evaluate(
    dc,
    `[...document.querySelectorAll('.reminder-list li')].map(li=>li.textContent)`,
  );
  log('details reminders:', JSON.stringify(reminders));
  await evaluate(dc, `document.querySelector('dialog[open]').close()`);

  // Edit form (advanced open) via Add deadline button
  await evaluate(
    dc,
    `(async () => { [...document.querySelectorAll('.topbar .btn-primary')][0].click(); await new Promise(r=>setTimeout(r,300)); document.querySelector('dialog[open] details.advanced').open = true; })()`,
  );
  await shot(dc, '09-dashboard-add-form', 1280, 900);
  // Submit invalid form to show errors
  await evaluate(
    dc,
    `(async () => { document.querySelector('dialog[open] input[name=submissionUrl]').value='javascript:alert(1)'; document.querySelector('dialog[open] form').requestSubmit(); await new Promise(r=>setTimeout(r,300)); })()`,
  );
  const errors = await evaluate(
    dc,
    `[...document.querySelectorAll('dialog[open] .field-error:not([hidden])')].map(e=>e.textContent)`,
  );
  log('add form errors:', JSON.stringify(errors));
  // Fill valid and submit
  const created = await evaluate(
    dc,
    `(async () => {
    const d = document.querySelector('dialog[open]');
    d.querySelector('input[name=title]').value = 'Essay draft <script>alert(1)</script>';
    d.querySelector('input[name=dueDate]').value = '2026-12-09';
    d.querySelector('input[name=submissionUrl]').value = '';
    d.querySelector('form').requestSubmit();
    await new Promise(r=>setTimeout(r,500));
    const card = [...document.querySelectorAll('.card-title')].find(t=>t.textContent.includes('Essay draft'));
    return { dialogOpen: !!document.querySelector('dialog[open]'), rendered: card?.textContent, scriptElements: document.querySelectorAll('.card script').length };
  })()`,
  );
  log('created via dashboard form:', JSON.stringify(created));

  // Settings + dark
  await evaluate(
    dc,
    `(async () => { document.querySelector('.topbar-actions .icon-button[aria-label=Settings]').click(); await new Promise(r=>setTimeout(r,300)); })()`,
  );
  await evaluate(
    dc,
    `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({settings: {...settings, theme: 'dark'}}))`,
  );
  await sleep(400);
  await shot(dc, '10-dashboard-settings-dark', 1280, 900);
  await evaluate(dc, `document.querySelector('dialog[open]').close()`);
  await shot(dc, '11-dashboard-list-dark', 1280, 800);

  // Narrow width
  await shot(dc, '12-dashboard-narrow-dark', 420, 900);
  await overflow('dashboard 420');
  await evaluate(
    dc,
    `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({settings: {...settings, theme: 'system'}}))`,
  );

  // Alarms in the service worker
  await sleep(800);
  const alarms = await evaluate(
    swc,
    `chrome.alarms.getAll().then(a => a.map(x => x.name.split(':').at(-1) + ' @ ' + new Date(x.scheduledTime).toISOString()).sort())`,
  );
  log('alarms scheduled by service worker:', alarms.length, JSON.stringify(alarms.slice(0, 6)));

  // Persistence: close popup tab, reopen
  await json(`/json/close/${page.id}`);
  const page2 = await json(`/json/new?chrome-extension://${extId}/popup/popup.html`, 'PUT');
  const pc2 = connect(page2.webSocketDebuggerUrl);
  await pc2.ready;
  await pc2.send('Runtime.enable');
  await sleep(800);
  log('reopened popup cards:', await evaluate(pc2, `document.querySelectorAll('.card').length`));

  const errorsLogged = [...pc.events, ...dc.events, ...swc.events, ...pc2.events].filter(
    (e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'),
  );
  log(
    'console errors/exceptions:',
    errorsLogged.length,
    JSON.stringify(errorsLogged.map((e) => e.params).slice(0, 5)),
  );
} catch (error) {
  console.error('E2E failed:', error);
  process.exitCode = 1;
} finally {
  browser.kill();
  if (process.platform === 'win32') {
    // Edge re-parents its helper processes, so stop every process using this profile.
    spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
    ]);
  }
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Windows may hold a lock briefly; the folder is in the temp directory.
  }
}
