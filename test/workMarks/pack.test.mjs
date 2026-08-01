import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node 25 strips the TS types on import; workMarks.ts is pure (no imports at
// all), so it loads without a build, a DOM, or the extension APIs.
import { countIds, hasId, packIds, unpackIds, withId } from '../../src/common/workMarks.ts'

describe('packIds / unpackIds', () => {
  test('round-trips a set of ids', () => {
    const ids = ['438475', '20209021', '79362971', '1']
    assert.deepEqual(unpackIds(packIds(ids)), new Set(ids))
  })

  test('empty in, empty out', () => {
    assert.equal(packIds([]), '')
    assert.deepEqual(unpackIds(''), new Set())
    assert.equal(countIds(''), 0)
  })

  test('is canonical — order and duplicates do not change the output', () => {
    const packed = packIds(['30', '10', '20'])
    assert.equal(packIds(['20', '30', '10', '20']), packed)
    assert.equal(packIds(['10', '20', '30']), packed)
  })

  test('encodes deltas in base 36 against the previous id', () => {
    // 46, then +2 => 48, then +5 => 53. 46 is '1a' in base 36.
    assert.equal(packIds(['46', '48', '53']), '1a,2,5')
    assert.deepEqual(unpackIds('1a,2,5'), new Set(['46', '48', '53']))
  })

  test('drops junk rather than throwing', () => {
    assert.deepEqual(unpackIds(packIds(['12', 'abc', '', '-4', '3.5', '7'])), new Set(['7', '12']))
  })

  test('a single id encodes as its own base-36 value', () => {
    assert.equal(packIds(['79362971']), (79362971).toString(36))
  })

  test('countIds matches the unpacked size without unpacking', () => {
    const packed = packIds(['5', '9', '400', '123456'])
    assert.equal(countIds(packed), 4)
    assert.equal(countIds(packed), unpackIds(packed).size)
  })

  test('stops at a malformed chunk instead of inventing shifted ids', () => {
    // Everything after a bad delta would be relative to it, so the walk stops.
    assert.deepEqual(unpackIds('1a,!!,5'), new Set(['46']))
  })

  test('packs a realistic list far smaller than a plain id list', () => {
    // 5 000 eight-digit ids spread over AO3's id range.
    const ids = Array.from({ length: 5000 }, (_, i) => String(1_000_000 + i * 15_000))
    const packed = packIds(ids)
    assert.deepEqual(unpackIds(packed), new Set(ids))
    // A JSON array of the same ids costs ~11 bytes each; deltas cost ~4.
    assert.ok(packed.length < JSON.stringify(ids).length / 2, `packed ${packed.length} vs json ${JSON.stringify(ids).length}`)
  })
})

describe('withId', () => {
  test('adds and removes', () => {
    const base = packIds(['10', '20'])
    assert.deepEqual(unpackIds(withId(base, '15', true)), new Set(['10', '15', '20']))
    assert.deepEqual(unpackIds(withId(base, '10', false)), new Set(['20']))
  })

  test('returns the original string when nothing changes', () => {
    const base = packIds(['10', '20'])
    // Identity-equal, so callers can skip the storage write entirely.
    assert.equal(withId(base, '10', true), base)
    assert.equal(withId(base, '99', false), base)
  })

  test('removing the last id yields the empty string', () => {
    assert.equal(withId(packIds(['42']), '42', false), '')
  })

  test('hasId agrees with unpackIds', () => {
    const packed = packIds(['3', '400', '79362971'])
    assert.ok(hasId(packed, '400'))
    assert.ok(hasId(packed, '79362971'))
    assert.ok(!hasId(packed, '401'))
  })
})
