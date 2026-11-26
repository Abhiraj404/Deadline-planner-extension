/**
 * Minimal helpers for driving a headless Chromium browser over the Chrome DevTools
 * Protocol (no extra dependencies). Used by the optional smoke tests.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findBrowser() {
  return [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => path && existsSync(path));
}

/** Launch the browser with an unpacked extension and a throwaway profile. */
export async function launch({ extensionDir, port }) {
  const executable = findBrowser();
  if (!executable) throw new Error('No Chromium browser found. Set BROWSER_PATH.');
  const profile = join(tmpdir(), `deadline-reminder-smoke-${process.pid}-${port}`);
  mkdirSync(profile, { recursive: true });
  const child = spawn(executable, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  const json = async (path, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  let worker = null;
  for (let i = 0; i < 60 && !worker; i += 1) {
    await sleep(500);
    try {
      worker = (await json('/json/list')).find(
        (target) =>
          target.type === 'service_worker' && target.url.endsWith('/background/service-worker.js'),
      );
    } catch {
      // DevTools endpoint not ready yet.
    }
  }
  if (!worker) {
    await close();
    throw new Error('The extension did not load.');
  }
  async function close() {
    child.kill();
    if (process.platform === 'win32') {
      // Edge re-parents its helper processes, so stop every process using this profile.
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
      ]);
    }
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // Windows may hold a lock briefly; the folder is in the temp directory.
    }
  }
  return {
    executable,
    json,
    close,
    worker,
    extensionId: new URL(worker.url).host,
  };
}

export function connect(url) {
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
  return { ready, send, events, close: () => socket.close() };
}

export async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  }
  return result.result.value;
}

/** Open an extension page in a new tab and wait until the app has rendered. */
export async function openPage(browser, url, { scheme = 'light' } = {}) {
  const target = await browser.json(`/json/new?${url}`, 'PUT');
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(
      client,
      `document.readyState === 'complete' && Boolean(document.getElementById('app')) && !document.getElementById('app').hasAttribute('aria-busy')`,
    ).catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  return { client, target };
}

export async function screenshot(client, file, { width = 1280, height = 900, scale = 1 } = {}) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  await sleep(350);
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

export function consoleErrors(clients) {
  return clients
    .flatMap((client) => client.events)
    .filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'),
    );
}
