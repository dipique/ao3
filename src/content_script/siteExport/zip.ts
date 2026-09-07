/**
 * A minimal ZIP writer — the last thing the site export needs that the platform
 * doesn't already provide.
 *
 * No dependency, because there is nothing worth depending on: a store-or-deflate
 * ZIP is a CRC32, a local header per entry, a central directory and an
 * end-of-central-directory record — and method 8's payload is exactly what
 * `CompressionStream('deflate-raw')` produces, which
 * {@link file://../../common/syncCodec.ts} has been using since long before this.
 *
 * Pure — no `#common`, no `browser`, no DOM — so the byte format is exercised by
 * a plain `node --test` ({@link file://../../../../test/siteExport/zip.test.mjs})
 * rather than only through whatever a browser happens to accept.
 *
 * **Entries are consumed one at a time, and may arrive from an async
 * generator.** A five-hundred-work export is tens of megabytes of HTML; holding
 * every raw entry *and* every compressed one would double a peak the options
 * page has no reason to pay. Streaming them in lets the caller build each work's
 * page as it is asked for and let go of it immediately.
 */

const LOCAL_HEADER_SIG = 0x04034B50
const CENTRAL_HEADER_SIG = 0x02014B50
const EOCD_SIG = 0x06054B50

/** 2.0 — the version that introduced deflate, which is the most we emit. */
const VERSION_NEEDED = 20

/** Version made by: 2.0, MS-DOS/FAT — which is what "no external attributes" means. */
const VERSION_MADE_BY = 20

/** General-purpose bit 11: the file name is UTF-8, not CP437. */
const FLAG_UTF8 = 0x800

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** Where the plain format stops and ZIP64 would have to begin. */
const MAX_UINT32 = 0xFFFFFFFF
const MAX_ENTRIES = 0xFFFF

/** The DOS date epoch — timestamps below it cannot be represented at all. */
const DOS_EPOCH_YEAR = 1980

/**
 * Typed arrays became generic in TypeScript 5.7, and a bare `Uint8Array` is
 * `Uint8Array<ArrayBufferLike>` — which `Blob` and `Response` both refuse,
 * because a `SharedArrayBuffer` can't back either. Everything here comes from
 * `new Uint8Array(n)` or `TextEncoder`, so it is always the plain kind.
 */
type Bytes = Uint8Array<ArrayBuffer>

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. Encoded UTF-8 (see {@link FLAG_UTF8}). */
  path: string
  /** Contents. A string is encoded UTF-8. */
  data: Bytes | string
  /**
   * Deflate this entry. On by default; the writer stores it anyway when
   * deflating came out no smaller, so passing `false` only matters for data
   * already known to be incompressible.
   */
  compress?: boolean
}

export interface ZipOptions {
  /** Modification time stamped on every entry. Defaults to now. */
  date?: Date
}

/** What a written entry leaves behind for the central directory. */
interface DirectoryEntry {
  name: Bytes
  method: number
  crc: number
  compressedSize: number
  size: number
  time: number
  date: number
  offset: number
}

const encoder = new TextEncoder()

/**
 * Write `entries` as a ZIP archive.
 *
 * Accepts a plain array as happily as an async generator; entries are read in
 * order and each one's raw bytes are released as soon as it has been compressed.
 */
