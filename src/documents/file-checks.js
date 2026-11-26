/**
 * Safety checks that run *before* any document parser sees a file.
 *
 * Every imported file is untrusted. These checks are cheap and need no library:
 *   1. extension and MIME type are allowed and agree with each other,
 *   2. the size is within the configured limit,
 *   3. the first bytes are a real PDF or ZIP (DOCX) signature,
 *   4. the structure looks sane: a PDF has an end-of-file marker; a DOCX is a ZIP with
 *      the required Word parts, no macros, no encryption and a bounded expanded size.
 *
 * `checkZipExpansion` then really inflates each DOCX part while counting bytes, so a
 * "zip bomb" (a tiny file that expands to gigabytes) is stopped early even if its
 * headers lie. It runs inside the DOCX worker so it can be cancelled.
 */

export class ImportError extends Error {
  /**
   * @param {string} code machine-readable reason (e.g. 'too-large', 'password')
   * @param {string} message plain-language explanation for the user
   */
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const MB = 1024 * 1024;
const PDF_MIME = ['application/pdf', 'application/x-pdf'];
const DOCX_MIME = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
// Browsers and operating systems sometimes report a generic type; that is allowed.
const GENERIC_MIME = [
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
];

const REFUSED_EXTENSIONS = {
  doc: 'Old Word (.doc) files are not supported. Save the file as .docx and import it again.',
  docm: 'Macro-enabled Word files (.docm) are not supported.',
  dotm: 'Macro-enabled Word templates are not supported.',
  dot: 'Word templates are not supported.',
  dotx: 'Word templates are not supported. Save the file as .docx.',
  rtf: 'RTF files are not supported. Save the file as .docx or PDF.',
  odt: 'OpenDocument files are not supported. Save the file as .docx or PDF.',
};

export function fileExtension(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : '';
}

function startsWith(bytes, signature, offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy Office / encrypted OOXML

/**
 * Checks that need only the file's name, size, type and first bytes.
 * @param {{ name: string, size: number, type?: string }} file
 * @param {Uint8Array} header at least the first 1024 bytes (or the whole file if smaller)
 * @param {{ maxFileSizeMB: number }} limits
 * @returns {{ sourceType: 'pdf'|'docx', warnings: string[] }}
 * @throws {ImportError}
 */
export function checkFileBasics(file, header, limits) {
  const extension = fileExtension(file?.name);
  if (REFUSED_EXTENSIONS[extension])
    throw new ImportError('unsupported', REFUSED_EXTENSIONS[extension]);
  if (extension !== 'pdf' && extension !== 'docx') {
    throw new ImportError('unsupported', 'Only PDF (.pdf) and Word (.docx) files can be imported.');
  }
  const type = String(file.type ?? '').toLowerCase();
  const allowedTypes = extension === 'pdf' ? PDF_MIME : DOCX_MIME;
  if (!allowedTypes.includes(type) && !GENERIC_MIME.includes(type)) {
    throw new ImportError(
      'type-mismatch',
      `This file says it is “${type}”, not a ${extension.toUpperCase()} document.`,
    );
  }
  if (!Number.isFinite(file.size) || file.size <= 0)
    throw new ImportError('empty', 'This file is empty.');
  if (file.size > limits.maxFileSizeMB * MB) {
    throw new ImportError(
      'too-large',
      `This file is larger than the ${limits.maxFileSizeMB} MB import limit.`,
    );
  }

  const bytes = header ?? new Uint8Array();
  if (extension === 'pdf') {
    // The PDF header may follow a little junk; readers accept it within 1 KB.
    const window = bytes.subarray(0, 1024);
    let found = false;
    for (let i = 0; i + PDF_MAGIC.length <= window.length && !found; i += 1)
      found = startsWith(window, PDF_MAGIC, i);
    if (!found) throw new ImportError('bad-signature', 'This does not look like a real PDF file.');
    return { sourceType: 'pdf', warnings: [] };
  }
  if (startsWith(bytes, OLE_MAGIC)) {
    throw new ImportError(
      'password',
      'This Word file is password-protected (or is an old .doc file renamed to .docx). Remove the password and import it again.',
    );
  }
  if (!startsWith(bytes, ZIP_MAGIC))
    throw new ImportError('bad-signature', 'This does not look like a real Word (.docx) file.');
  return { sourceType: 'docx', warnings: [] };
}

// ------------------------------------------------------------------ PDF structure

const ACTIVE_PDF_CONTENT =
  /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm|ImportData)\b/;

/**
 * Quick structural look at a PDF's raw bytes. Never throws for oddities that PDF.js
 * can still recover from; they become warnings instead.
 */
export function inspectPdfStructure(bytes) {
  const warnings = [];
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes('%%EOF')) {
    warnings.push('The PDF looks incomplete (no end-of-file marker). Some text may be missing.');
  }
  // Scan at most the first 8 MB for markers of active content. It is never run:
  // PDF.js is used with scripting off. The warning just tells the user.
  const scan = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8 * MB)));
  if (ACTIVE_PDF_CONTENT.test(scan)) {
    warnings.push(
      'This PDF contains active content (scripts, attachments or forms). It was ignored and never run.',
    );
  }
  return { warnings };
}

