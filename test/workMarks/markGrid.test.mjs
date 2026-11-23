import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { draftChanges, markChangesMessage, markGridKeyAction, markGridLayout, markGridTipPlacement, startDraft, toggleDraft } from '../../src/common/markGrid.ts'
import { createDefaultMarks, markLabel, marksForWork, offeredMarkIds, packIds, setMark } from '../../src/common/workMarks.ts'

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

describe('the pinned grid\'s draft', () => {
  const WORK = '42'

  /** A default table with this work carrying `ids`. */
  const tableWith = (...ids) => {
    const marks = createDefaultMarks()
    for (const id of ids)
      marks[id].items = packIds([WORK])
    return marks
  }

  /** Write `changes` one after another, as the grid commits them, and say what the work then carries. */
  const commit = (marks, changes) => {
    let next = marks
    for (const { markId, on } of changes)
      next = setMark(next, WORK, markId, on)
    return marks === next ? marksForWork(marks, WORK) : marksForWork(next, WORK)
  }

  test('starts as what the work carries, in table order', () => {
    const marks = createDefaultMarks()
    assert.deepEqual(startDraft(marks, carrying('favorite', 'hot')), ['hot', 'favorite'])
    assert.deepEqual(startDraft(marks, carrying()), [])
  })

  test('a mark chosen is added, and chosen again comes off', () => {
    const marks = createDefaultMarks()
    const on = toggleDraft(marks, ['hot'], 'feelsy')
    assert.deepEqual(on, ['hot', 'feelsy'])
    assert.deepEqual(toggleDraft(marks, on, 'hot'), ['feelsy'])
  })

  test('a mark chosen clears what it can\'t sit beside, as writing it would', () => {
    const marks = createDefaultMarks()
    assert.deepEqual(toggleDraft(marks, ['read'], 'hot'), ['hot'], 'a verdict replaces plain Read')
    assert.deepEqual(toggleDraft(marks, ['hot', 'dark'], 'read'), ['read'], 'plain Read replaces every verdict')
    assert.deepEqual(toggleDraft(marks, ['hot', 'dark'], 'continue'), ['continue'], 'so does the progress mark')
  })

  test('stays in table order whatever order the marks are chosen in', () => {
    const marks = createDefaultMarks()
    let draft = []
    for (const id of ['favorite', 'no', 'hot'])
      draft = toggleDraft(marks, draft, id)
    assert.deepEqual(draft, ['no', 'hot', 'favorite'])
  })

  test('a draft back where it started has nothing to write', () => {
    const marks = tableWith('hot')
    const carries = carrying('hot')
    const draft = toggleDraft(marks, toggleDraft(marks, startDraft(marks, carries), 'dark'), 'dark')
    assert.deepEqual(draftChanges(marks, carries, draft), [])
  })

  test('writes each mark added, and only the removals no added mark makes itself', () => {
    const marks = tableWith('read')
    const carries = carrying('read')
    let draft = startDraft(marks, carries)
    draft = toggleDraft(marks, draft, 'hot')
    draft = toggleDraft(marks, draft, 'feelsy')
    assert.deepEqual(draftChanges(marks, carries, draft), [{ markId: 'hot', on: true }, { markId: 'feelsy', on: true }])

    const both = carrying('hot', 'dark')
    assert.deepEqual(draftChanges(marks, both, ['dark']), [{ markId: 'hot', on: false }])
  })

  test('written in order, the changes leave the work carrying exactly the draft', () => {
    const starts = [[], ['read'], ['hot', 'dark'], ['continue'], ['favorite']]
    const picks = ['hot', 'read', 'dark', 'continue', 'hot', 'favorite', 'no', 'read', 'feelsy', 'no']
    for (const start of starts) {
      const marks = tableWith(...start)
      const carries = carrying(...start)
      let draft = startDraft(marks, carries)
      for (const [step, pick] of picks.entries()) {
        draft = toggleDraft(marks, draft, pick)
        assert.deepEqual(
          commit(marks, draftChanges(marks, carries, draft)),
          draft,
          `from [${start}] after ${picks.slice(0, step + 1)}`,
        )
      }
    }
  })
})

describe('markChangesMessage', () => {
  const marks = createDefaultMarks()
  const label = id => markLabel(marks, id).toLowerCase()

  test('names every mark written', () => {
    const message = markChangesMessage(marks, [{ markId: 'hot', on: true }, { markId: 'feelsy', on: true }, { markId: 'dark', on: false }], false)
    for (const id of ['hot', 'feelsy', 'dark'])
      assert.ok(message.includes(label(id)), id)
  })

  test('tells a mark set from one cleared', () => {
    assert.notEqual(
      markChangesMessage(marks, [{ markId: 'hot', on: true }], false),
      markChangesMessage(marks, [{ markId: 'hot', on: false }], false),
    )
  })

  test('says when the work came off Marked for Later', () => {
    const changes = [{ markId: 'hot', on: true }]
    assert.notEqual(markChangesMessage(marks, changes, true), markChangesMessage(marks, changes, false))
  })
})

describe('markGridTipPlacement', () => {
  const viewport = { width: 800, height: 600 }
  const tip = { width: 200, height: 40 }
  const tile = (left, top) => ({ left, top, right: left + 100, bottom: top + 70, width: 100, height: 70 })

  test('sits under the tile, centred on it', () => {
    const at = markGridTipPlacement(tile(300, 100), tip, viewport)
    assert.equal(at.left, 250)
    assert.ok(at.top >= 170, 'below the tile')
    assert.ok(at.top < 190, 'close under it')
  })

  test('goes above the tile when there is no room under it', () => {
    const at = markGridTipPlacement(tile(300, 520), tip, viewport)
    assert.ok(at.top + tip.height <= 520, 'clear of the tile')
    assert.ok(at.top + tip.height > 500, 'close above it')
  })

  test('stays on screen beside an edge', () => {
    assert.ok(markGridTipPlacement(tile(0, 100), tip, viewport).left >= 0)
    const right = markGridTipPlacement(tile(700, 100), tip, viewport)
    assert.ok(right.left + tip.width <= viewport.width)
  })
})
