import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { markGridKeyAction, markGridLayout } from '../../src/common/markGrid.ts'
import { createDefaultMarks, offeredMarkIds } from '../../src/common/workMarks.ts'

/** A membership test over a fixed set of mark ids, as the content script's mirror answers it. */
const carrying = (...ids) => id => ids.includes(id)

describe('offeredMarkIds', () => {
  test('offers every mark that holds works, in table order, to a work carrying none', () => {
    const marks = createDefaultMarks()
    assert.deepEqual(
      offeredMarkIds(marks, carrying()),
      ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned', 'continue'],
    )
  })

  test('leaves plain Read out while the work carries a verdict, which it would clear', () => {
    const offered = offeredMarkIds(createDefaultMarks(), carrying('good'))
    assert.ok(!offered.includes('read'))
    assert.ok(offered.includes('good'))
    assert.ok(offered.includes('continue'), 'the progress mark asks before it replaces anything')
  })

  test('keeps Read while the work carries it', () => {
    assert.ok(offeredMarkIds(createDefaultMarks(), carrying('read')).includes('read'))
  })

  test('leaves a switched-off mark out, unless this work carries it', () => {
    const marks = createDefaultMarks()
    marks.hot.disabled = true
    assert.ok(!offeredMarkIds(marks, carrying()).includes('hot'))
    assert.ok(offeredMarkIds(marks, carrying('hot')).includes('hot'))
  })

  test('follows the reader\'s order', () => {
    const marks = createDefaultMarks()
    marks.favorite.order = -1
    assert.equal(offeredMarkIds(marks, carrying())[0], 'favorite')
  })
})

describe('markGridLayout', () => {
  test('puts the marks the work carries in the selected row, the rest below, both in table order', () => {
    const layout = markGridLayout(createDefaultMarks(), carrying('favorite', 'hot', 'feelsy'))
    assert.deepEqual(layout.selected, ['hot', 'feelsy', 'favorite'])
    assert.ok(!layout.available.some(id => layout.selected.includes(id)))
    assert.deepEqual(layout.available.slice(0, 3), ['no', 'bad', 'boring'])
  })

  test('has an empty selected row for an unmarked work', () => {
    const layout = markGridLayout(createDefaultMarks(), carrying())
    assert.deepEqual(layout.selected, [])
    assert.equal(layout.available[0], 'read')
  })
})

describe('markGridKeyAction', () => {
  const press = (key, more = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, ...more })
  const closed = { open: false, typing: false }
  const open = { open: true, typing: false }

  test('r opens a closed grid and closes an open one', () => {
    assert.equal(markGridKeyAction(press('r'), closed), 'open')
    assert.equal(markGridKeyAction(press('r'), open), 'close')
  })

  test('takes R as well, so Caps Lock or Shift doesn\'t stop it', () => {
    assert.equal(markGridKeyAction(press('R', { shiftKey: true }), closed), 'open')
  })

  test('Escape closes an open grid and is left alone otherwise', () => {
    assert.equal(markGridKeyAction(press('Escape'), open), 'close')
    assert.equal(markGridKeyAction(press('Escape'), closed), null)
  })

  test('leaves r to a field being typed in', () => {
    assert.equal(markGridKeyAction(press('r'), { open: false, typing: true }), null)
  })

  test('leaves shortcuts with Ctrl, Alt or Meta to the browser', () => {
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey'])
      assert.equal(markGridKeyAction(press('r', { [modifier]: true }), closed), null, modifier)
  })

  test('ignores a held key repeating, and keys mid-composition', () => {
    assert.equal(markGridKeyAction(press('r', { repeat: true }), closed), null)
    assert.equal(markGridKeyAction(press('r', { isComposing: true }), closed), null)
  })

  test('ignores every other key', () => {
    assert.equal(markGridKeyAction(press('t'), closed), null)
    assert.equal(markGridKeyAction(press('t'), open), null)
  })
})
