/**
 * Optional browser test of Stage 2 (not part of `npm test`).
 *
 * Loads dist/ as an unpacked extension in headless Edge (or BROWSER_PATH), imports the
 * synthetic files from fixtures-output/ through the real import page, confirms
 * reviews, checks duplicate handling and the document library, measures timings and
 * storage use, and saves screenshots to smoke-output/import/.
 *
 *   npm run build && npm run fixtures && npm run smoke:import
 */
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BROWSER = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
if (!BROWSER) {
  console.error('No Chromium browser found. Set BROWSER_PATH.');
  process.exit(2);
}
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures-output/', import.meta.url));
const OUT = fileURLToPath(new URL('../smoke-output/import/', import.meta.url));
const PORT = 9334;
mkdirSync(OUT, { recursive: true });
// A throwaway browser profile outside the project; removed at the end.
const profile = join(tmpdir(), `deadline-reminder-smoke-${process.pid}`);

const browser = spawn(BROWSER, [
  '--headless=new',
  `--user-data-dir=${profile}`,
  `--load-extension=${DIST}`,
  `--disable-extensions-except=${DIST}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = [];
const log = (...parts) => {
  const line = parts.join(' ');
  report.push(line);
  console.log(line);
};
let failures = 0;
const check = (condition, label) => {
  if (!condition) failures += 1;
  log(condition ? 'PASS' : 'FAIL', label);
};

async function json(path, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    } else events.push(data);
  };
  const ready = new Promise((resolve) => (socket.onopen = resolve));
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
  return result.result.value;
}

async function shot(client, name, width = 1280, height = 900) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

async function openPage(url) {
  const target = await json(`/json/new?${url}`, 'PUT');
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  for (let i = 0; i < 50; i += 1) {
    const ready = await evaluate(
      client,
      `document.readyState === 'complete' && Boolean(document.getElementById('app')) && !document.getElementById('app').hasAttribute('aria-busy')`,
    ).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  return { client, target };
}

async function addFiles(client, names) {
  const { result } = await client.send('Runtime.evaluate', {
    expression: `document.querySelector('input[type=file]')`,
  });
  await client.send('DOM.setFileInputFiles', {
    objectId: result.objectId,
    files: names.map((name) => join(FIXTURES, name)),
  });
}

async function waitForQueue(client, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const busy = await evaluate(
      client,
      `[...document.querySelectorAll('.queue-status')].some((el) => /status-(processing|queued)/.test(el.className))`,
    );
    if (!busy) return true;
    await sleep(200);
  }
  return false;
}

const queueState = (client) =>
  evaluate(
    client,
    `[...document.querySelectorAll('.queue-item')].map((row) => ({
      name: row.querySelector('.queue-name').textContent,
      status: row.querySelector('.queue-status').className.replace(/.*status-/, ''),
      text: row.querySelector('.queue-status').textContent,
      badge: row.querySelector('.badge')?.textContent ?? null,
      ms: Number(row.querySelector('[data-ms]')?.dataset.ms ?? NaN),
    }))`,
  );

const clickReview = (client, name) =>
  evaluate(
    client,
    `(async () => { const row = [...document.querySelectorAll('.queue-item')].find((r) => r.querySelector('.queue-name').textContent === ${JSON.stringify(name)}); row.querySelector('.btn-primary').click(); await new Promise((r) => setTimeout(r, 300)); return document.querySelector('.review h2')?.textContent; })()`,
  );

const save = (client) =>
  evaluate(
    client,
    `(async () => { const button = [...document.querySelectorAll('.review-footer .btn-primary')][0]; button.click(); await new Promise((r) => setTimeout(r, 600)); return { error: document.querySelector('.review .form-error:not([hidden])')?.textContent ?? null, toast: document.querySelector('.toast-message')?.textContent ?? null }; })()`,
  );

try {
  let targets = [];
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      targets = await json('/json/list');
      if (targets.some((target) => target.url.endsWith('/background/service-worker.js'))) break;
    } catch {
      // Not ready yet.
    }
  }
  const worker = targets.find(
    (target) =>
      target.type === 'service_worker' && target.url.endsWith('/background/service-worker.js'),
  );
  if (!worker) throw new Error('Extension did not load');
  const extensionId = new URL(worker.url).host;
  const base = `chrome-extension://${extensionId}`;
  log('Extension loaded:', extensionId, 'browser:', BROWSER.split('/').pop());

  // ---- Popup load time (median of 5 cold opens) ----
  const popupTimes = [];
  for (let i = 0; i < 5; i += 1) {
    const { client, target } = await openPage(`${base}/popup/popup.html`);
    const timing = await evaluate(
      client,
      `(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, ready: true }; })()`,
    );
    popupTimes.push(timing.load);
    await json(`/json/close/${target.id}`);
  }
  popupTimes.sort((a, b) => a - b);
  log(
    `Popup load (median of 5): ${popupTimes[2].toFixed(0)} ms (range ${popupTimes[0].toFixed(0)}–${popupTimes[4].toFixed(0)} ms)`,
  );
  const { client: popup } = await openPage(`${base}/popup/popup.html`);
  const popupScripts = await evaluate(
    popup,
    `[...document.querySelectorAll('script[src], link[href]')].map((el) => (el.src || el.href).split('/').pop())`,
  );
  check(
    !popupScripts.some((name) => /pdf|docx-worker|mammoth/.test(name)),
    `popup loaded no document libraries (${popupScripts.length} resources)`,
  );

  // ---- Import batch 1: mixed valid and invalid files ----
  const { client: page } = await openPage(`${base}/import/import.html`);
  log(
    'import page:',
    JSON.stringify(
      await evaluate(
        page,
        `({ url: location.href, text: document.body.innerText.slice(0, 200), inputs: document.querySelectorAll('input').length })`,
      ),
    ),
  );
  const batch1 = [
    'clear-brief.pdf',
    'structured-brief.docx',
    'ambiguous-dates.pdf',
    'two-assessments.docx',
    'missing-year.pdf',
    'scanned.pdf',
    'password.pdf',
    'corrupted.pdf',
    'macro.docx',
    'archive-bomb.docx',
  ];
  const batchStart = Date.now();
  await addFiles(page, batch1);
  check(await waitForQueue(page), 'batch of 10 files finished processing');
  const batchMs = Date.now() - batchStart;
  const state1 = await queueState(page);
  for (const row of state1)
    log(
      `  ${row.name.padEnd(24)} ${row.status.padEnd(8)} ${Number.isNaN(row.ms) ? '' : `${row.ms} ms`}  ${row.status === 'failed' ? row.text : ''}`,
    );
  log(`Batch of ${batch1.length} files: ${batchMs} ms wall time (2 at a time)`);
  const status = Object.fromEntries(state1.map((row) => [row.name, row]));
  for (const name of [
    'clear-brief.pdf',
    'structured-brief.docx',
    'ambiguous-dates.pdf',
    'two-assessments.docx',
    'missing-year.pdf',
    'scanned.pdf',
  ]) {
    check(status[name]?.status === 'review', `${name} ready for review`);
  }
  check(
    /password/i.test(status['password.pdf']?.text),
    'password-protected PDF rejected with explanation',
  );
  check(/damaged|valid PDF/i.test(status['corrupted.pdf']?.text), 'corrupted PDF rejected');
  check(/macro/i.test(status['macro.docx']?.text), 'macro DOCX rejected');
  check(/archive bomb/i.test(status['archive-bomb.docx']?.text), 'archive bomb rejected');
  await shot(page, '01-import-queue-and-review');

  // Review: clear brief, one high-confidence deadline pre-selected.
  await clickReview(page, 'clear-brief.pdf');
  const clear = await evaluate(
    page,
    `({ checked: document.querySelector('.choices input:checked')?.closest('.choice').textContent, conf: [...document.querySelectorAll('.review .conf')].map((c) => c.textContent).slice(0, 4) })`,
  );
  check(
    /11 Dec/.test(clear.checked ?? ''),
    `clear brief deadline pre-selected (${clear.checked?.slice(0, 40)})`,
  );
  await shot(page, '02-review-clear-pdf');
  const saved1 = await save(page);
  check(/Saved 1 deadline/.test(saved1.toast ?? ''), `clear brief saved (${saved1.toast})`);

  // Ambiguous: nothing pre-selected; saving without choosing must fail.
  await clickReview(page, 'ambiguous-dates.pdf');
  const ambiguous = await evaluate(
    page,
    `({ options: [...document.querySelectorAll('.choices .choice-title')].map((e) => e.textContent), checked: document.querySelectorAll('.choices input:checked').length })`,
  );
  check(
    ambiguous.checked === 0 && ambiguous.options.length === 2,
    `ambiguous date offers 2 readings, none selected (${ambiguous.options.join(' | ')})`,
  );
  await shot(page, '03-review-ambiguous');
  const blocked = await save(page);
  check(
    Boolean(blocked.error),
    `cannot save ambiguous deadline without choosing (${blocked.error})`,
  );
  await evaluate(page, `document.querySelector('.choices input').click()`);
  const saved2 = await save(page);
  check(/Saved 1 deadline/.test(saved2.toast ?? ''), 'ambiguous brief saved after choosing');

  // Multiple assessments from one document.
  await clickReview(page, 'two-assessments.docx');
  const multi = await evaluate(page, `document.querySelectorAll('.candidate').length`);
  check(multi === 2, `two assessments found in one DOCX (${multi})`);
  await shot(page, '04-review-two-assessments');
  const saved3 = await save(page);
  check(/Saved 2 deadlines/.test(saved3.toast ?? ''), 'both assessments saved');

  // Missing year: suggestions, not selected.
  await clickReview(page, 'missing-year.pdf');
  const missing = await evaluate(
    page,
    `({ options: [...document.querySelectorAll('.choices .choice-title')].map((e) => e.textContent), checked: document.querySelectorAll('.choices input:checked').length })`,
  );
  check(
    missing.checked === 0 && missing.options.some((o) => /suggested/.test(o)),
    `missing year gives suggestions only (${missing.options[0]})`,
  );

  // Structured DOCX: deliverables and criteria extracted.
  await clickReview(page, 'structured-brief.docx');
  const structured = await evaluate(
    page,
    `({ deliverables: [...document.querySelectorAll('.review-section')].find((s) => s.querySelector('summary').textContent.startsWith('Deliverables'))?.querySelectorAll('li').length, time: document.querySelector('input[name=dueTime]').value })`,
  );
  check(
    structured.deliverables === 3 && structured.time === '23:59',
    `DOCX deliverables (${structured.deliverables}) and 11:59 PM → ${structured.time}`,
  );
  await save(page);

  // Scanned: explained, user can still enter manually.
  await clickReview(page, 'scanned.pdf');
  const scanned = await evaluate(
    page,
    `document.querySelector('.review-warnings')?.textContent ?? ''`,
  );
  check(/scanned/i.test(scanned), 'scanned PDF explained');
  await shot(page, '05-review-scanned');

  // ---- Batch 2: duplicates and updated version ----
  await addFiles(page, [
    'clear-brief.pdf',
    'clear-brief (copy).pdf',
    'clear-brief v2.pdf',
    'long-brief.pdf',
    'long-brief.docx',
  ]);
  await waitForQueue(page);
  const state2 = await queueState(page);
  const latest = (name) => state2.filter((row) => row.name === name).at(-1);
  check(
    latest('clear-brief.pdf').badge === 'Duplicate',
    'identical re-import flagged as duplicate',
  );
  check(
    latest('clear-brief (copy).pdf').badge === 'Renamed copy',
    'renamed copy recognised by hash',
  );
  check(latest('clear-brief v2.pdf').badge === 'Updated version', 'updated version recognised');
  log(
    `Long PDF (${'50 pages'}) read in ${latest('long-brief.pdf').ms} ms; long DOCX (2,400 paragraphs) in ${latest('long-brief.docx').ms} ms`,
  );

  const assessmentCountBefore = await evaluate(
    page,
    `chrome.storage.local.get('assessments').then((r) => r.assessments.length)`,
  );
  await evaluate(
    page,
    `(async () => { const rows = [...document.querySelectorAll('.queue-item')].filter((r) => r.querySelector('.queue-name').textContent === 'clear-brief v2.pdf'); rows.at(-1).querySelector('.btn-primary').click(); await new Promise((r) => setTimeout(r, 300)); })()`,
  );
  const compare = await evaluate(
    page,
    `[...document.querySelectorAll('.compare tbody tr')].map((tr) => ({ field: tr.querySelector('th').textContent, checked: tr.querySelector('input').checked }))`,
  );
  const dueRow = compare.find((row) => row.field.startsWith('Due date'));
  check(
    dueRow && !dueRow.checked,
    `update shows changed due date, not pre-ticked because it was confirmed (${JSON.stringify(compare)})`,
  );
  await shot(page, '06-review-update-compare');
  await evaluate(
    page,
    `[...document.querySelectorAll('.compare tbody tr')].find((tr) => tr.querySelector('th').textContent.startsWith('Due date')).querySelector('input').click()`,
  );
  const saved4 = await save(page);
  log('update save:', JSON.stringify(saved4));
  const after = await evaluate(
    page,
    `chrome.storage.local.get(['assessments', 'documents']).then((r) => ({ count: r.assessments.length, dates: r.assessments.map((a) => a.title + '@' + a.dueDate), docs: r.documents.map((d) => d.fileName + ' prev=' + Boolean(d.previousDocumentId)) }))`,
  );
  check(
    after.count === assessmentCountBefore &&
      after.dates.includes('CA2 Group Project Report@2026-12-14'),
    `update applied without creating a duplicate (${after.count} deadlines)`,
  );

  const bytes = await evaluate(page, `chrome.storage.local.getBytesInUse(null)`);
  const docBytes = await evaluate(page, `chrome.storage.local.getBytesInUse('documents')`);
  log(
    `Storage used: ${(bytes / 1024).toFixed(1)} KB total, ${(docBytes / 1024).toFixed(1)} KB for ${after.docs.length} library records`,
  );

  // ---- Dashboard library and details ----
  const { client: dashboard } = await openPage(`${base}/dashboard/dashboard.html`);
  await evaluate(
    dashboard,
    `(async () => { document.querySelector('.nav-item[data-status=documents]').click(); await new Promise((r) => setTimeout(r, 300)); })()`,
  );
  log(
    'dashboard:',
    JSON.stringify(
      await evaluate(
        dashboard,
        `({ title: document.querySelector('.view-title')?.textContent, body: document.querySelector('.view-body')?.innerText.slice(0, 300) })`,
      ),
    ),
  );
  const library = await evaluate(
    dashboard,
    `[...document.querySelectorAll('.doc-card')].map((c) => c.querySelector('.doc-name').textContent + ' | ' + c.querySelector('.status-chip').textContent)`,
  );
  check(library.length >= 4, `library lists ${library.length} documents`);
  await shot(dashboard, '07-dashboard-library');
  await evaluate(
    dashboard,
    `(async () => { document.querySelector('.doc-card .doc-links .btn').click(); await new Promise((r) => setTimeout(r, 400)); const d = document.querySelector('dialog[open] details:has(.evidence-list)'); if (d) d.open = true; })()`,
  );
  await shot(dashboard, '08-details-with-evidence');
  const evidence = await evaluate(
    dashboard,
    `document.querySelectorAll('dialog[open] .evidence-list li').length`,
  );
  check(evidence > 0, `deadline details show ${evidence} evidence items`);

  // Manual deadline still works from the popup.
  const manual = await evaluate(
    popup,
    `(async () => { document.querySelector('.add-button').click(); document.querySelector('.quick-add input[name=title]').value = 'Manual after import'; document.querySelector('.quick-add input[name=dueDate]').value = '2026-12-20'; document.querySelector('.quick-add').requestSubmit(); await new Promise((r) => setTimeout(r, 400)); return chrome.storage.local.get('assessments').then((r) => r.assessments.some((a) => a.title === 'Manual after import' && a.sourceType === 'manual')); })()`,
  );
  check(manual, 'manual quick add still works');

  // Dark theme screenshot of the import page.
  await evaluate(
    page,
    `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, theme: 'dark' } }))`,
  );
  await clickReview(page, 'scanned.pdf');
  await shot(page, '09-import-dark');
  await shot(page, '10-import-narrow-dark', 420, 900);
  const overflow = await evaluate(page, `document.documentElement.scrollWidth > window.innerWidth`);
  check(!overflow, 'import page has no horizontal overflow at 420 px');

  const errors = [popup, page, dashboard]
    .flatMap((client) => client.events)
    .filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'),
    );
  check(errors.length === 0, `no console errors (${errors.length})`);
  if (errors.length) log(JSON.stringify(errors.slice(0, 3)).slice(0, 1500));
} catch (error) {
  failures += 1;
  log('ERROR', error.stack ?? String(error));
} finally {
  // Close the whole browser process tree, then remove the throwaway profile.
  browser.kill();
  if (process.platform === 'win32') {
    // Edge re-parents its helper processes, so stop every process using this profile.
    spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
    ]);
  }
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Windows may still hold a lock briefly; the folder is in the temp directory.
  }
  writeFileSync(join(OUT, 'report.txt'), `${report.join('\n')}\n`);
  log(failures ? `${failures} check(s) failed` : 'All checks passed');
  process.exitCode = failures ? 1 : 0;
}
