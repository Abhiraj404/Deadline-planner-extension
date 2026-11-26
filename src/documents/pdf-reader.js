/**
 * PDF text extraction with PDF.js.
 *
 * PDF.js returns text in small pieces ("items") with positions. To get readable lines
 * we group items whose baselines are at (almost) the same height, sort each line left
 * to right, and put a tab where there is a wide gap. The tab keeps table columns apart,
 * which lets "Submission date<TAB>4 December 2026" be read as label + value.
 *
 * The PDF.js library object is passed in (`pdfjs`) so this module works in the
 * extension (browser build, real worker) and in Node tests (legacy build).
 */

import { ImportError } from './file-checks.js';

/** Turn PDF.js text items into ordered lines. */
export function itemsToLines(items) {
  const pieces = items
    .filter(
      (item) =>
        typeof item.str === 'string' && item.str.trim() !== '' && Array.isArray(item.transform),
    )
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width ?? 0,
      size: Math.max(Math.abs(item.transform[3]) || Math.abs(item.height) || 10, 1),
    }));
  // Higher y is nearer the top of the page.
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const piece of pieces) {
    const line = lines.at(-1);
    if (line && Math.abs(line.y - piece.y) <= Math.min(line.size, piece.size) * 0.5)
      line.pieces.push(piece);
    else lines.push({ y: piece.y, size: piece.size, pieces: [piece] });
  }
  return lines.map((line) => {
    line.pieces.sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd = null;
    for (const piece of line.pieces) {
      if (previousEnd !== null) {
        const gap = piece.x - previousEnd;
        if (gap > line.size * 1.5) text += '\t';
        else if (gap > line.size * 0.15 && !text.endsWith(' ') && !piece.text.startsWith(' '))
          text += ' ';
      }
      text += piece.text;
      previousEnd = piece.x + piece.width;
    }
    return text.replace(/ {2,}/g, ' ').trim();
  });
}

function mapPdfError(error) {
  if (error instanceof ImportError) return error;
  if (error?.name === 'AbortException' || error?.name === 'AbortError') {
    return new ImportError('cancelled', 'Import cancelled.');
  }
  if (error?.name === 'PasswordException') {
    return new ImportError(
      'password',
      'This PDF is password-protected. Remove the password and import it again.',
    );
  }
  if (error?.name === 'InvalidPDFException') {
    return new ImportError('corrupted', 'This PDF is damaged or is not a valid PDF.');
  }
  return new ImportError('unreadable', 'This PDF could not be read.');
}

/**
 * @param {Uint8Array} bytes (PDF.js may take ownership of the buffer)
 * @param {object} options
 * @param {object} options.pdfjs the PDF.js module
 * @param {{ maxPdfPages: number, maxTextChars: number }} options.limits
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { page: number, pages: number }) => void} [options.onProgress]
 * @returns {Promise<object>} normalised document content
 */
export async function readPdf(bytes, { pdfjs, limits, signal, onProgress }) {
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    // Security and size: no eval, no scripting, no XFA forms, no font loading, and
    // nothing fetched from the network.
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  const abort = () => loadingTask.destroy();
  signal?.addEventListener('abort', abort, { once: true });

  let pdf;
  try {
    pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    const pagesToRead = Math.min(pageCount, limits.maxPdfPages);
    const blocks = [];
    const emptyPages = [];
    const warnings = [];
    let textLength = 0;
    let truncated = pageCount > pagesToRead;

    for (let number = 1; number <= pagesToRead; number += 1) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const lines = itemsToLines(content.items).filter(Boolean);
      page.cleanup();
      if (lines.length === 0) emptyPages.push(number);
      for (const text of lines) {
        if (textLength + text.length > limits.maxTextChars) {
          truncated = true;
          break;
        }
        textLength += text.length + 1;
        blocks.push({ text, kind: 'line', ref: { page: number }, location: `Page ${number}` });
      }
      onProgress?.({ page: number, pages: pagesToRead });
      if (textLength >= limits.maxTextChars) {
        truncated = true;
        break;
      }
    }

    // A PDF with pages but (almost) no text is most likely a scan or a photo.
    const scanned = pagesToRead > 0 && textLength < 20;
    if (scanned) {
      warnings.push(
        'This PDF has no readable text. It is probably scanned or made of images, so details cannot be extracted. You can still enter them yourself.',
      );
    } else if (emptyPages.length > 0) {
      warnings.push(
        `${emptyPages.length === 1 ? 'Page' : 'Pages'} ${emptyPages.join(', ')} ${emptyPages.length === 1 ? 'has' : 'have'} no readable text (possibly images). Nothing was read from ${emptyPages.length === 1 ? 'it' : 'them'}.`,
      );
    }
    if (pageCount > pagesToRead) {
      warnings.push(
        `Only the first ${pagesToRead} of ${pageCount} pages were read (import limit).`,
      );
    } else if (truncated) {
      warnings.push('The document is very long; only the first part of its text was read.');
    }
    return {
      sourceType: 'pdf',
      blocks,
      pageCount,
      paragraphCount: null,
      textLength,
      truncated,
      scanned,
      emptyPages,
      warnings,
    };
  } catch (error) {
    throw mapPdfError(signal?.aborted ? { name: 'AbortError' } : error);
  } finally {
    signal?.removeEventListener('abort', abort);
    // Releases the parsed document and its worker-side memory.
    await loadingTask.destroy().catch(() => {});
  }
}
