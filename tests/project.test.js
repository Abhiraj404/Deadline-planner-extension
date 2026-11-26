/**
 * Project-level guarantees that are easy to break by accident.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

function sourceFiles(directory) {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory() ? sourceFiles(path) : [path];
  });
}

const jsFiles = sourceFiles('src').filter((path) => path.endsWith('.js'));

describe('manifest', () => {
  const manifest = JSON.parse(read('public/manifest.json'));

  it('is Manifest V3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({
      service_worker: 'background/service-worker.js',
      type: 'module',
    });
  });

  it('requests only storage, alarms and notifications, with no host access', () => {
    expect([...manifest.permissions].sort()).toEqual(['alarms', 'notifications', 'storage']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.permissions).not.toContain('unlimitedStorage');
  });

  it('keeps a strict extension-page CSP', () => {
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'",
    );
  });
});

describe('dependencies', () => {
  it('ships only the two document libraries as production dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['mammoth', 'pdfjs-dist']);
  });

  it('imports PDF.js and Mammoth only from the lazy loaders and the DOCX worker', () => {
    // Everything else (popup, dashboard, manual forms) must never pull them in.
    const allowed = ['src/documents/loaders.js', 'src/documents/docx-worker.js'];
    for (const file of jsFiles) {
      const code = read(file);
      const imports = [...code.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      );
      const usesParser = imports.some((name) => /^(pdfjs-dist|mammoth)/.test(name));
      expect(usesParser && !allowed.includes(file.replaceAll('\\', '/')), file).toBe(false);
    }
  });
});

describe('safe rendering', () => {
  it('never uses innerHTML, outerHTML, insertAdjacentHTML, document.write or eval', () => {
    for (const file of jsFiles) {
      const code = read(file);
      expect(code, file).not.toMatch(
        /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/,
      );
    }
  });

  it('loads no remote scripts, styles or fonts', () => {
    for (const file of [
      ...jsFiles,
      ...sourceFiles('src').filter((path) => /\.(css|html)$/.test(path)),
    ]) {
      expect(read(file), file).not.toMatch(
        /(src|href)=["']https?:|@import\s+url\(["']?https?:|fonts\.googleapis/,
      );
    }
  });
});
