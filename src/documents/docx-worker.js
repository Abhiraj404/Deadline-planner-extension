/**
 * Module worker that reads one .docx file off the main thread.
 *
 * Mammoth (and its ZIP library) only ever load here, never in the popup or the
 * dashboard. The page can terminate this worker at any time, which is how
 * cancellation and the processing time limit are enforced.
 */

import mammoth from 'mammoth';
import { processDocxBuffer } from './docx-reader.js';

self.addEventListener('message', async (event) => {
  const { buffer, limits } = event.data;
  try {
    const content = await processDocxBuffer(buffer, { mammoth, limits });
    self.postMessage({ ok: true, content });
  } catch (error) {
    self.postMessage({
      ok: false,
      code: error?.code ?? 'unreadable',
      message: error?.code ? error.message : 'This Word file could not be read.',
    });
  }
});
