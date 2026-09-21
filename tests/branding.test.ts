/**
 * Company branding: the logo upload, how it is served, and what it refuses.
 *
 * The refusals matter as much as the happy path - the logo is served from the
 * app's own origin, so accepting a scriptable file would be stored XSS for
 * every visitor including signed-out ones.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectImageType } from '../server/repositories/branding.ts';

/** Smallest valid files of each accepted type, plus things that must be refused. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

test('recognises the raster formats it accepts', () => {
  assert.equal(detectImageType(PNG), 'image/png');
  assert.equal(detectImageType(JPEG), 'image/jpeg');
  assert.equal(detectImageType(GIF), 'image/gif');
  assert.equal(detectImageType(WEBP), 'image/webp');
});

test('refuses SVG, which can carry script', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
  assert.equal(detectImageType(svg), null);
});

test('refuses a file whose name and declared type lie about its contents', () => {
  // An HTML page uploaded as "logo.png" with Content-Type: image/png. Only the
  // bytes are consulted, so the lie does not get it past the door.
  const html = Buffer.from('<!doctype html><script>fetch("/api/users")</script>', 'utf8');
  assert.equal(detectImageType(html), null);
});

test('refuses other executable and archive payloads', () => {
  assert.equal(detectImageType(Buffer.from('PK\u0003\u0004', 'latin1')), null, 'zip');
  assert.equal(detectImageType(Buffer.from('\u007fELF', 'latin1')), null, 'elf binary');
  assert.equal(detectImageType(Buffer.from('%PDF-1.7\n', 'latin1')), null, 'pdf');
});

test('refuses a file too short to identify', () => {
  assert.equal(detectImageType(Buffer.alloc(0)), null);
  assert.equal(detectImageType(Buffer.from('89504e47', 'hex')), null);
});

test('a PNG prefix on a larger hostile payload is still just a PNG', () => {
  // Content sniffing is the risk being closed off: the response pins the type
  // to what the signature says and sends X-Content-Type-Options: nosniff.
  const polyglot = Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>', 'utf8')]);
  assert.equal(detectImageType(polyglot), 'image/png');
});
