// Generates the original MoneyCash app icon (no external tools): a rounded teal square with three
// rising white bars and a coin. Writes electron/assets/icon.png (512), icon.ico (16-256, PNG
// entries) and tray.png / tray@2x.png. Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'assets');
mkdirSync(OUT, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Shape functions in unit coordinates (0..1). Returns [r,g,b,a] or null.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function sample(x, y, { tray }) {
  // background tile
  const bg = tray ? inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.2) : inRoundRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2);
  if (!bg) return [0, 0, 0, 0];
  // vertical gradient teal -> deep green
  const t = y;
  let col = [Math.round(20 + 10 * t), Math.round(150 - 50 * t), Math.round(130 - 40 * t), 255];
  const white = [255, 255, 255, 255];
  // three rising bars
  const bars = [[0.24, 0.62], [0.42, 0.48], [0.60, 0.34]];
  for (const [bx, top] of bars) if (inRoundRect(x, y, bx, top, bx + 0.13, 0.78, 0.03)) col = white;
  // coin (gold) top-right, with inner ring
  const d = Math.hypot(x - 0.74, y - 0.27);
  if (d <= 0.12) col = d >= 0.085 && d <= 0.1 ? [214, 160, 20, 255] : [250, 196, 45, 255];
  return col;
}

function render(size, opts = {}) {
  const ss = 4; // supersampling for anti-aliasing
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, opts);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const i = (py * size + px) * 4;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round(a / (ss * ss));
    }
  }
  return png(size, buf);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

writeFileSync(join(OUT, 'icon.png'), render(512));
writeFileSync(join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size) }))));
writeFileSync(join(OUT, 'tray.png'), render(16, { tray: true }));
writeFileSync(join(OUT, 'tray@2x.png'), render(32, { tray: true }));
console.log('icons written to', OUT);
