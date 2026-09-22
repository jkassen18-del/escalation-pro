import zlib from 'node:zlib';

/**
 * A tiny ZIP writer, for the Teams app package.
 *
 * Teams takes an app as a zip of a manifest and two icons, so one has to be
 * produced somewhere. Written here rather than pulled in: the format needs
 * about eighty lines for what this does, and a dependency in the bundle of an
 * internet-facing server is a worse trade than that.
 *
 * Only the subset the package needs: deflate or store, no directories, no
 * zip64, no encryption. Not a general archiver, and not trying to be.
 */

export interface ZipEntry {
  /** Path inside the archive. Teams wants these flat. */
  name: string;
  data: Buffer;
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

/**
 * The timestamp fields, in the MS-DOS format ZIP has always used.
 *
 * Seconds have one bit less than they need, hence the halving, and the epoch
 * is 1980. A date before that cannot be represented, so it is clamped rather
 * than silently wrapping to something absurd.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipOptions {
  /** Fixed timestamp for every entry, so the same input gives the same bytes. */
  modified?: Date;
}

export function createZip(entries: ZipEntry[], options: ZipOptions = {}): Buffer {
  const { time, date } = dosDateTime(options.modified ?? new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);

    /*
     * Deflate unless it makes the entry bigger, which it does for anything
     * already compressed - the PNGs here. Storing those keeps the archive
     * smaller and is what the format's method 0 is for.
     */
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    // >>> 0 because << yields a signed int32, and this value overflows into
    // the sign bit.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: a regular file
    central.writeUInt32LE(offset, 42);

    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...locals, centralDirectory, end]);
}