export async function createZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  opts: ZipOptions = {},
): Promise<Blob> {
  const [time, date] = dosDateTime(opts.date ?? new Date())
  const parts: BlobPart[] = []
  const directory: DirectoryEntry[] = []
  let offset = 0

  for await (const entry of entries) {
    const name = encoder.encode(entry.path)
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const crc = crc32(raw)

    // Deflate unless asked not to — and keep the result only if it actually came
    // out smaller, since deflating already-compressed bytes grows them.
    let method = METHOD_STORE
    let body = raw
    if (entry.compress !== false && raw.length > 0) {
      const deflated = await deflateRaw(raw)
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE
        body = deflated
      }
    }

    if (raw.length > MAX_UINT32 || body.length > MAX_UINT32)
      throw new Error(`"${entry.path}" is too large for a ZIP file without ZIP64.`)

    const record: DirectoryEntry = {
      name,
      method,
      crc,
      compressedSize: body.length,
      size: raw.length,
      time,
      date,
      offset,
    }
    directory.push(record)

    const header = localHeader(record)
    parts.push(header, body)
    offset += header.length + body.length

    if (offset > MAX_UINT32)
      throw new Error('This export is larger than 4 GB, which would need a ZIP64 writer.')
    if (directory.length > MAX_ENTRIES)
      throw new Error(`A ZIP file without ZIP64 holds at most ${MAX_ENTRIES.toLocaleString()} files.`)
  }

  const centralOffset = offset
  let centralSize = 0
  for (const record of directory) {
    const header = centralHeader(record)
    parts.push(header)
    centralSize += header.length
  }

  parts.push(endOfCentralDirectory(directory.length, centralSize, centralOffset))
  return new Blob(parts, { type: 'application/zip' })
}

/**
 * CRC-32 (the reflected IEEE polynomial), as every ZIP entry carries. Exported
 * because it is the one part of the format with an answer worth checking against
 * a published vector.
 */
export function crc32(bytes: Bytes): number {
  const table = crcTable()
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++)
    crc = table[(crc ^ bytes[i]!) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

let table: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (table)
    return table
  const next = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    next[i] = value >>> 0
  }
  table = next
  return next
}

async function deflateRaw(bytes: Bytes): Promise<Bytes> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function localHeader(record: DirectoryEntry): Bytes {
  const header = new Uint8Array(30 + record.name.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, LOCAL_HEADER_SIG, true)
  view.setUint16(4, VERSION_NEEDED, true)
  view.setUint16(6, FLAG_UTF8, true)
  view.setUint16(8, record.method, true)
  view.setUint16(10, record.time, true)
  view.setUint16(12, record.date, true)
  view.setUint32(14, record.crc, true)
  view.setUint32(18, record.compressedSize, true)
  view.setUint32(22, record.size, true)
  view.setUint16(26, record.name.length, true)
  view.setUint16(28, 0, true)
  header.set(record.name, 30)
  return header
}

function centralHeader(record: DirectoryEntry): Bytes {
  const header = new Uint8Array(46 + record.name.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, CENTRAL_HEADER_SIG, true)
  view.setUint16(4, VERSION_MADE_BY, true)
  view.setUint16(6, VERSION_NEEDED, true)
  view.setUint16(8, FLAG_UTF8, true)
  view.setUint16(10, record.method, true)
  view.setUint16(12, record.time, true)
  view.setUint16(14, record.date, true)
  view.setUint32(16, record.crc, true)
  view.setUint32(20, record.compressedSize, true)
  view.setUint32(24, record.size, true)
  view.setUint16(28, record.name.length, true)
  // Extra field, file comment, disk number, internal attributes, external
  // attributes — all zero. Nothing here is a symlink, a directory entry, or a
  // file whose Unix mode anybody reads back.
  view.setUint16(30, 0, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, record.offset, true)
  header.set(record.name, 46)
  return header
}

function endOfCentralDirectory(count: number, size: number, offset: number): Bytes {
  const eocd = new Uint8Array(22)
  const view = new DataView(eocd.buffer)
  view.setUint32(0, EOCD_SIG, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, size, true)
  view.setUint32(16, offset, true)
  view.setUint16(20, 0, true)
  return eocd
}

/**
 * A `Date` as the MS-DOS time and date words ZIP still stores: two-second
 * resolution, and no year before 1980 — clamped rather than wrapped, since a
 * clock that wrong should not produce an archive dated 2076.
 */
export function dosDateTime(when: Date): [time: number, date: number] {
  const year = Math.max(DOS_EPOCH_YEAR, when.getFullYear())
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)
  const date = ((year - DOS_EPOCH_YEAR) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  return [time, date]
}
