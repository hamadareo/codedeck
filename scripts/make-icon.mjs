// Generates build/icon.png (1024×1024) — the app icon electron-builder turns into
// .icns / .ico. Three stacked "cards" in the profile colors on a dark rounded tile:
// a deck of sessions. Pure Node (zlib), so no design tool or binary asset is needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const S = 1024;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** Signed distance to a rounded rectangle (negative inside). */
function roundRect(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - w / 2 + r;
  const qy = Math.abs(y - cy) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d)); // 1px anti-aliasing

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const cards = [
  // [cx, cy, rotation, color] back to front
  [500, 470, -0.18, hex('#9333ea')],
  [512, 500, -0.06, hex('#16a34a')],
  [524, 535, 0.06, hex('#2563eb')],
];

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    // Tile: macOS-style rounded square with a margin, vertical gradient.
    const tile = cover(roundRect(x + 0.5, y + 0.5, S / 2, S / 2, 824, 824, 185));
    const t = y / S;
    let rgb = [Math.round(23 - 10 * t), Math.round(27 - 12 * t), Math.round(38 - 14 * t)];
    for (const [cx, cy, rot, color] of cards) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const ry = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      const a = cover(roundRect(rx, ry, 0, 0, 470, 330, 42));
      // A darker band at the top of each card: its "tab".
      const band = ry < -165 + 58 ? 0.78 : 1;
      rgb = rgb.map((c, i) => Math.round(c * (1 - a) + color[i] * band * a));
      // Prompt marker ">_" on the front card.
      if (color === cards[2][3] && a > 0) {
        // ">" : the tip on the right, at (-70, 20).
        const chevron =
          Math.abs(-70 - Math.abs(ry - 20) * 0.9 - rx) < 14 &&
          rx > -140 &&
          rx < -55 &&
          Math.abs(ry - 20) < 62;
        const cursor = rx > -30 && rx < 70 && ry > 62 && ry < 86;
        if (chevron || cursor) rgb = [245, 247, 250];
      }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = rgb[0];
    raw[o + 1] = rgb[1];
    raw[o + 2] = rgb[2];
    raw[o + 3] = Math.round(255 * tile);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.resolve(import.meta.dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
