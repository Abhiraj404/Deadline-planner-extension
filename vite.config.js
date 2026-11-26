import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src/', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/', import.meta.url));
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

// Each extension page and the service worker is a separate entry point, so every
// page loads only the code it needs. Shared modules become hashed chunks in assets/.
export default defineConfig(({ mode }) => ({
  root: src,
  publicDir,
  base: '/',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'chrome123',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    // The preload polyfill injects inline code that extension CSP would block.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: `${src}popup/popup.html`,
        dashboard: `${src}dashboard/dashboard.html`,
        'service-worker': `${src}background/service-worker.js`,
      },
      output: {
        // manifest.json points at a fixed service worker path, so it must not be hashed.
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker'
            ? 'background/service-worker.js'
            : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
