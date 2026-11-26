/**
 * DOCX text extraction with Mammoth.js.
 *
 * Mammoth normally converts Word to HTML. We never use that HTML. Instead we walk
 * Mammoth's parsed document tree (via its `transformDocument` hook) and produce plain
 * text blocks that remember their structure: headings, paragraphs, list items and
 * table rows (cells joined with a tab). Images are never read or decoded, and
 * external resources are never fetched.
 *
 * The Mammoth module is passed in (`mammoth`) so this works in the DOCX worker and in
 * Node tests.
 */

import { ImportError, checkZipExpansion, inspectZip } from './file-checks.js';

function collectText(node, parts) {
  if (!node) return;
  switch (node.type) {
    case 'text':
      parts.push(node.value);
      return;
    case 'tab':
      parts.push('\t');
      return;
    case 'break':
      parts.push('\n');
      return;
    case 'image':
      return; // never decode images
    default:
      for (const child of node.children ?? []) collectText(child, parts);
  }
}

const textOf = (node) => {
  const parts = [];
  collectText(node, parts);
  return parts
    .join('')
    .replace(/[ \u00a0]+/g, ' ')
    .trim();
};

/** Convert Mammoth's document tree into normalised blocks. */
export function documentToBlocks(root, maxTextChars) {
  const blocks = [];
  let paragraph = 0;
  let table = 0;
  let section = null;
  let textLength = 0;
  let truncated = false;

  const push = (block) => {
    if (truncated || !block.text) return;
    if (textLength + block.text.length > maxTextChars) {
      truncated = true;
      return;
    }
    textLength += block.text.length + 1;
    blocks.push(block);
  };
  const where = (label) => (section ? `${label} · ${section}` : label);

  const visit = (node) => {
    if (truncated) return;
    if (node.type === 'paragraph') {
      paragraph += 1;
      const text = textOf(node);
      if (!text) return;
      const isHeading = /^(heading|title|subtitle)/i.test(node.styleName ?? '');
      if (isHeading) section = text.slice(0, 60);
      push({
        text,
        kind: isHeading ? 'heading' : node.numbering ? 'listItem' : 'paragraph',
        ref: { paragraph },
        location: isHeading ? `Paragraph ${paragraph}` : where(`Paragraph ${paragraph}`),
      });
      return;
    }
    if (node.type === 'table') {
      table += 1;
      let row = 0;
      for (const tableRow of node.children ?? []) {
        if (tableRow.type !== 'tableRow') continue;
        row += 1;
        const cells = (tableRow.children ?? []).map((cell) => textOf(cell).replace(/\n+/g, ' '));
        push({
          text: cells.join('\t').trim(),
          kind: 'tableRow',
          ref: { table, row },
          location: where(`Table ${table}, row ${row}`),
        });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return { blocks, paragraphCount: paragraph, textLength, truncated };
}

/**
 * @param {ArrayBuffer} buffer the .docx file
 * @param {{ mammoth: object, limits: { maxTextChars: number } }} options
 */
export async function readDocx(buffer, { mammoth, limits }) {
  let result = null;
  try {
    await mammoth.convertToHtml(
      // `arrayBuffer` is what the browser build reads; `buffer` is the Node build's name.
      { arrayBuffer: buffer, buffer },
      {
        includeDefaultStyleMap: true,
        ignoreEmptyParagraphs: true,
        // Replace every image with an empty element without reading its bytes.
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
        transformDocument(root) {
          result = documentToBlocks(root, limits.maxTextChars);
          return root;
        },
      },
    );
  } catch {
    throw new ImportError(
      'corrupted',
      'This Word file is damaged or is not a valid .docx document.',
    );
  }
  if (!result) throw new ImportError('unreadable', 'This Word file could not be read.');

  const warnings = [];
  if (result.textLength < 20) {
    warnings.push('This Word document contains almost no text (it may only contain images).');
  }
  if (result.truncated)
    warnings.push('The document is very long; only the first part of its text was read.');
  return {
    sourceType: 'docx',
    blocks: result.blocks,
    pageCount: null,
    paragraphCount: result.paragraphCount,
    textLength: result.textLength,
    truncated: result.truncated,
    scanned: result.textLength < 20,
    emptyPages: [],
    warnings,
  };
}

/**
 * The full DOCX path: structure checks, a bounded test inflation (archive-bomb guard),
 * then Mammoth. Runs inside the DOCX worker in the extension.
 */
export async function processDocxBuffer(buffer, { mammoth, limits, signal }) {
  const bytes = new Uint8Array(buffer);
  const { entries, warnings } = inspectZip(bytes, limits);
  await checkZipExpansion(bytes, entries, limits, signal);
  signal?.throwIfAborted();
  const content = await readDocx(buffer, { mammoth, limits });
  content.warnings.unshift(...warnings);
  return content;
}
