/**
 * The import pipeline for one file:
 *
 *   check basics → read bytes once → SHA-256 → (PDF.js | DOCX worker) → extraction
 *
 * Library loading and DOCX isolation are injected (`loadPdfjs`, `readDocx`), so the
 * same pipeline runs in the extension and in Node tests. Each file gets a time limit;
 * cancelling or timing out stops the PDF.js task or terminates the DOCX worker.
 * Nothing is saved here: the result goes to the review screen.
 */

import { extractAssessments } from '../extraction/engine.js';
import { readPdf } from './pdf-reader.js';
import { ImportError, checkFileBasics, inspectPdfStructure, sha256Hex } from './file-checks.js';

export const STAGES = Object.freeze({
  queued: 'Waiting',
  checking: 'Checking file',
  hashing: 'Fingerprinting',
  loading: 'Loading reader',
  reading: 'Reading text',
  extracting: 'Finding details',
  done: 'Ready to review',
});

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.loadPdfjs
 * @param {(buffer: ArrayBuffer, options: object) => Promise<object>} deps.readDocx
 */
export function createImportPipeline({ loadPdfjs, readDocx, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  /**
   * @param {File|Blob & {name: string}} file
   * @param {object} options
   * @param {object} options.limits settings.importLimits
   * @param {string} options.timeZone
   * @param {string} options.referenceDate YYYY-MM-DD (for year suggestions only)
   * @param {AbortSignal} [options.signal]
   * @param {(stage: string, detail?: object) => void} [options.onStage]
   */
  async function processFile(
    file,
    { limits, timeZone, referenceDate, signal, onStage = () => {} },
  ) {
    const started = performance.now();
    const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean);
    const combined = AbortSignal.any(signals);
    const guard = () => {
      if (!combined.aborted) return;
      if (signal?.aborted) throw new ImportError('cancelled', 'Import cancelled.');
      throw new ImportError('timeout', 'Reading this file took too long and was stopped.');
    };

    onStage('checking');
    const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const { sourceType } = checkFileBasics(file, header, limits);
    guard();

    // The only full copy of the file in memory. PDF.js and the DOCX worker take
    // ownership of it afterwards, so it is not copied again.
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    onStage('hashing');
    const hash = await sha256Hex(bytes);
    guard();

    const warnings = [];
    let content;
    try {
      if (sourceType === 'pdf') {
        warnings.push(...inspectPdfStructure(bytes).warnings);
        onStage('loading');
        const pdfjs = await loadPdfjs();
        guard();
        onStage('reading', { page: 0, pages: null });
        content = await readPdf(bytes, {
          pdfjs,
          limits,
          signal: combined,
          onProgress: (progress) => onStage('reading', progress),
        });
      } else {
        onStage('reading', { page: null, pages: null });
        content = await readDocx(buffer, { limits, signal: combined });
      }
    } catch (error) {
      if (error?.code === 'cancelled' && !signal?.aborted) {
        throw new ImportError('timeout', 'Reading this file took too long and was stopped.');
      }
      throw error;
    }
    guard();

    onStage('extracting');
    const extraction = content.scanned
      ? extractAssessments('', { referenceDate, timeZone })
      : extractAssessments(content, { referenceDate, timeZone });
    const durationMs = Math.round(performance.now() - started);
    onStage('done');

    return {
      hash,
      fileName: file.name,
      size: file.size,
      sourceType,
      extraction,
      warnings: [...warnings, ...content.warnings],
      stats: {
        pageCount: content.pageCount,
        paragraphCount: content.paragraphCount,
        textLength: content.textLength,
        truncated: content.truncated,
        scanned: content.scanned,
        emptyPages: content.emptyPages,
        durationMs,
      },
    };
  }

  return { processFile };
}

/**
 * Run `task` over `items` with at most `limit` running at once. Results keep the
 * input order. Used to process a batch without starting every file at once.
 */
export async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
