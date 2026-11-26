/**
 * Writes public/THIRD_PARTY_NOTICES.txt with the licence text of every production
 * dependency that can end up in the extension bundle (PDF.js, Mammoth and the packages
 * Mammoth uses). The file ships inside dist/ and the release ZIP, which keeps the
 * Apache-2.0, BSD and MIT notice requirements.
 *
 *   npm run notices
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tree = JSON.parse(
  execSync('npm ls --omit=dev --all --json', { cwd: root, encoding: 'utf8' }),
);

const packages = new Map();
(function walk(dependencies = {}) {
  for (const [name, info] of Object.entries(dependencies)) {
    // Native canvas bindings are an optional Node-only PDF.js dependency; never bundled.
    if (name.startsWith('@napi-rs/')) continue;
    if (!packages.has(name)) packages.set(name, info.version);
    walk(info.dependencies);
  }
})(tree.dependencies);

const sections = [...packages.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, version]) => {
    const directory = join(root, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const licenseFile = existsSync(directory)
      ? readdirSync(directory).find((file) => /^(licen[sc]e|copying)(\.|$)/i.test(file))
      : null;
    const text = licenseFile
      ? readFileSync(join(directory, licenseFile), 'utf8').trim()
      : `Licence: ${manifest.license ?? 'see package'} (no licence file in the package)`;
    return `${'='.repeat(78)}\n${name} ${version} (${manifest.license ?? 'unknown'})\n${manifest.homepage ?? manifest.repository?.url ?? ''}\n${'='.repeat(78)}\n\n${text}\n`;
  });

const header = `Deadline Reminder includes the following third-party software.
Deadline Reminder itself is licensed under the MIT licence (see LICENSE).

`;
writeFileSync(join(root, 'public', 'THIRD_PARTY_NOTICES.txt'), header + sections.join('\n'));
console.log(`Wrote notices for ${packages.size} packages: ${[...packages.keys()].join(', ')}`);
