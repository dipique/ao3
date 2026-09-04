import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; workMarks.ts is pure (no imports at all),
// so it loads without a build, a DOM, or the extension APIs.
import {
  createDefaultMarks,
  hiddenByMarks,
  localMarkIds,
  markClears,
  markGroup,
  markHidesResults,
  markIds,
  markIsExclusive,
  markIsLocal,
  markIsReorderable,
  markItems,
  markRoot,
  marksForWork,
  moveMark,
  normalizeMarkOrder,
  packIds,
  READ_MARK,
  reorderableMarkIds,
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
    for (const id of ['favorite', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'boring', 'bad', 'gross', 'no', 'abandoned'])
      assert.equal(markRoot(marks, id), READ_MARK, `${id} should alias read`)
    assert.equal(markRoot(marks, READ_MARK), READ_MARK, 'read is its own root')
    assert.deepEqual(
      markGroup(marks, 'favorite'),
      ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned', 'continue'],
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
      ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned', 'continue'],
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

describe('the mark order', () => {
  test('a table with no order at all still reads in the order it was stored', () => {
    // What a table synced from a device predating the field looks like.
    const marks = createDefaultMarks()
    for (const config of Object.values(marks))
      delete config.order
    assert.deepEqual(markIds(marks), Object.keys(marks))
  })

  test('the stored order wins over where a mark sits in the table', () => {
    const marks = createDefaultMarks()
    marks.favorite.order = -1
    assert.equal(markIds(marks)[0], 'favorite')
  })

  test('the ongoing mark is the one nobody gets to move', () => {
    const marks = createDefaultMarks()
    assert.ok(markIsReorderable(marks, 'read'))
    assert.ok(!markIsReorderable(marks, 'continue'), 'ongoing is not a verdict')
    assert.ok(!markIsReorderable(marks, SAVED_MARK), 'and Marked for Later lives on AO3')
    assert.deepEqual(
      reorderableMarkIds(marks),
      ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned'],
    )
  })

  test('moving a mark changes the order everything is drawn in', () => {
    const marks = moveMark(createDefaultMarks(), 'favorite', -1)
    assert.deepEqual(
      localMarkIds(marks),
      ['read', 'no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'favorite', 'fluff', 'abandoned', 'continue'],
    )
    assert.deepEqual(markGroup(marks, READ_MARK), localMarkIds(marks), 'the group follows the same order')
  })

  test('a mark can be moved the length of the run', () => {
    let marks = createDefaultMarks()
    for (let i = 0; i < 11; i++)
      marks = moveMark(marks, 'read', 1)
    assert.deepEqual(
      localMarkIds(marks),
      ['no', 'bad', 'boring', 'gross', 'good', 'hot', 'dark', 'feelsy', 'fluff', 'favorite', 'abandoned', 'read', 'continue'],
      'even pushed to the bottom of the verdicts, it stays above the ongoing mark',
    )
  })

  test('a move off either end is a no-op, so no redundant write is made', () => {
    const marks = createDefaultMarks()
    assert.equal(moveMark(marks, 'read', -1), marks)
    assert.equal(moveMark(marks, 'abandoned', 1), marks, 'the last verdict cannot pass the ongoing mark')
    assert.equal(moveMark(marks, 'continue', -1), marks, 'the ongoing mark does not move at all')
    assert.equal(moveMark(marks, SAVED_MARK, -1), marks)
    assert.equal(moveMark(marks, 'nonesuch', 1), marks)
    assert.equal(moveMark(marks, 'read', 0), marks)
  })

  test('a move leaves the marks themselves alone', () => {
    const before = marksWith({ read: ['1', '2'], favorite: ['3'] })
    const after = moveMark(before, 'favorite', -1)
    assert.deepEqual([...markItems(after, 'read')], ['1', '2'])
    assert.deepEqual(marksForWork(after, '3'), ['favorite'])
    assert.equal(markHidesResults(after, 'gross'), true, 'still inheriting read')
  })

  test('normalizing settles a slot two marks claim, keeping what the table read as', () => {
    const marks = createDefaultMarks()
    // What the top-up migration can leave behind: a newly shipped mark landing
    // on a slot the reader had already moved something else into.
    marks.hot.order = marks.good.order
    const before = markIds(marks)
    const after = normalizeMarkOrder(marks)
    assert.deepEqual(markIds(after), before, 'nothing moves')
    assert.deepEqual(
      Object.values(after).map(config => config.order),
      Object.keys(after).map((_, index) => index),
      'every mark ends up holding its own slot',
    )
  })

  test('normalizing a table already in order returns it untouched', () => {
    const marks = createDefaultMarks()
    assert.equal(normalizeMarkOrder(marks), marks)
  })
})

describe('setMark', () => {
  test('setting a finer reading clears the plain root mark', () => {
    let marks = marksWith({ read: ['1'] })
    marks = setMark(marks, '1', 'favorite', true)

    assert.ok(workHasMark(marks, 'favorite', '1'))
    assert.ok(!workHasMark(marks, 'read', '1'), 'a favourite is not also listed as read')
    assert.deepEqual(marksForWork(marks, '1'), ['favorite'])
  })

  test('the finer readings stack rather than replacing each other', () => {
    // They aren't competing answers to one question: a work can be gross and
    // also hot, and saying the second must not retract the first.
    let marks = marksWith({ gross: ['7'] })
    marks = setMark(marks, '7', 'good', true)
    marks = setMark(marks, '7', 'hot', true)
    assert.deepEqual(marksForWork(marks, '7'), ['gross', 'good', 'hot'], 'in table order')
  })

  test('the plain root mark clears the finer readings', () => {
    // The other half of the same rule: plain `read` means you have no finer
    // opinion, so it can't sit beside one.
    let marks = marksWith({ gross: ['7'], hot: ['7'] })
    marks = setMark(marks, '7', READ_MARK, true)
    assert.deepEqual(marksForWork(marks, '7'), [READ_MARK])
  })

  test('clearing one of several leaves the rest', () => {
    let marks = marksWith({ good: ['7'], hot: ['7'] })
    marks = setMark(marks, '7', 'good', false)
    assert.deepEqual(marksForWork(marks, '7'), ['hot'])
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

  test('unmarking clears every mark in the group the work had', () => {
    let marks = marksWith({ boring: ['6'], fluff: ['6'] })
    marks = setMarkGroup(marks, '6', READ_MARK, false)
    assert.deepEqual(marksForWork(marks, '6'), [], 'back on the to-read pile')
  })
})

describe('which marks can sit on one work together', () => {
  test('the root and the progress mark stand alone; the readings stack', () => {
    const marks = createDefaultMarks()
    assert.ok(markIsExclusive(marks, READ_MARK), 'plain read is the absence of a verdict')
    assert.ok(markIsExclusive(marks, 'continue'), 'ongoing is the one that says you are not done')
    for (const id of ['no', 'bad', 'boring', 'gross', 'good', 'hot', 'feelsy', 'fluff', 'favorite'])
      assert.ok(!markIsExclusive(marks, id), `${id} is a thing a work was, not an answer to one question`)
  })

  test('markClears is symmetric across the exclusive ones and silent between the rest', () => {
    const marks = createDefaultMarks()
    assert.ok(markClears(marks, 'hot', READ_MARK))
    assert.ok(markClears(marks, READ_MARK, 'hot'))
    assert.ok(markClears(marks, 'hot', 'continue'))
    assert.ok(markClears(marks, 'continue', 'hot'))
    assert.ok(!markClears(marks, 'hot', 'good'))
    assert.ok(!markClears(marks, 'hot', 'hot'), 'a mark never clears itself')
    assert.ok(!markClears(marks, 'hot', SAVED_MARK), 'Marked for Later is not in the group')
  })
})
