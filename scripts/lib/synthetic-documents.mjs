/**
 * Builds small synthetic PDF and DOCX files for tests, measurements and the browser
 * smoke test. Nothing here comes from a real assessment brief.
 *
 * Node only (uses node:zlib and node:crypto). The output is real, valid files:
 * PDFs open in any viewer and DOCX files open in Word.
 */

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------- PDF

const PDF_PADDING = Buffer.from(
  '28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A',
  'hex',
);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
const padPassword = (password) =>
  Buffer.concat([Buffer.from(password, 'latin1'), PDF_PADDING]).subarray(0, 32);

/** Standard security handler, revision 2 (40-bit RC4). Enough to need a password. */
function createEncryption(userPassword, fileId) {
  const ownerKey = md5(padPassword(`${userPassword}-owner`)).subarray(0, 5);
  const owner = rc4(ownerKey, padPassword(userPassword));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-44);
  const key = md5(padPassword(userPassword), owner, permissions, fileId).subarray(0, 5);
  const user = rc4(key, PDF_PADDING);
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -44 >>`,
    encrypt(objectNumber, data) {
      const id = Buffer.from([
        objectNumber & 255,
        (objectNumber >> 8) & 255,
        (objectNumber >> 16) & 255,
        0,
        0,
      ]);
      return rc4(md5(key, id).subarray(0, 10), data);
    },
  };
}

function pdfString(text) {
  const latin = Buffer.from(String(text).replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), 'latin1');
  return `(${latin.toString('latin1').replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

const COLUMN_X = [50, 230, 380, 480];

/**
 * @param {Array<Array<string|string[]>|{lines?: Array, image?: boolean}>} pages
 *   Each page is a list of lines. A line given as an array is drawn as table cells.
 *   `{ image: true }` draws an image and no text (a "scanned" page).
 * @param {{ password?: string }} [options]
 */
export function buildPdf(pages, { password } = {}) {
  const fileId = createHash('md5').update(JSON.stringify(pages)).digest();
  const encryption = password ? createEncryption(password, fileId) : null;
  const objects = []; // index + 1 = object number
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (number, dictionary, data) => {
    const bytes = encryption ? encryption.encrypt(number, data) : data;
    return Buffer.concat([
      Buffer.from(`${dictionary.replace('>>', ` /Length ${bytes.length} >>`)}\nstream\n`, 'latin1'),
      bytes,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  };

  add(null); // 1: catalog, filled in later
  add(null); // 2: page tree
  const font = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const pageNumbers = [];

  for (const page of pages) {
    const spec = Array.isArray(page) ? { lines: page } : page;
    let content = '';
    let resources = `/Font << /F1 ${font} 0 R >>`;
    if (spec.image) {
      const imageNumber = objects.length + 1;
      const pixels = Buffer.alloc(64 * 64, 0);
      for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) % 255;
      add(
        stream(
          imageNumber,
          '<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 >>',
          pixels,
        ),
      );
      resources += ` /XObject << /Im1 ${imageNumber} 0 R >>`;
      content += 'q 495 0 0 700 50 80 cm /Im1 Do Q\n';
    }
    let y = 800;
    for (const line of spec.lines ?? []) {
      const cells = Array.isArray(line) ? line : [line];
      cells.forEach((cell, index) => {
        if (cell !== '')
          content += `BT /F1 11 Tf ${COLUMN_X[index] ?? 50 + index * 120} ${y} Td ${pdfString(cell)} Tj ET\n`;
      });
      y -= 16;
    }
    const contentNumber = objects.length + 1;
    add(stream(contentNumber, '<< >>', Buffer.from(content, 'latin1')));
    pageNumbers.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << ${resources} >> /Contents ${contentNumber} 0 R >>`,
      ),
    );
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNumbers.length} >>`;
  const encryptNumber = encryption ? add(encryption.dictionary) : null;

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(offset);
    offset += bytes.length;
    chunks.push(bytes);
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R${encryptNumber ? ` /Encrypt ${encryptNumber} 0 R` : ''} /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>] >>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Split a list of lines into pages of `perPage` lines. */
export function paginate(lines, perPage = 45) {
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages.length ? pages : [[]];
}

// ---------------------------------------------------------------- ZIP / DOCX

/**
 * Minimal ZIP writer. `entries` is a list of { name, data, store? }.
 * `declaredSize` lets a test lie about the uncompressed size (archive-bomb checks).
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = entry.store ? data : deflateRawSync(data);
    const method = entry.store ? 0 : 8;
    const crc = crc32(data);
    const size = entry.declaredSize ?? data.length;
    const flags = entry.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuffer, end]));
}

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );
const run = (text) => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const paragraph = (text, properties = '') =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${run(text)}</w:p>`;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

/**
 * @param {Array<{type:'heading',text:string,level?:number}|{type:'paragraph',text:string}|
 *   {type:'list',items:string[],ordered?:boolean}|{type:'table',rows:string[][]}|string>} blocks
 * @param {{ extraEntries?: Array, documentXml?: string|Buffer, macro?: boolean }} [options]
 */
export function buildDocx(blocks, { extraEntries = [], documentXml, macro = false } = {}) {
  const body = blocks
    .map((block) => {
      if (typeof block === 'string') return paragraph(block);
      if (block.type === 'heading')
        return paragraph(block.text, `<w:pStyle w:val="Heading${block.level ?? 1}"/>`);
      if (block.type === 'list') {
        const numId = block.ordered ? 2 : 1;
        return block.items
          .map((item) =>
            paragraph(
              item,
              `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`,
            ),
          )
          .join('');
      }
      if (block.type === 'table') {
        const rows = block.rows
          .map(
            (cells) =>
              `<w:tr>${cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`,
          )
          .join('');
        return `<w:tbl>${rows}</w:tbl>`;
      }
      return paragraph(block.text);
    })
    .join('');
  const document =
    documentXml ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`,
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    ...(macro ? [{ name: 'word/vbaProject.bin', data: Buffer.from('fake macro project') }] : []),
    ...extraEntries,
  ]);
}

// ---------------------------------------------------------------- sample briefs

/** The text lines of a clear, typical brief (used for both PDF and DOCX). */
export const SAMPLE_BRIEF_LINES = [
  'Module: COMP3010 Software Engineering',
  'Assessment Title: CA2 Group Project Report',
  'Assessment type: Group project',
  'Weighting: 40%',
  'Issue date: 6 October 2026',
  'Submission deadline: Friday 11 December 2026 at 17:00',
  'Submit via Moodle as a single PDF.',
  'Presentations will take place on 15/12/2026. Each presentation lasts 10 minutes.',
  'Work in groups of 3 to 4 students.',
  'Feedback will be returned by 22 January 2027.',
  'Word count: 2,000 - 2,500 words',
  '',
  'Deliverables:',
  '- Project report (PDF)',
  '- Source code repository link',
  '',
  'Marking criteria:',
  '1. Requirements analysis 20%',
  '2. Design 30%',
  'Important: Submit through Moodle only.',
];
