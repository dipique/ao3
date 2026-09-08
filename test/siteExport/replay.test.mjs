import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createDefaultMarks, markItems, markProgress, setMark } from '../../src/common/workMarks.ts'
// Node strips the TS types on import; replay.ts reaches only workMarks.ts, which
// has no imports at all, so the pair loads with no build, no DOM and no
// extension APIs — which is the whole reason the merge lives in its own module.
import { replayChanges } from '../../src/content_script/siteExport/replay.ts'

const AT = Date.UTC(2026, 8, 7, 12)

/** One op, with the boilerplate filled in. */
function op(id, at, workId, kind, payload) {
  return { id, at, workId, op: kind, payload }
}

/** A fresh mark table, plus whatever the test wants already marked on it. */
function table(preset = {}) {
  let marks = createDefaultMarks()
  for (const [markId, workIds] of Object.entries(preset)) {
    for (const workId of workIds)
      marks = setMark(marks, workId, markId, true)
  }
  return marks
}

const EMPTY = { applied: new Set() }

/**
 * What a file of ops does to the mark table when it comes home.
 *
 * The interesting cases are the ones where two ops disagree, where the same file
 * arrives twice, and where the table has moved on since the export was made —
 * everything else is the mark writers, which are tested on their own.
 */
describe('siteExport/replay', () => {
  test('a mark op sets the mark', () => {
    const result = replayChanges(
      [op('a', AT, '11', 'setMark', { markId: 'favorite', on: true })],
      { marks: table(), ...EMPTY },
    )
    assert.deepEqual(result.applied, ['a'])
    assert.ok(markItems(result.marks, 'favorite').has('11'))
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.archive, [])
  })

  /**
   * Ordering is the whole of last-write-wins: ops are applied oldest first, so
   * the reader's final word about a work is what stands however the file
   * happened to be laid out.
   */
  test('the last thing the reader said is what stands, whatever order the file is in', () => {
    const ops = [
      op('c', AT + 2000, '11', 'setMark', { markId: 'favorite', on: false }),
      op('a', AT, '11', 'setMark', { markId: 'favorite', on: true }),
      op('b', AT + 1000, '11', 'setMark', { markId: 'boring', on: true }),
    ]
    const result = replayChanges(ops, { marks: table(), ...EMPTY })
    assert.deepEqual(result.applied, ['a', 'b', 'c'])
    assert.ok(!markItems(result.marks, 'favorite').has('11'))
    assert.ok(markItems(result.marks, 'boring').has('11'))
    // The caller's array is the file it read; sorting it under them would
    // reorder what they go on to report.
    assert.deepEqual(ops.map(entry => entry.id), ['c', 'a', 'b'])
  })

  test('ops made in the same millisecond are still applied in one settled order', () => {
    const first = replayChanges([
      op('b', AT, '11', 'setMark', { markId: 'favorite', on: false }),
      op('a', AT, '11', 'setMark', { markId: 'favorite', on: true }),
    ], { marks: table(), ...EMPTY })
    const second = replayChanges([
      op('a', AT, '11', 'setMark', { markId: 'favorite', on: true }),
      op('b', AT, '11', 'setMark', { markId: 'favorite', on: false }),
    ], { marks: table(), ...EMPTY })
    assert.deepEqual(first.applied, second.applied)
    assert.equal(markItems(first.marks, 'favorite').has('11'), markItems(second.marks, 'favorite').has('11'))
  })

  /**
   * The ledger is what makes a second import of one file free — and, more to the
   * point, what stops a file the reader keeps re-importing from undoing a change
   * they have since made by hand.
   */
  test('an op that has been applied before is not applied again', () => {
    const marks = table()
    const result = replayChanges(
      [op('a', AT, '11', 'setMark', { markId: 'favorite', on: true })],
      { marks, applied: new Set(['a']) },
    )
    assert.equal(result.duplicates, 1)
    assert.deepEqual(result.applied, [])
    assert.equal(result.marks, marks, 'an untouched table comes back as itself')
  })

  test('an op that changes nothing is still honoured', () => {
    const marks = table({ favorite: ['11'] })
    const result = replayChanges(
      [op('a', AT, '11', 'setMark', { markId: 'favorite', on: true })],
      { marks, ...EMPTY },
    )
    // Nothing moved, so the table comes back identity-equal — but the op is
    // written down, or every future import would apply it again.
    assert.equal(result.marks, marks)
    assert.deepEqual(result.applied, ['a'])
  })

  test('progress travels with the chapter the reader stopped at', () => {
    const result = replayChanges([
      op('a', AT, '11', 'setProgress', { markId: 'continue', on: true, progress: { chapter: 4, waitUntil: 20700 } }),
    ], { marks: table(), ...EMPTY })
    assert.deepEqual(markProgress(result.marks, 'continue').get('11'), { chapter: 4, waitUntil: 20700 })
  })

  /**
   * A disposition is not a choice of mark: replayed, it has to leave a finer
   * mark in the same group standing, which is a different writer at this end.
   */
  test('a group write leaves a finer mark alone where a plain one would replace it', () => {
    const marks = table({ boring: ['11'] })
    const grouped = replayChanges(
      [op('a', AT, '11', 'setMark', { markId: 'read', on: true, group: true })],
      { marks, ...EMPTY },
    )
    assert.ok(markItems(grouped.marks, 'boring').has('11'), 'the verdict survives the disposition')
    assert.ok(!markItems(grouped.marks, 'read').has('11'))

    const plain = replayChanges(
      [op('a', AT, '11', 'setMark', { markId: 'read', on: true })],
      { marks, ...EMPTY },
    )
    assert.ok(!markItems(plain.marks, 'boring').has('11'), 'an explicit choice replaces it')
    assert.ok(markItems(plain.marks, 'read').has('11'))
  })

  describe('what cannot be applied', () => {
    test('a mark the reader has deleted since is skipped, by name', () => {
      const marks = table()
      delete marks.favorite
      const result = replayChanges(
        [op('a', AT, '11', 'setMark', { markId: 'favorite', on: true })],
        { marks, ...EMPTY },
      )
      assert.deepEqual(result.applied, [])
      assert.equal(result.skipped.length, 1)
      assert.equal(result.skipped[0].workId, '11')
      assert.match(result.skipped[0].reason, /favorite/)
    })

    test('a mark that keeps no ids of its own is skipped rather than written to', () => {
      const result = replayChanges(
        [op('a', AT, '11', 'setMark', { markId: 'saved', on: true })],
        { marks: table(), ...EMPTY },
      )
      assert.deepEqual(result.applied, [])
      assert.equal(result.skipped.length, 1)
    })

    test('progress for a mark that no longer tracks it is skipped, not written flat', () => {
      const marks = table()
      marks.continue = { ...marks.continue, tracksProgress: false }
      const result = replayChanges([
        op('a', AT, '11', 'setProgress', { markId: 'continue', on: true, progress: { chapter: 4 } }),
      ], { marks, ...EMPTY })
      assert.deepEqual(result.applied, [])
      assert.equal(result.skipped.length, 1)
      assert.match(result.skipped[0].reason, /where you got to/)
    })
  })

  describe('the half only AO3 can do', () => {
    const readOp = op('a', AT, '11', 'markAsRead', { markId: 'boring', on: true })

    test('a markAsRead op asks for the work to come off the list', () => {
      const result = replayChanges([readOp], { marks: table(), ...EMPTY })
      assert.deepEqual(result.archive, [{ workId: '11', opId: 'a' }])
      assert.ok(markItems(result.marks, 'boring').has('11'), 'and the local half happens regardless')
    })

    test('a plain setMark asks nothing of the archive', () => {
      const result = replayChanges(
        [op('a', AT, '11', 'setMark', { markId: 'boring', on: true })],
        { marks: table(), ...EMPTY },
      )
      assert.deepEqual(result.archive, [])
    })

    /**
     * A work missing from the index normally means "unknown", never "not saved"
     * — but a scrape that happened *after* the op and doesn't list the work is
     * evidence the archive already agrees, and the request would be spent on
     * nothing.
     */
    test('a work a later scrape no longer lists is marked here and not asked for again', () => {
      const result = replayChanges([readOp], {
        marks: table(),
        applied: new Set(),
        listed: { ids: new Set(['12']), updatedAt: AT + 60_000 },
      })
      assert.deepEqual(result.archive, [])
      assert.equal(result.skipped.length, 1)
      assert.match(result.skipped[0].reason, /no longer on your Marked for Later list/)
      assert.ok(markItems(result.marks, 'boring').has('11'))
    })

    test('an index older than the op says nothing, so the archive is still told', () => {
      const result = replayChanges([readOp], {
        marks: table(),
        applied: new Set(),
        listed: { ids: new Set(['12']), updatedAt: AT - 60_000 },
      })
      assert.deepEqual(result.archive, [{ workId: '11', opId: 'a' }])
      assert.deepEqual(result.skipped, [])
    })

    test('a work the index still lists is told to the archive', () => {
      const result = replayChanges([readOp], {
        marks: table(),
        applied: new Set(),
        listed: { ids: new Set(['11']), updatedAt: AT + 60_000 },
      })
      assert.deepEqual(result.archive, [{ workId: '11', opId: 'a' }])
    })
  })
})
