import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dropSlot, moveGroupKey } from '../../src/content_script/searchView/groupOrder.ts'

const letters = s => [...s]

describe('moveGroupKey', () => {
  test('moves a group down among the groups shown', () => {
    assert.deepEqual(moveGroupKey(letters('abcd'), letters('abcd'), 'a', 2), letters('bcad'))
  })

  test('moves a group up among the groups shown', () => {
    assert.deepEqual(moveGroupKey(letters('abcd'), letters('abcd'), 'd', 1), letters('adbc'))
  })

  test('leaves the order alone when the group stays in its slot', () => {
    assert.deepEqual(moveGroupKey(letters('abcd'), letters('abcd'), 'b', 1), letters('abcd'))
  })

  test('pulls a slot past either end back to it', () => {
    assert.deepEqual(moveGroupKey(letters('abc'), letters('abc'), 'b', -3), letters('bac'))
    assert.deepEqual(moveGroupKey(letters('abc'), letters('abc'), 'b', 9), letters('acb'))
  })

  test('puts the keys with no group shown after the shown ones, in their own order', () => {
    assert.deepEqual(moveGroupKey(letters('xaybzc'), letters('abc'), 'c', 0), letters('cabxyz'))
  })

  test('changes nothing for a key with no group shown', () => {
    assert.deepEqual(moveGroupKey(letters('xabc'), letters('abc'), 'x', 0), letters('xabc'))
  })
})

describe('dropSlot', () => {
  // Four groups whose middles sit at these heights; the second one is dragged.
  const MIDS = [10, 50, 100, 200]

  test('goes first while the pointer is above every other middle', () => {
    assert.equal(dropSlot(MIDS, 1, 0), 0)
    assert.equal(dropSlot(MIDS, 1, 9), 0)
  })

  test('goes last once the pointer is below every other middle', () => {
    assert.equal(dropSlot(MIDS, 1, 201), 3)
  })

  test('goes after each other middle the pointer is below', () => {
    assert.equal(dropSlot(MIDS, 1, 11), 1)
    assert.equal(dropSlot(MIDS, 1, 101), 2)
  })

  test('ignores the dragged group\'s own middle', () => {
    assert.equal(dropSlot(MIDS, 1, 60), 1)
    assert.equal(dropSlot(MIDS, 0, 60), 1)
  })

  test('stays put until the pointer is past a middle, not on it', () => {
    assert.equal(dropSlot(MIDS, 1, 100), 1)
  })

  test('holds once the move is made: the moved-past group shifts away from the pointer', () => {
    // A short group dragged below a tall one: the tall one moves up by the
    // short one's height, and its middle stays above the pointer.
    const before = [5, 210]
    const y = 211
    const to = dropSlot(before, 0, y)
    assert.equal(to, 1)
    const after = [200, 415]
    assert.equal(dropSlot(after, to, y), to)
  })
})
