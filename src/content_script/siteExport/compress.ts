/**
 * The compressed-entry codec the single-file export is built out of: deflate a
 * string, base64 it, and record enough to know it came back intact.
 *
 * This is what remains of the ZIP writer now that an export is a single HTML
 * file. Inside one file a ZIP container buys nothing — the works index is
 * already an entry list with random access — so the local headers and the
 * central directory went, and the two things they were wrapped around stayed:
 * a CRC-32 and a `deflate-raw` stream.
 *
 * **One entry per work, not one blob for the library.** A work is inflated only
 * when it is opened, so a reader holds the compressed bytes and at most one
 * work's worth of HTML. Inflating everything up front is what makes a tab run
 * out of memory on a tablet, and it buys nothing: the list is drawn from the
 * blurbs, which travel as their own single entry because every facet wants all
 * of them at once (and because blurbs are near-identical markup, they deflate to
 * about 14% in bulk against prose's 36% — a saving per-entry compression would
 * throw away for nothing).
 *
 * Pure — no `#common`, no `browser`, no DOM — so the whole round trip is
 * exercised by a plain `node --test`
 * ({@link file://../../../../test/siteExport/compress.test.mjs}).
 */

/**
 * Typed arrays became generic in TypeScript 5.7, and a bare `Uint8Array` is
 * `Uint8Array<ArrayBufferLike>` — which `Response` refuses, because a
 * `SharedArrayBuffer` can't back a body. Everything here comes from
 * `new Uint8Array(n)` or `TextEncoder`, so it is always the plain kind.
 */
type Bytes = Uint8Array<ArrayBuffer>

/**
 * `btoa` wants a binary string, and `String.fromCharCode(...bytes)` on a
 * megabyte-long array overflows the argument stack. 32 KiB a time is well under
 * every engine's limit and costs nothing.
 */
const BASE64_CHUNK = 0x8000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** One compressed thing in the export: the bytes, and how to know they survived. */
export interface CompressedEntry {
  /** Bytes of the *original* text, before deflate. */
  size: number
  /** CRC-32 of the original text. */
  crc: number
  /** `deflate-raw` output, base64. */
  b64: string
}

/** A work's compressed text, carrying the id the site opens it by. */
export interface CompressedWork extends CompressedEntry {
  id: string
}

/** Deflate `text` and wrap it with what {@link decompressEntry} checks it against. */
export async function compressEntry(text: string): Promise<CompressedEntry> {
  const raw = encoder.encode(text)
  return { size: raw.length, crc: crc32(raw), b64: toBase64(await deflateRaw(raw)) }
}

/**
 * The other half, for whoever is reading the export.
 *
 * Throws rather than returning something plausible: a work that inflated to the
 * wrong bytes is damaged, and saying so beats rendering it and leaving the
 * reader to wonder why a chapter reads strangely.
 */
export async function decompressEntry(entry: CompressedEntry): Promise<string> {
  const bytes = await inflateRaw(fromBase64(entry.b64))
  if (bytes.length !== entry.size)
    throw new Error(`unpacked to ${bytes.length} bytes, not the ${entry.size} recorded`)
  if (crc32(bytes) !== entry.crc)
    throw new Error('failed its checksum')
  return decoder.decode(bytes)
}

/**
 * CRC-32, the reflected IEEE polynomial — the same one ZIP carries, kept for the
 * same reason: it is the difference between a work that renders wrong and a work
 * that says it is damaged.
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

export async function deflateRaw(bytes: Bytes): Promise<Bytes> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function inflateRaw(bytes: Bytes): Promise<Bytes> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export function toBase64(bytes: Bytes): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  return btoa(binary)
}

export function fromBase64(text: string): Bytes {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}
