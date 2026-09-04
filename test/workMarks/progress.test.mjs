import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// workMarks.ts is import-free, so Node loads it bare after stripping the types.
import {
  countProgress,
  createDefaultMarks,
  hiddenByMarks,
  markProgress,
  marksForWork,
  marksHideAnything,
  markTracksProgress,
  packIds,
  packProgress,
  progressFor,
  progressMarkIds,
  READ_MARK,
  setMark,
  setMarkGroup,
  setMarkProgress,
  unpackProgress,
  withProgress,
  workHasMark,
} from '../../src/common/workMarks.ts'

const PROGRESS_MARK = 'continue'

/** A default table with `read` set to hide, plus whatever marks/progress you name. */
function marksWith({ items = {}, progress = {} } = {}) {
  const marks = createDefaultMarks()
  marks.read.hideSearchResult = true
  for (const [id, ids] of Object.entries(items))
    marks[id].items = packIds(ids)
  for (const [id, entries] of Object.entries(progress))
    marks[id].progress = packProgress(Object.entries(entries))
  return marks
}

/** The whole map as plain data, for readable assertions. */
function progressMap(marks, id = PROGRESS_MARK) {
  return Object.fromEntries(markProgress(marks, id))
}

describe('the progress mark in the default table', () => {
  test('it tracks progress and nothing else does', () => {
    const marks = createDefaultMarks()
    assert.deepEqual(progressMarkIds(marks), [PROGRESS_MARK])
    assert.ok(markTracksProgress(marks, PROGRESS_MARK))
    assert.ok(!markTracksProgress(marks, READ_MARK))
  })

  test('a table with no progress mark is a clean no-op, not a crash', () => {
    // What an older device's sync (or a pre-`continue` backup) hands you.
    const marks = createDefaultMarks()
    delete marks[PROGRESS_MARK]
    assert.deepEqual(progressMarkIds(marks), [])
    assert.equal(marksHideAnything(marks), false)
    assert.equal(progressFor(marks, PROGRESS_MARK, '1'), undefined)
    assert.equal(setMarkProgress(marks, '1', PROGRESS_MARK, { chapter: 3 }), marks)
  })
})

describe('the progress codec', () => {
  test('round-trips with and without a date', () => {
    const packed = packProgress([['46', { chapter: 3 }], ['48', { chapter: 0, waitUntil: 20_000 }]])
    assert.deepEqual(Object.fromEntries(unpackProgress(packed)), {
      46: { chapter: 3 },
      48: { chapter: 0, waitUntil: 20_000 },
    })
  })

  test('the same map always packs to the same string', () => {
    const forwards = packProgress([['5', { chapter: 1 }], ['9', { chapter: 2, waitUntil: 30 }]])
    const backwards = packProgress([['9', { chapter: 2, waitUntil: 30 }], ['5', { chapter: 1 }]])
    assert.equal(forwards, backwards, 'input order must not reach the stored string')
  })

  test('no trailing colon when there is no date', () => {
    const packed = packProgress([['5', { chapter: 1 }]])
    assert.ok(!packed.includes('::'), packed)
    assert.ok(!packed.endsWith(':'), packed)
  })

  test('chapter 0 encodes as "0", never as empty', () => {
    const packed = packProgress([['5', { chapter: 0 }]])
    assert.equal(packed, '5:0')
    assert.deepEqual(Object.fromEntries(unpackProgress(packed)), { 5: { chapter: 0 } })
  })

  test('ids are delta-encoded in base 36, sorted', () => {
    assert.equal(packProgress([['100', { chapter: 0 }], ['10', { chapter: 0 }]]), 'a:0,2i:0')
  })

  test('a malformed chunk truncates rather than inventing ids', () => {
    const map = unpackProgress('5:1,zz:2,!!:3,7:4')
    assert.deepEqual([...map.keys()], ['5', '1300'], 'the walk stops at the bad delta')
  })

  test('a malformed date costs the date, not the entry after it', () => {
    const map = unpackProgress('5:1:!!,2:3')
    assert.deepEqual(Object.fromEntries(map), { 5: { chapter: 1 }, 7: { chapter: 3 } })
  })

  test('junk entries are dropped rather than throwing', () => {
    const packed = packProgress([
      ['', { chapter: 1 }],
      ['abc', { chapter: 1 }],
      ['-4', { chapter: 1 }],
      ['5', { chapter: -1 }],
      ['6', { chapter: 2, waitUntil: -3 }],
    ])
    assert.deepEqual(Object.fromEntries(unpackProgress(packed)), {
      5: { chapter: 0 },
      6: { chapter: 2 },
    })
  })

  test('countProgress counts entries without building the map', () => {
    assert.equal(countProgress(''), 0)
    assert.equal(countProgress(packProgress([['5', { chapter: 1 }], ['9', { chapter: 2 }]])), 2)
  })
})

