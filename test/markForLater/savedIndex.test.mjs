import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { savedIndexChanges } from '../../src/common/markedForLater.ts'

const changes = (before, after) => [...savedIndexChanges(new Set(before), new Set(after))]

describe('savedIndexChanges', () => {
  test('a work that came onto the index is saved', () => {
    assert.deepEqual(changes(['1'], ['1', '2']), [['2', true]])
  })

  test('a work that went off it is not', () => {
    assert.deepEqual(changes(['1', '2'], ['2']), [['1', false]])
  })

  test('both at once', () => {
    assert.deepEqual(new Map(changes(['1', '2'], ['2', '3'])), new Map([['1', false], ['3', true]]))
  })

  test('the same set, in any order, is no change', () => {
    assert.deepEqual(changes(['1', '2'], ['2', '1']), [])
    assert.deepEqual(changes([], []), [])
  })
})
