import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; workMarks.ts is pure (no imports at all),
// so it loads without a build, a DOM, or the extension APIs.
import {
  createDefaultMarks,
  hiddenByMarks,
  localMarkIds,
  markGroup,
  markHidesResults,
  markIsLocal,
  markItems,
  markRoot,
  marksForWork,
  packIds,
  READ_MARK,
  SAVED_MARK,
  setMark,
  setMarkGroup,
  workHasMark,
} from '../../src/common/workMarks.ts'

/** A default table with `read` set to hide, which is how the migration leaves it. */
function marksWith(entries = {}) {
  const marks = createDefaultMarks()
  marks.read.hideSearchResult = true
  for (const [id, ids] of Object.entries(entries))
    marks[id].items = packIds(ids)
  return marks
}

describe('the mark table', () => {
  test('the finer dispositions all behave as read', () => {
    const marks = createDefaultMarks()
    for (const id of ['favorite', 'good', 'hot', 'boring', 'bad', 'gross'])
      assert.equal(markRoot(marks, id), READ_MARK, `${id} should alias read`)
    assert.equal(markRoot(marks, READ_MARK), READ_MARK, 'read is its own root')
    assert.deepEqual(
      markGroup(marks, 'favorite'),
      ['read', 'bad', 'boring', 'gross', 'good', 'hot', 'favorite', 'continue'],
      'the whole group, in table order — `continue` is in it too, so choosing '
      + 'one replaces the other; what it does *not* share is the unsaving',
    )
  })

  test('only the marks holding ids are local', () => {
    const marks = createDefaultMarks()
    assert.ok(markIsLocal(marks, 'favorite'))
    assert.ok(!markIsLocal(marks, SAVED_MARK), 'Marked for Later lives on AO3, not here')
    // Order is the menu's order, not an implementation detail: `read`, then its
    // finer readings worst to best, then the one that isn't a verdict.
    assert.deepEqual(
      localMarkIds(marks),
      ['read', 'bad', 'boring', 'gross', 'good', 'hot', 'favorite', 'continue'],
    )
  })

  test('hot behaves exactly as good does', () => {
    // Added as a peer of the other verdicts, so nothing about it should be
    // special — same root, same group, same inherited hiding.
    const marks = createDefaultMarks()
    assert.equal(markRoot(marks, 'hot'), markRoot(marks, 'good'))
    assert.deepEqual(markGroup(marks, 'hot'), markGroup(marks, 'good'))
    assert.equal(markHidesResults(marks, 'hot'), markHidesResults(marks, 'good'))
    assert.equal(marks.hot.hideSearchResult, marks.good.hideSearchResult)
    assert.ok(markIsLocal(marks, 'hot'), 'it holds its own ids')
  })

  test('hiding is inherited from the group root', () => {
    const marks = marksWith()
    assert.ok(markHidesResults(marks, READ_MARK))
    assert.ok(markHidesResults(marks, 'gross'), 'inherits read')

    marks.gross.hideSearchResult = false
    assert.ok(!markHidesResults(marks, 'gross'), 'an explicit value overrides the root')

    marks.read.hideSearchResult = false
    assert.ok(!markHidesResults(marks, 'favorite'))
  })

  test('hiddenByMarks names the mark responsible for each work', () => {
    const marks = marksWith({ read: ['1', '2'], favorite: ['3'], good: ['4'] })
    // `good` opts out, so its works stay visible even though read hides.
    marks.good.hideSearchResult = false

    const hidden = hiddenByMarks(marks)
    assert.deepEqual([...hidden.keys()].sort(), ['1', '2', '3'])
    assert.equal(hidden.get('1'), 'read')
    assert.equal(hidden.get('3'), 'favorite')
    assert.ok(!hidden.has('4'), 'a mark that opted out hides nothing')
  })

  test('nothing hides when the root does not', () => {
    const marks = createDefaultMarks()
    assert.equal(hiddenByMarks(marks).size, 0)
  })
})

describe('setMark', () => {
  test('setting a mark clears the rest of its group', () => {
    let marks = marksWith({ read: ['1'] })
    marks = setMark(marks, '1', 'favorite', true)

    assert.ok(workHasMark(marks, 'favorite', '1'))
    assert.ok(!workHasMark(marks, 'read', '1'), 'a favourite is not also listed as read')
    assert.deepEqual(marksForWork(marks, '1'), ['favorite'])
  })

  test('replacing one fine disposition with another', () => {
    let marks = marksWith({ gross: ['7'] })
    marks = setMark(marks, '7', 'good', true)
    assert.deepEqual(marksForWork(marks, '7'), ['good'])
  })

  test('clearing a mark leaves the work with nothing', () => {
    let marks = marksWith({ favorite: ['5'] })
    marks = setMark(marks, '5', 'favorite', false)
    assert.deepEqual(marksForWork(marks, '5'), [])
  })

  test('a no-op returns the same table, so no redundant write is made', () => {
    const marks = marksWith({ read: ['1'] })
    assert.equal(setMark(marks, '1', 'read', true), marks)
    assert.equal(setMark(marks, '9', 'read', false), marks)
    assert.equal(setMark(marks, '1', SAVED_MARK, true), marks, 'a mark with no id set is untouchable')
  })

  test('other works are left alone', () => {
    let marks = marksWith({ read: ['1', '2'] })
    marks = setMark(marks, '1', 'bad', true)
    assert.deepEqual([...markItems(marks, 'read')], ['2'])
  })
})

describe('setMarkGroup', () => {
  test('marking read leaves a finer disposition in place', () => {
    // AO3's own "Mark as Read" button is blunt: it must not downgrade a work you
    // already called gross to a plain read mark.
    const marks = marksWith({ gross: ['4'] })
    assert.equal(setMarkGroup(marks, '4', READ_MARK, true), marks, 'no change at all')
    assert.deepEqual(marksForWork(marks, '4'), ['gross'])
  })

  test('marking an unmarked work read sets the root mark', () => {
    let marks = marksWith()
    marks = setMarkGroup(marks, '4', READ_MARK, true)
    assert.deepEqual(marksForWork(marks, '4'), ['read'])
  })

  test('unmarking clears whichever mark in the group the work had', () => {
    let marks = marksWith({ boring: ['6'] })
    marks = setMarkGroup(marks, '6', READ_MARK, false)
    assert.deepEqual(marksForWork(marks, '6'), [], 'back on the to-read pile')
  })
})