describe('withProgress', () => {
  const packed = packProgress([['5', { chapter: 1 }], ['9', { chapter: 2, waitUntil: 30 }]])

  test('a no-op write returns the very same string', () => {
    assert.equal(withProgress(packed, '5', { chapter: 1 }), packed)
    assert.equal(withProgress(packed, '9', { chapter: 2, waitUntil: 30 }), packed)
    assert.equal(withProgress(packed, '404', null), packed, 'removing what was never there')
  })

  test('a chapter-only edit does change the string', () => {
    const next = withProgress(packed, '5', { chapter: 2 })
    assert.notEqual(next, packed)
    assert.deepEqual(Object.fromEntries(unpackProgress(next))[5], { chapter: 2 })
  })

  test('dropping the date is a change, and leaves nothing behind', () => {
    const next = withProgress(packed, '9', { chapter: 2 })
    assert.notEqual(next, packed)
    assert.deepEqual(Object.fromEntries(unpackProgress(next))[9], { chapter: 2 })
  })

  test('a passed date is kept, because the hint has to name it', () => {
    // Dropping it would be the one edit the reader can never undo — the date is
    // their own note about when they meant to come back.
    const next = withProgress('', '5', { chapter: 1, waitUntil: 1 })
    assert.deepEqual(Object.fromEntries(unpackProgress(next))[5], { chapter: 1, waitUntil: 1 })
  })

  test('removing an entry leaves the rest packed correctly', () => {
    const next = withProgress(packed, '5', null)
    assert.deepEqual(Object.fromEntries(unpackProgress(next)), { 9: { chapter: 2, waitUntil: 30 } })
  })
})

describe('orphaned progress', () => {
  test('an entry with no matching id is ignored on read', () => {
    const marks = marksWith({ items: { continue: ['5'] }, progress: { continue: { 5: { chapter: 1 }, 9: { chapter: 7 } } } })
    assert.deepEqual(progressMap(marks), { 5: { chapter: 1 } })
    assert.equal(progressFor(marks, PROGRESS_MARK, '9'), undefined)
  })

  test('and is not re-emitted by the next write', () => {
    const marks = marksWith({ items: { continue: ['5'] }, progress: { continue: { 5: { chapter: 1 }, 9: { chapter: 7 } } } })
    const next = setMarkProgress(marks, '5', PROGRESS_MARK, { chapter: 4 })
    assert.deepEqual(Object.fromEntries(unpackProgress(next[PROGRESS_MARK].progress)), { 5: { chapter: 4 } })
  })
})

describe('setMarkProgress', () => {
  test('sets membership and payload in one go', () => {
    const marks = marksWith()
    const next = setMarkProgress(marks, '7', PROGRESS_MARK, { chapter: 9, waitUntil: 20_500 })
    assert.ok(workHasMark(next, PROGRESS_MARK, '7'))
    assert.deepEqual(progressMap(next), { 7: { chapter: 9, waitUntil: 20_500 } })
  })

  test('a chapter-only edit breaks identity, so the write is not dropped', () => {
    // `items` doesn't move on this edit at all, and the content script's commit()
    // short-circuits on `next === marks.marks` — so ignoring `progress` here
    // would silently swallow the edit.
    const marks = marksWith({ items: { continue: ['7'] }, progress: { continue: { 7: { chapter: 9 } } } })
    const next = setMarkProgress(marks, '7', PROGRESS_MARK, { chapter: 10 })
    assert.notEqual(next, marks)
    assert.deepEqual(progressMap(next), { 7: { chapter: 10 } })
  })

  test('an identical write returns the same table', () => {
    const marks = marksWith({ items: { continue: ['7'] }, progress: { continue: { 7: { chapter: 9 } } } })
    assert.equal(setMarkProgress(marks, '7', PROGRESS_MARK, { chapter: 9 }), marks)
  })

  test('it replaces whatever else in the group the work carried', () => {
    const marks = marksWith({ items: { gross: ['7'] } })
    const next = setMarkProgress(marks, '7', PROGRESS_MARK, { chapter: 2 })
    assert.deepEqual(marksForWork(next, '7'), [PROGRESS_MARK])
  })

  test('a mark that does not track progress refuses the payload', () => {
    const marks = marksWith()
    assert.equal(setMarkProgress(marks, '7', READ_MARK, { chapter: 2 }), marks)
  })
})