// ------------------------------------------------------------------ ZIP structure

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
    bytes[offset + 3] * 0x1000000
  );
}

const MAX_ZIP_ENTRIES = 2000;
const MAX_ENTRY_RATIO = 200;

/**
 * Read a ZIP's central directory (no decompression) and check it is a sensible,
 * macro-free Word document.
 * @returns {{ entries: object[], warnings: string[], expandedBytes: number }}
 * @throws {ImportError}
 */
export function inspectZip(bytes, limits) {
  const corrupted = () =>
    new ImportError('corrupted', 'This Word file is damaged and cannot be read.');
  // The end-of-central-directory record is in the last 22 bytes plus an optional comment.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
    if (readUint32(bytes, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw corrupted();
  const count = readUint16(bytes, end + 10);
  const directorySize = readUint32(bytes, end + 12);
  const directoryOffset = readUint32(bytes, end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new ImportError(
      'too-large',
      'This Word file uses a format extension (ZIP64) meant for very large files.',
    );
  }
  if (count > MAX_ZIP_ENTRIES)
    throw new ImportError(
      'archive-bomb',
      'This Word file contains too many parts to be safe to open.',
    );
  if (directoryOffset + directorySize > end) throw corrupted();

  const maxExpanded = limits.maxDocxExpandedMB * MB;
  const entries = [];
  let expandedBytes = 0;
  let offset = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > end || readUint32(bytes, offset) !== 0x02014b50) throw corrupted();
    const flags = readUint16(bytes, offset + 8);
    const method = readUint16(bytes, offset + 10);
    const compressedSize = readUint32(bytes, offset + 20);
    const size = readUint32(bytes, offset + 24);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const localOffset = readUint32(bytes, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 1)
      throw new ImportError(
        'password',
        'This Word file is encrypted. Remove the password and import it again.',
      );
    if (method !== 0 && method !== 8)
      throw new ImportError('corrupted', 'This Word file uses an unsupported compression method.');
    if (localOffset >= directoryOffset) throw corrupted();
    expandedBytes += size;
    if (expandedBytes > maxExpanded) {
      throw new ImportError(
        'archive-bomb',
        `This Word file expands to more than ${limits.maxDocxExpandedMB} MB, which is not safe to open.`,
      );
    }
    if (size > MB && compressedSize > 0 && size / compressedSize > MAX_ENTRY_RATIO) {
      throw new ImportError(
        'archive-bomb',
        'This Word file is compressed in a suspicious way (possible archive bomb).',
      );
    }
    entries.push({ name, method, compressedSize, size, localOffset });
  }

  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    throw new ImportError('corrupted', 'This is a ZIP file but not a Word document.');
  }
  if ([...names].some((name) => /vbaProject\.bin$|vbaData\.xml$/i.test(name))) {
    throw new ImportError(
      'macro',
      'This Word file contains macros. Macro-enabled documents are not imported.',
    );
  }
  const warnings = [];
  if (
    [...names].some(
      (name) => name.startsWith('word/embeddings/') || name.startsWith('word/activeX/'),
    )
  ) {
    warnings.push('Embedded objects in this document were ignored and never opened.');
  }
  return { entries, warnings, expandedBytes };
}

/**
 * Inflate every compressed part while counting output bytes, stopping as soon as a
 * part grows beyond its declared size or the total passes the limit. Uses the
 * built-in DecompressionStream, so no library is needed.
 * @throws {ImportError}
 */
export async function checkZipExpansion(bytes, entries, limits, signal) {
  const maxTotal = limits.maxDocxExpandedMB * MB;
  let total = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const local = entry.localOffset;
    if (readUint32(bytes, local) !== 0x04034b50)
      throw new ImportError('corrupted', 'This Word file is damaged.');
    const start = local + 30 + readUint16(bytes, local + 26) + readUint16(bytes, local + 28);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) {
      total += data.length;
    } else {
      const reader = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
        .getReader();
      let produced = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          produced += value.length;
          if (produced > entry.size || total + produced > maxTotal) {
            await reader.cancel();
            throw new ImportError(
              'archive-bomb',
              'This Word file expands far beyond its declared size (possible archive bomb).',
            );
          }
        }
      } catch (error) {
        if (error instanceof ImportError) throw error;
        throw new ImportError('corrupted', 'This Word file is damaged and cannot be read.');
      }
      total += produced;
    }
    if (total > maxTotal) {
      throw new ImportError(
        'archive-bomb',
        `This Word file expands to more than ${limits.maxDocxExpandedMB} MB.`,
      );
    }
  }
  return total;
}

/** SHA-256 of the file contents as lowercase hex (Web Crypto). */
export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
