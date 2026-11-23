import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { offersMarkForLater } from '../../src/common/markedForLater.ts'
import { createDefaultMarks, READ_MARK } from '../../src/common/workMarks.ts'

const marks = createDefaultMarks()
const carrying = (...ids) => markId => ids.includes(markId)

describe('offersMarkForLater', () => {
  test('a work with no marks, not on the list, is offered', () => {
    assert.equal(offersMarkForLater(marks, carrying(), false), true)
  })

  test('a work already on the list is not', () => {
    assert.equal(offersMarkForLater(marks, carrying(), true), false)
  })

  test('a work marked read is not', () => {
    assert.equal(offersMarkForLater(marks, carrying(READ_MARK), false), false)
  })

  test('a work with a finer verdict is not, since the verdict counts as read', () => {
    assert.equal(offersMarkForLater(marks, carrying('good'), false), false)
  })

  test('an ongoing work is not, since the mark keeps it on the list itself', () => {
    assert.equal(offersMarkForLater(marks, carrying('continue'), false), false)
  })

  test('a mark outside the read group leaves the work offered', () => {
    const own = { ...marks, mood: { icon: 'mdi/star', label: 'Mood', items: '' } }
    assert.equal(offersMarkForLater(own, carrying('mood'), false), true)
  })
})
