/**
 * A small, independent ZIP *reader*, for checking what
 * `src/content_script/siteExport/zip.ts` writes.
 *
 * Deliberately shares no code with the writer: it walks the central directory
 * the way an unzipper does — find the end-of-central-directory record, read each
 * entry from there, then follow its offset to the local header and the data —
 * so a writer that agreed with itself but with nobody else would still fail.
 * Every entry's CRC is verified against the bytes that come back out.
 */

const EOCD_SIG = 0x06054B50
const CENTRAL_SIG = 0x02014B50
const LOCAL_SIG = 0x04034B50

/**
 * Parse `bytes` (a Uint8Array of a whole archive) into a Map of path ->
 * `{ bytes, text, method, size, compressedSize, crc }`.
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // The EOCD is 22 bytes with no archive comment; scan back anyway, which is
  // what a real reader has to do.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0)
    throw new Error('no end-of-central-directory record')

  const count = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (centralOffset + centralSize !== eocd)
    throw new Error('central directory does not end where the EOCD begins')

  const decoder = new TextDecoder()
  const entries = new Map()
  let cursor = centralOffset

  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIG)
      throw new Error(`central directory entry ${i} has the wrong signature`)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const offset = view.getUint32(cursor + 42, true)
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

    if (view.getUint32(offset, true) !== LOCAL_SIG)
      throw new Error(`"${path}" does not point at a local header`)
    const localNameLength = view.getUint16(offset + 26, true)
    const localExtraLength = view.getUint16(offset + 28, true)
    const localName = decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength))
    if (localName !== path)
      throw new Error(`"${path}" is named "${localName}" in its local header`)

    const start = offset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(start, start + compressedSize)
    const data = method === 8 ? await inflateRaw(raw) : raw

    if (data.length !== size)
      throw new Error(`"${path}" unpacked to ${data.length} bytes, not the ${size} it claims`)
    if (crc32(data) !== crc)
      throw new Error(`"${path}" fails its CRC`)

    entries.set(path, {
      path,
      bytes: data,
      get text() { return decoder.decode(data) },
      method,
      size,
      compressedSize,
      crc,
      utf8: (flags & 0x800) !== 0,
    })

    cursor += 46 + nameLength + extraLength + commentLength
  }

  if (cursor !== eocd)
    throw new Error('central directory is longer than the EOCD says')

  return entries
}

async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The reader's own CRC-32, so a broken table in the writer can't pass itself. */
function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}