describe('items and progress stay in step', () => {
  const seeded = () => marksWith({
    items: { continue: ['7'] },
    progress: { continue: { 7: { chapter: 9, waitUntil: 20_500 } } },
  })

  test('clearing the mark itself drops its payload', () => {
    const next = setMark(seeded(), '7', PROGRESS_MARK, false)
    assert.equal(next[PROGRESS_MARK].progress, '', 'the first drop site')
    assert.deepEqual(marksForWork(next, '7'), [])
  })

  test('a finer reading replaces it too — a verdict means you are done', () => {
    // The readings stack with each other, but not with the mark that says you
    // haven't finished: calling a work good settles it.
    const next = setMark(seeded(), '7', 'good', true)
    assert.equal(next[PROGRESS_MARK].progress, '')
    assert.deepEqual(marksForWork(next, '7'), ['good'])
  })

  test('being replaced by another mark in the group drops it too', () => {
    // The second drop site: marking the work `read` clears `continue`, and the
    // payload has to go with it or it is orphaned forever.
    const next = setMark(seeded(), '7', READ_MARK, true)
    assert.equal(next[PROGRESS_MARK].progress, '', 'the group-clearing loop')
    assert.deepEqual(marksForWork(next, '7'), [READ_MARK])
  })
})

describe('setMarkGroup and the progress exemptions', () => {
  const ongoing = () => marksWith({
    items: { continue: ['7'] },
    progress: { continue: { 7: { chapter: 9 } } },
  })

  test('the archive’s own "Mark as Read" promotes an ongoing work out of ongoing', () => {
    // An ongoing work is the one member of the read group that isn't a verdict,
    // so it must not block the promotion the way `gross` does.
    const next = setMarkGroup(ongoing(), '7', READ_MARK, true)
    assert.deepEqual(marksForWork(next, '7'), [READ_MARK])
    assert.equal(next[PROGRESS_MARK].progress, '')
  })

  test('the archive’s own "Mark for Later" leaves an ongoing work exactly as it was', () => {
    // The CaptureMarkButtons path: pressing the archive's own Mark for Later
    // button reaches setMarkGroup(off) — which must not erase the mark and its
    // progress, since "back on the to-read pile" is what ongoing already means.
    const marks = ongoing()
    const next = setMarkGroup(marks, '7', READ_MARK, false)
    assert.equal(next, marks, 'no change at all')
    assert.deepEqual(marksForWork(next, '7'), [PROGRESS_MARK])
  })

  test('turning the group off still clears an ordinary mark alongside it', () => {
    const marks = marksWith({ items: { gross: ['7'] } })
    const next = setMarkGroup(marks, '7', READ_MARK, false)
    assert.deepEqual(marksForWork(next, '7'), [])
  })
})

describe('hiding', () => {
  test('hiddenByMarks skips progress marks entirely', () => {
    // Carrying the mark decides nothing: whether an ongoing work is worth
    // showing depends on a chapter count only the caller can read.
    const marks = marksWith({
      items: { continue: ['7'] },
      progress: { continue: { 7: { chapter: 9 } } },
    })
    assert.equal(hiddenByMarks(marks).size, 0)
  })

  test('...but marksHideAnything still reports true, so the unit runs', () => {
    const marks = createDefaultMarks()
    marks[PROGRESS_MARK].items = packIds(['7'])
    marks[PROGRESS_MARK].progress = packProgress([['7', { chapter: 9 }]])
    assert.equal(hiddenByMarks(marks).size, 0)
    assert.equal(marksHideAnything(marks), true)
  })

  test('nothing hides when the progress mark is set not to', () => {
    const marks = createDefaultMarks()
    marks[PROGRESS_MARK].hideSearchResult = false
    marks[PROGRESS_MARK].items = packIds(['7'])
    marks[PROGRESS_MARK].progress = packProgress([['7', { chapter: 9 }]])
    assert.equal(marksHideAnything(marks), false)
  })

  test('an ordinary hiding mark still answers on its own', () => {
    const marks = marksWith({ items: { read: ['1'] } })
    assert.equal(marksHideAnything(marks), true)
  })

  test('a fresh table hides nothing', () => {
    assert.equal(marksHideAnything(createDefaultMarks()), false)
  })
})
