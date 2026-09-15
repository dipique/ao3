import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { countOrderedIds, fromShortId, packOrderedIds, toShortId, unpackOrderedIds } from '../../src/common/workId.ts'

describe('short work ids', () => {
  test('base 36 both ways', () => {
    assert.equal(toShortId('7134741'), '48x79')
    assert.equal(toShortId(79362971), '1b90uz')
    assert.equal(fromShortId('48x79'), '7134741')
    assert.equal(fromShortId(toShortId('1')), '1')
  })

  test('junk is refused rather than guessed at', () => {
    for (const bad of ['', ' ', '12a', '-3', '1.5', '9007199254740993'])
      assert.equal(toShortId(bad), null, `toShortId(${JSON.stringify(bad)})`)
    for (const bad of ['', 'ABC', '4-8', 'zzzzzzzzzzzzzzzzzz'])
      assert.equal(fromShortId(bad), null, `fromShortId(${JSON.stringify(bad)})`)
  })
})

describe('ordered id lists', () => {
  test('keep the order they were given, not a sorted one', () => {
    const ids = ['79362971', '7134741', '12']
    const packed = packOrderedIds(ids)
    assert.equal(packed, '1b90uz,48x79,c')
    assert.deepEqual(unpackOrderedIds(packed), ids)
    assert.equal(countOrderedIds(packed), 3)
  })

  test('drop duplicates (first place wins) and junk', () => {
    assert.equal(packOrderedIds(['5', 'x', '6', '5', '']), '5,6')
    assert.deepEqual(unpackOrderedIds('5,??,6'), ['5', '6'])
  })

  test('empty is empty', () => {
    assert.equal(packOrderedIds([]), '')
    assert.deepEqual(unpackOrderedIds(''), [])
    assert.equal(countOrderedIds(''), 0)
  })
})
