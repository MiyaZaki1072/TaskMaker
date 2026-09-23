/**
 * Joins PNG strips (same width, top to bottom) into one PNG.
 *
 * Why this exists: Chromium cannot capture a very tall page in one screenshot. Past roughly 16k
 * device pixels the capture silently repeats earlier content instead of failing, so a long
 * scoreboard is captured as strips and joined here.
 *
 * Only what Chromium produces is supported — 8-bit RGB or RGBA, not interlaced — which keeps this
 * to a small decoder with no dependency. Strips are decoded one at a time and fed through a single
 * deflate stream, so memory stays at one strip plus the compressed output rather than the whole
 * image uncompressed (a 2000-row scoreboard at 2x would otherwise need ~800 MB).
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel for the two colour types Chromium writes: RGB and RGBA */
const CHANNELS: Record<number, number> = { 2: 3, 6: 4 };
/** IDAT payload size; any size is valid, this just avoids thousands of tiny chunks */
const IDAT_SIZE = 1 << 20;

interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  /** Unfiltered pixel rows, back to back */
  pixels: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Uint8Array): DecodedPng {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');

  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
      if (data[8] !== 8 || !(colorType in CHANNELS) || data[12] !== 0) {
        throw new Error(`Unsupported PNG (bit depth ${data[8]}, colour type ${colorType}, interlace ${data[12]})`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const bpp = CHANNELS[colorType]!;
  const stride = width * bpp;
  const filtered = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[src + x]!;
      const left = x >= bpp ? pixels[row + x - bpp]! : 0;
      const up = y > 0 ? pixels[prev + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[prev + x - bpp]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: value = raw + paeth(left, up, upLeft); break;
        default: throw new Error(`Bad PNG filter ${filter} on row ${y}`);
      }
      pixels[row + x] = value & 0xff;
    }
  }
  return { width, height, colorType, pixels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(parts: Buffer[]): number {
  let crc = 0xffffffff;
  for (const part of parts) for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, tail]);
}

/** Stacks the strips top to bottom into one PNG */
export async function stitchPngs(strips: Uint8Array[]): Promise<Buffer> {
  if (strips.length === 0) throw new Error('Nothing to stitch');

  const deflate = zlib.createDeflate({ level: 6 });
  const compressed: Buffer[] = [];
  deflate.on('data', (data: Buffer) => compressed.push(data));
  const finished = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  const write = (data: Buffer) =>
    new Promise<void>((resolve, reject) => deflate.write(data, (err) => (err ? reject(err) : resolve())));

  let width = 0;
  let colorType = 0;
  let height = 0;
  for (const strip of strips) {
    const png = decodePng(strip);
    if (height === 0) {
      width = png.width;
      colorType = png.colorType;
    } else if (png.width !== width || png.colorType !== colorType) {
      throw new Error(`Strip is ${png.width}px (type ${png.colorType}), expected ${width}px (type ${colorType})`);
    }
    // Each row re-encoded with filter 0 (none): simple, and deflate still compresses flat colour well
    const stride = width * CHANNELS[colorType]!;
    const rows = Buffer.alloc((stride + 1) * png.height);
    for (let y = 0; y < png.height; y += 1) png.pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    await write(rows);
    height += png.height;
  }
  deflate.end();
  await finished;

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const data = Buffer.concat(compressed);
  const idat: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += IDAT_SIZE) {
    idat.push(pngChunk('IDAT', data.subarray(offset, offset + IDAT_SIZE)));
  }
  return Buffer.concat([SIGNATURE, pngChunk('IHDR', header), ...idat, pngChunk('IEND', Buffer.alloc(0))]);
}
