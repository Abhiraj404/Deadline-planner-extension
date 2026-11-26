/**
 * Generates the extension icons (public/icons/icon-{16,32,48,128}.png) with no
 * dependencies: shapes are described as signed distance functions, rendered with
 * 4×4 supersampling, and written as PNG using Node's built-in zlib.
 *
 * Run with `npm run icons`. The PNGs are committed, so this is only needed when the
 * design changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));
const ACCENT = [90, 77, 230];
const WHITE = [255, 255, 255];

function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function segment(x, y, ax, ay, bx, by) {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t);
}

/** Distance to the white glyph, in a 128-unit design space. */
function glyph(x, y, simple) {
  if (simple) {
    // Small sizes: a bold check mark only, so it stays legible at 16 px.
    return Math.min(segment(x, y, 34, 66, 56, 88), segment(x, y, 56, 88, 96, 44)) - 9;
  }
  const frame = Math.abs(roundedRect(x, y, 64, 70, 36, 32, 12)) - 4;
  const header = segment(x, y, 30, 54, 98, 54) - 4;
  const ringLeft = segment(x, y, 46, 26, 46, 40) - 4.5;
  const ringRight = segment(x, y, 82, 26, 82, 40) - 4.5;
  const check = Math.min(segment(x, y, 47, 76, 59, 87), segment(x, y, 59, 87, 81, 65)) - 5;
  return Math.min(frame, header, ringLeft, ringRight, check);
}

function render(size) {
  const simple = size <= 16;
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let background = 0;
      let foreground = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) * scale;
          const y = (py + (sy + 0.5) / samples) * scale;
          if (roundedRect(x, y, 64, 64, 62, 62, 28) <= 0) {
            background += 1;
            if (glyph(x, y, simple) <= 0) foreground += 1;
          }
        }
      }
      const total = samples * samples;
      const alpha = background / total;
      const mix = background ? foreground / background : 0;
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(ACCENT[channel] * (1 - mix) + WHITE[channel] * mix);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`${OUT_DIR}icon-${size}.png`, encodePng(size, render(size)));
  console.log(`icons/icon-${size}.png`);
}
