import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; zip.ts imports nothing at all, so it loads
// under a plain `node --test` with no build and no DOM. `CompressionStream`,
// `Response` and `Blob` are globals here as they are in a browser.
import { crc32, createZip, dosDateTime } from '../../src/content_script/siteExport/zip.ts'
import { readZip } from './zipReader.mjs'

const encoder = new TextEncoder()
const encode = text => encoder.encode(text)

/** Build an archive and read it back through the independent reader. */
async function roundTrip(entries, opts) {
  const blob = await createZip(entries, opts)
  assert.equal(blob.type, 'application/zip')
  return readZip(new Uint8Array(await blob.arrayBuffer()))
}

describe('siteExport/zip — CRC-32', () => {
  test('matches the published check value', () => {
    // The check value every CRC-32 implementation is measured against.
    assert.equal(crc32(encode('123456789')), 0xCBF43926)
  })

  test('is zero for no bytes, and stable for one', () => {
    assert.equal(crc32(new Uint8Array(0)), 0)
    assert.equal(crc32(encode('a')), 0xE8B7BE43)
  })
})

describe('siteExport/zip — archives', () => {
  test('round-trips text, bytes and an empty file', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    const entries = await roundTrip([
      { path: 'index.html', data: '<!doctype html><p>hello</p>' },
      { path: 'assets/raw.bin', data: bytes },
      { path: 'empty.txt', data: '' },
    ])

    assert.deepEqual([...entries.keys()], ['index.html', 'assets/raw.bin', 'empty.txt'])
    assert.equal(entries.get('index.html').text, '<!doctype html><p>hello</p>')
    assert.deepEqual([...entries.get('assets/raw.bin').bytes], [...bytes])
    assert.equal(entries.get('empty.txt').size, 0)
    assert.equal(entries.get('empty.txt').method, 0, 'nothing to deflate')
  })

  test('deflates what compresses and stores what does not', async () => {
    const entries = await roundTrip([
      { path: 'repetitive.txt', data: 'ao3 '.repeat(500) },
      { path: 'short.txt', data: 'no' },
      { path: 'asked-to-store.txt', data: 'ao3 '.repeat(500), compress: false },
    ])

    const repetitive = entries.get('repetitive.txt')
    assert.equal(repetitive.method, 8)
    assert.ok(repetitive.compressedSize < repetitive.size / 10, 'should be much smaller deflated')
    assert.equal(repetitive.text, 'ao3 '.repeat(500))

    // Deflate grows two bytes into five, so the writer keeps them as they were.
    assert.equal(entries.get('short.txt').method, 0)

    const stored = entries.get('asked-to-store.txt')
    assert.equal(stored.method, 0)
    assert.equal(stored.compressedSize, stored.size)
  })

  test('names are UTF-8, and flagged as such', async () => {
    const entries = await roundTrip([
      { path: 'works/日本語 — “quoted”.html', data: 'ok' },
    ])
    const entry = entries.get('works/日本語 — “quoted”.html')
    assert.ok(entry, 'the non-ASCII path should survive')
    assert.equal(entry.utf8, true)
  })

  test('holds a full-sized work page unchanged', async () => {
    // Roughly what one cached work weighs, with the kind of markup it carries.
    const page = `<div class="ao3e-work">${'<p>Words, words, words. </p>'.repeat(2000)}</div>`
    const entries = await roundTrip([{ path: 'works/79362971.html', data: page }])
    assert.equal(entries.get('works/79362971.html').text, page)
  })

  test('takes an async generator, one entry at a time', async () => {
    let built = 0
    async function* pages() {
      for (const id of ['11', '12', '13']) {
        built++
        yield { path: `works/${id}.html`, data: `work ${id}` }
      }
    }
    const entries = await roundTrip(pages())
    assert.equal(built, 3)
    assert.equal(entries.get('works/13.html').text, 'work 13')
  })

  test('an empty archive is still a readable one', async () => {
    const entries = await roundTrip([])
    assert.equal(entries.size, 0)
  })
})

describe('siteExport/zip — DOS timestamps', () => {
  test('packs an ordinary date', () => {
    const [time, date] = dosDateTime(new Date(2026, 8, 7, 14, 51, 3))
    // Seconds have two-second resolution: 3 stores as 1.
    assert.equal(time, (14 << 11) | (51 << 5) | 1)
    assert.equal(date, ((2026 - 1980) << 9) | (9 << 5) | 7)
  })

  test('clamps a clock set before 1980 rather than wrapping it', () => {
    const [, date] = dosDateTime(new Date(1970, 0, 1, 0, 0, 0))
    assert.equal(date >>> 9, 0, 'year field should sit at the epoch, not go negative')
  })
})
