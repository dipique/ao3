import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; compress.ts imports nothing at all, so it
// loads under a plain `node --test` with no build and no DOM. `CompressionStream`,
// `Response`, `atob` and `btoa` are globals here as they are in a browser.
import {
  compressEntry,
  crc32,
  decompressEntry,
  deflateRaw,
  fromBase64,
  inflateRaw,
  toBase64,
} from '../../src/content_script/siteExport/compress.ts'

const encode = text => new TextEncoder().encode(text)

describe('siteExport/compress — CRC-32', () => {
  test('matches the published check value', () => {
    // The check value every CRC-32 implementation is measured against.
    assert.equal(crc32(encode('123456789')), 0xCBF43926)
  })

  test('is zero for no bytes, and stable for one', () => {
    assert.equal(crc32(new Uint8Array(0)), 0)
    assert.equal(crc32(encode('a')), 0xE8B7BE43)
  })

  test('notices a single flipped bit', () => {
    const bytes = encode('The text of work 11.')
    const flipped = Uint8Array.from(bytes)
    flipped[3] ^= 1
    assert.notEqual(crc32(bytes), crc32(flipped))
  })
})

describe('siteExport/compress — base64', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(512)
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = (i * 7) % 256
    assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes])
  })

  test('round-trips more bytes than one fromCharCode call can take', () => {
    // The chunking exists because `String.fromCharCode(...bytes)` blows the
    // argument stack well before a work's worth of data.
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251)
    const back = fromBase64(toBase64(bytes))
    assert.equal(back.length, bytes.length)
    assert.deepEqual([...back.subarray(0, 64)], [...bytes.subarray(0, 64)])
    assert.deepEqual([...back.subarray(-64)], [...bytes.subarray(-64)])
  })

  test('handles the empty case', () => {
    assert.equal(toBase64(new Uint8Array(0)), '')
    assert.equal(fromBase64('').length, 0)
  })
})

describe('siteExport/compress — deflate', () => {
  test('round-trips through inflate', async () => {
    const text = 'Words, words, words. '.repeat(200)
    const back = await inflateRaw(await deflateRaw(encode(text)))
    assert.equal(new TextDecoder().decode(back), text)
  })

  test('actually compresses a work-sized page', async () => {
    const html = `<div class="ao3e-work">${'<p>Words, words, words. </p>'.repeat(500)}</div>`
    const deflated = await deflateRaw(encode(html))
    assert.ok(deflated.length < encode(html).length / 10, 'prose should deflate hard')
  })
})

describe('siteExport/compress — entries', () => {
  test('round-trips a work, recording what it should come back as', async () => {
    const html = '<div class="ao3e-work"><p>The text of work 11.</p></div>'
    const entry = await compressEntry(html)

    assert.equal(entry.size, encode(html).length)
    assert.equal(entry.crc, crc32(encode(html)))
    assert.match(entry.b64, /^[a-z0-9+/]+=*$/i)
    // Base64 holds no `<`, which is why only the manifest needs script escaping.
    assert.ok(!entry.b64.includes('<'))

    assert.equal(await decompressEntry(entry), html)
  })

  test('round-trips text well past ASCII', async () => {
    const html = '<p>“Ich weiß nicht,” 彼女は言った — 🙂</p>'
    assert.equal(await decompressEntry(await compressEntry(html)), html)
  })

  test('round-trips an empty entry', async () => {
    const entry = await compressEntry('')
    assert.equal(entry.size, 0)
    assert.equal(await decompressEntry(entry), '')
  })

  test('refuses an entry whose checksum does not match', async () => {
    const entry = await compressEntry('<p>one</p>')
    const other = await compressEntry('<p>two</p>')
    await assert.rejects(
      () => decompressEntry({ ...other, size: entry.size, crc: entry.crc }),
      /checksum|bytes, not the/,
    )
  })

  test('refuses an entry that unpacks to the wrong length', async () => {
    const entry = await compressEntry('<p>one</p>')
    await assert.rejects(() => decompressEntry({ ...entry, size: entry.size + 1 }), /bytes, not the/)
  })

  test('entries are independent — one damaged work does not spoil the rest', async () => {
    const good = await compressEntry('<p>fine</p>')
    const bad = { ...await compressEntry('<p>damaged</p>'), crc: 0 }
    await assert.rejects(() => decompressEntry(bad))
    assert.equal(await decompressEntry(good), '<p>fine</p>')
  })
})
