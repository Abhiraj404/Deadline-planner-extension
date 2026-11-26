/**
 * Browser-only loaders for the document libraries. Both are loaded lazily, on first
 * use, from the import page; the popup and the dashboard never load them.
 */

import { ImportError } from './file-checks.js';

let pdfjsPromise = null;

/** Load PDF.js and point it at its bundled worker (an extension file, never a CDN). */
export function loadPdfjs() {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist/build/pdf.min.mjs'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * Read a .docx in a dedicated worker. The buffer is transferred, not copied.
 * Aborting the signal terminates the worker immediately.
 */
export function readDocxInWorker(buffer, { limits, signal }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./docx-worker.js', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(
        signal.reason?.name === 'TimeoutError'
          ? new ImportError('timeout', 'Reading this Word file took too long and was stopped.')
          : new ImportError('cancelled', 'Import cancelled.'),
      );
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('message', (event) => {
      finish();
      if (event.data.ok) resolve(event.data.content);
      else reject(new ImportError(event.data.code, event.data.message));
    });
    worker.addEventListener('error', () => {
      finish();
      reject(new ImportError('unreadable', 'This Word file could not be read.'));
    });
    worker.postMessage({ buffer, limits }, [buffer]);
  });
}
