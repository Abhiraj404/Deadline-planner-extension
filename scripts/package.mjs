/**
 * Builds the release ZIP from dist/: release/deadline-reminder-v<version>.zip plus a
 * .sha256 checksum. Only the files needed to load the unpacked extension are included
 * (no source maps, no node_modules, nothing from outside dist/).
 *
 *   npm run build && npm run package
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './lib/synthetic-documents.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: package.json ${pkg.version}, manifest.json ${manifest.version}`);
  process.exit(1);
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const folder = `deadline-reminder-v${pkg.version}`;
const files = walk(dist)
  .filter((path) => !path.endsWith('.map'))
  .sort();
const entries = files.map((path) => ({
  // Everything inside one folder, so "extract, then Load unpacked on that folder" works.
  name: `${folder}/${relative(dist, path).split(sep).join('/')}`,
  data: readFileSync(path),
}));
entries.push({ name: `${folder}/LICENSE`, data: readFileSync(join(root, 'LICENSE')) });

mkdirSync(join(root, 'release'), { recursive: true });
const zip = Buffer.from(buildZip(entries));
const zipPath = join(root, 'release', `${folder}.zip`);
writeFileSync(zipPath, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha}  ${folder}.zip\n`);
console.log(
  `${relative(root, zipPath)}  ${(zip.length / 1024).toFixed(1)} KB  ${entries.length} files`,
);
console.log(`sha256 ${sha}`);
