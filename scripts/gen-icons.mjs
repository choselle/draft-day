/* Generates the Draft Day home-screen icons (PNG, no dependencies):
   a gold football on the app's dark background, drawn with 3x3
   supersampling. Writes public/apple-touch-icon.png (180),
   public/icon-192.png, and public/icon-512.png.
   Run: node scripts/gen-icons.mjs */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [0x14, 0x18, 0x1d];
const GOLD = [0xf0, 0xc2, 0x4b];

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* Color of one sample point: gold football (rotated 45°) with lace
   cutouts on the dark background. */
function sample(x, y, S) {
  const dx = x - S / 2;
  const dy = y - S / 2;
  const r = Math.SQRT1_2;
  const u = dx * r + dy * r; // along the ball's long axis
  const v = -dx * r + dy * r;
  const a = 0.37 * S;
  const b = 0.23 * S;
  if ((u * u) / (a * a) + (v * v) / (b * b) > 1) return BG;
  if (Math.abs(v) <= 0.018 * S && Math.abs(u) <= 0.155 * S) return BG;
  for (const k of [-0.11, -0.055, 0, 0.055, 0.11]) {
    if (Math.abs(v) <= 0.058 * S && Math.abs(u - k * S) <= 0.015 * S)
      return BG;
  }
  return GOLD;
}

function makePng(S) {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      let rs = 0,
        gs = 0,
        bs = 0;
      for (let sy = 0; sy < 3; sy++)
        for (let sx = 0; sx < 3; sx++) {
          const [r, g, b] = sample(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3, S);
          rs += r;
          gs += g;
          bs += b;
        }
      const o = y * (S * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(rs / 9);
      raw[o + 1] = Math.round(gs / 9);
      raw[o + 2] = Math.round(bs / 9);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [file, size] of [
  ["public/apple-touch-icon.png", 180],
  ["public/icon-192.png", 192],
  ["public/icon-512.png", 512],
]) {
  writeFileSync(file, makePng(size));
  console.log(`${file} (${size}x${size})`);
}
