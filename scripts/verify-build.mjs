/**
 * Post-build checks for dist/:
 *  - every file referenced by manifest.json exists,
 *  - every script/stylesheet referenced by the HTML pages exists,
 *  - no inline scripts (blocked by the extension CSP),
 *  - no remote code, eval or new Function in the bundle,
 *  - only the expected permissions are requested.
 * Prints the size of the build. Exits non-zero on any problem.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const problems = [];
const expectedPermissions = ['alarms', 'notifications', 'storage'];

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const referenced = new Set([
  manifest.action?.default_popup,
  manifest.options_page,
  manifest.background?.service_worker,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
]);
for (const file of referenced) {
  if (file && !existsSync(join(dist, file)))
    problems.push(`manifest references missing file: ${file}`);
}

const permissions = [...(manifest.permissions ?? [])].sort();
if (JSON.stringify(permissions) !== JSON.stringify(expectedPermissions)) {
  problems.push(`unexpected permissions: ${permissions.join(', ')}`);
}
for (const key of [
  'host_permissions',
  'optional_permissions',
  'content_scripts',
  'web_accessible_resources',
]) {
  if (manifest[key]) problems.push(`manifest should not declare ${key} in Stage 1`);
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(dist);
for (const file of files.filter((path) => path.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const tag = match[0];
    const src = /\s(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if (match[1] === 'script' && !src)
      problems.push(`${relative(dist, file)}: inline <script> is not allowed`);
    if (!src) continue;
    if (/^(https?:)?\/\//.test(src)) {
      problems.push(`${relative(dist, file)}: remote resource ${src}`);
      continue;
    }
    const target = src.startsWith('/') ? join(dist, src) : resolve(dirname(file), src);
    if (!existsSync(target)) problems.push(`${relative(dist, file)}: missing ${src}`);
  }
}

for (const file of files.filter((path) => path.endsWith('.js'))) {
  const code = readFileSync(file, 'utf8');
  if (/\beval\s*\(|new Function\s*\(/.test(code))
    problems.push(`${relative(dist, file)}: dynamic code execution`);
  if (/import\s*\(\s*["']https?:/.test(code))
    problems.push(`${relative(dist, file)}: remote import`);
  if (/\.innerHTML\s*=/.test(code)) problems.push(`${relative(dist, file)}: innerHTML assignment`);
}

let total = 0;
const rows = files.map((file) => {
  const size = statSync(file).size;
  total += size;
  return [relative(dist, file).replaceAll('\\', '/'), size];
});
rows.sort((a, b) => a[0].localeCompare(b[0]));
for (const [name, size] of rows) console.log(`${(size / 1024).toFixed(1).padStart(8)} KB  ${name}`);
console.log(`${(total / 1024).toFixed(1).padStart(8)} KB  total (${files.length} files)`);

if (problems.length) {
  console.error(`\nBuild verification failed:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('\nBuild verification passed.');
