import zlib from 'node:zlib';

/**
 * A tiny PNG writer, for the Teams app icons.
 *
 * Teams refuses an app package that does not contain both icons at exactly
 * the right sizes, so they cannot simply be left out - and committing two
 * binary blobs to be edited by hand is worse than generating them, because
 * the colour should follow whatever the deployment has branded itself as.
 *
 * Only what that needs: 8-bit RGBA, no interlacing, one IDAT. Not a general
 * encoder, and not trying to be.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes raw RGBA pixels as a PNG.
 *
 * Every scanline is written with filter type 0. A real encoder would choose
 * per line to compress better; these images are a few kilobytes either way.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} bytes of RGBA, got ${pixels.length}`);
  }

  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------- Drawing the icon ----------------------------- */

/** A canvas that knows how to draw the handful of shapes an icon needs. */
class Canvas {
  readonly pixels: Uint8Array;

  constructor(
    readonly size: number,
    fill: Rgba = { r: 0, g: 0, b: 0, a: 0 },
  ) {
    this.pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      this.pixels[i * 4] = fill.r;
      this.pixels[i * 4 + 1] = fill.g;
      this.pixels[i * 4 + 2] = fill.b;
      this.pixels[i * 4 + 3] = fill.a;
    }
  }

  /**
   * Blends a colour into one pixel.
   *
   * Coverage is the anti-aliasing: shapes are sampled at their edges rather
   * than snapped to whole pixels, or a rounded corner at 32px looks like a
   * staircase.
   */
  blend(x: number, y: number, colour: Rgba, coverage = 1): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const alpha = (colour.a / 255) * Math.max(0, Math.min(1, coverage));
    if (alpha <= 0) return;

    const i = (y * this.size + x) * 4;
    const existing = this.pixels[i + 3] / 255;
    const out = alpha + existing * (1 - alpha);
    if (out <= 0) return;

    for (let c = 0; c < 3; c += 1) {
      const src = [colour.r, colour.g, colour.b][c];
      this.pixels[i + c] = Math.round((src * alpha + this.pixels[i + c] * existing * (1 - alpha)) / out);
    }
    this.pixels[i + 3] = Math.round(out * 255);
  }

  /** Paints a coverage mask in one colour. */
  paintMask(mask: Float32Array, colour: Rgba): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const coverage = mask[y * this.size + x];
        if (coverage > 0) this.blend(x, y, colour, coverage);
      }
    }
  }
}

/** True when a point is inside a rounded rectangle. */
function inRoundedRect(px: number, py: number, x0: number, y0: number, w: number, h: number, r: number): boolean {
  if (px < x0 || py < y0 || px > x0 + w || py > y0 + h) return false;
  const radius = Math.min(r, w / 2, h / 2);
  const cx = Math.min(Math.max(px, x0 + radius), x0 + w - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y0 + h - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Samples a shape into a coverage mask, 4x4 per pixel.
 *
 * A mask rather than direct drawing because the glyph is a stroke - an outer
 * shape minus an inner one - and the two icons composite it differently: onto
 * an accent square in one case and onto nothing in the other. Deciding
 * coverage first and colour second keeps one description of the shape.
 */
function sampleMask(size: number, inside: (x: number, y: number) => boolean): Float32Array {
  const mask = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits += 1;
        }
      }
      if (hits > 0) mask[y * size + x] = hits / 16;
    }
  }
  return mask;
}

function parseHex(hex: string, fallback: Rgba): Rgba {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return fallback;
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: 255 };
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/**
 * The glyph both icons carry: a ticket card with three lines of writing.
 *
 * An outlined card rather than a filled one, so the same shape works on the
 * accent square and on transparency. Deliberately blunt: at 32 pixels an
 * outline icon is a silhouette, and anything finer turns to mush.
 */
function ticketMask(size: number, scale = 1): Float32Array {
  const cardW = size * 0.6 * scale;
  const cardH = size * 0.48 * scale;
  const cardX = (size - cardW) / 2;
  const cardY = (size - cardH) / 2;
  const radius = size * 0.07 * scale;
  const stroke = Math.max(1.25, size * 0.055 * scale);

  const lineX = cardX + cardW * 0.17;
  const lineH = Math.max(1.25, size * 0.05);
  const lines = [0.42, 0.62].map((t, i) => ({
    y: cardY + cardH * t,
    w: cardW * (i === 0 ? 0.66 : 0.4),
  }));

  return sampleMask(size, (x, y) => {
    // The card's edge: inside the outer shape but not the inner one.
    const outer = inRoundedRect(x, y, cardX, cardY, cardW, cardH, radius);
    const inner = inRoundedRect(
      x,
      y,
      cardX + stroke,
      cardY + stroke,
      cardW - stroke * 2,
      cardH - stroke * 2,
      Math.max(0, radius - stroke),
    );
    if (outer && !inner) return true;

    // The writing on it.
    return lines.some((line) => y >= line.y && y <= line.y + lineH && x >= lineX && x <= lineX + line.w);
  });
}

/**
 * The full-colour icon: 192x192, a filled accent square with the glyph on it.
 *
 * Teams shows this in the app catalogue and the channel header, so it has a
 * background of its own rather than relying on the surface behind it.
 */
export function colorIcon(accentHex = '#1f2937'): Buffer {
  const size = 192;
  const canvas = new Canvas(size);
  const accent = parseHex(accentHex, { r: 31, g: 41, b: 55, a: 255 });

  canvas.paintMask(
    sampleMask(size, (x, y) => inRoundedRect(x, y, 0, 0, size, size, size * 0.18)),
    accent,
  );
  canvas.paintMask(ticketMask(size), WHITE);

  return encodePng(size, size, canvas.pixels);
}

/**
 * The outline icon: 32x32, transparent, a single flat colour.
 *
 * Teams tints this itself to match the user's theme, so anything other than
 * one solid colour on transparency comes out wrong in dark mode.
 */
export function outlineIcon(): Buffer {
  const size = 32;
  const canvas = new Canvas(size);
  // Larger than on the colour icon: there is no background square to sit
  // inside here, so the glyph is the whole of what Teams has to show.
  canvas.paintMask(ticketMask(size, 1.35), WHITE);
  return encodePng(size, size, canvas.pixels);
}
