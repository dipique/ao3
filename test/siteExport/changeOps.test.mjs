import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; changeOps.ts is pure (its one import is a
// type, which is erased), so it loads with a plain `node --test`.
import {
  CHANGE_SCHEMA_VERSION,
  changeFileName,
  changeOpFor,
  newOpId,
  parseChangeExport,
} from '../../src/content_script/siteExport/changeOps.ts'

const AT = Date.UTC(2026, 8, 7, 12)
const CTX = { id: 'op-1', at: AT, finishesRead: false, listedForLater: false }

/**
 * What a mark made inside an export turns into on its way back to the
 * extension. The shape is the contract between the page that records it and the
 * ingest that replays it, so the interesting cases are the ones where the same
 * gesture means two different things.
 */
describe('siteExport/changeOps', () => {
  test('an ordinary mark is a local op', () => {
    const op = changeOpFor({ workId: '11', markId: 'favorite', on: true, via: 'mark' }, CTX)
    assert.deepEqual(op, {
      id: 'op-1',
      at: AT,
      workId: '11',
      op: 'setMark',
      payload: { markId: 'favorite', on: true },
    })
  })

  test('clearing a mark travels as the same op, the other way', () => {
    const op = changeOpFor({ workId: '11', markId: 'favorite', on: false, via: 'mark' }, CTX)
    assert.equal(op.op, 'setMark')
    assert.equal(op.payload.on, false)
  })

  /**
   * The one op with a side beyond this device. It takes *both* halves: a mark
   * that leaves the work done with, and a list AO3 itself holds — either alone
   * is a mark we have no reason to think the archive cares about.
   */
  test('finishing a work on a Marked for Later list is an op AO3 has to hear about', () => {
    const write = { workId: '11', markId: 'boring', on: true, via: 'mark' }
    assert.equal(changeOpFor(write, { ...CTX, finishesRead: true, listedForLater: true }).op, 'markAsRead')
    assert.equal(changeOpFor(write, { ...CTX, finishesRead: true, listedForLater: false }).op, 'setMark')
    assert.equal(changeOpFor(write, { ...CTX, finishesRead: false, listedForLater: true }).op, 'setMark')
  })

  /**
   * A disposition is not a choice: replayed, it has to leave a finer mark in the
   * same group standing, which is a different writer at the other end.
   */
  test('a group write says so, whichever op it becomes', () => {
    const write = { workId: '11', markId: 'read', on: true, via: 'group' }
    assert.deepEqual(changeOpFor(write, CTX).payload, { markId: 'read', on: true, group: true })
    const finished = changeOpFor(write, { ...CTX, finishesRead: true, listedForLater: true })
    assert.equal(finished.op, 'markAsRead')
    assert.equal(finished.payload.group, true)
  })

  test('progress carries where the reader stopped, and nothing it does not have', () => {
    const bare = changeOpFor(
      { workId: '11', markId: 'continue', on: true, via: 'progress', progress: { chapter: 4 } },
      { ...CTX, finishesRead: false },
    )
    assert.equal(bare.op, 'setProgress')
    assert.deepEqual(bare.payload, { markId: 'continue', on: true, progress: { chapter: 4 } })
    assert.ok(!('waitUntil' in bare.payload.progress), 'an absent wait should not travel as undefined')

    const waiting = changeOpFor(
      { workId: '11', markId: 'continue', on: true, via: 'progress', progress: { chapter: 4, waitUntil: 20700 } },
      CTX,
    )
    assert.deepEqual(waiting.payload.progress, { chapter: 4, waitUntil: 20700 })
  })

  /**
   * The progress mark sits in the read group meaning the opposite of it, so it
   * must never become the op that takes a work off the reader's list — even when
   * the caller says the write finishes the group.
   */
  test('progress is never an AO3 act', () => {
    const op = changeOpFor(
      { workId: '11', markId: 'continue', on: true, via: 'progress', progress: { chapter: 1 } },
      { ...CTX, finishesRead: true, listedForLater: true },
    )
    assert.equal(op.op, 'setProgress')
  })

  test('op ids are the idempotency key, so they do not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newOpId()))
    assert.equal(ids.size, 500)
    for (const id of ids)
      assert.ok(id.length > 8, `${id} is too short to be unique by accident`)
  })

  test('the schema has a version of its own', () => {
    assert.equal(CHANGE_SCHEMA_VERSION, 1)
  })
})

/** One well-formed op, to vary from. */
const OP = { id: 'op-1', at: AT, workId: '11', op: 'setMark', payload: { markId: 'favorite', on: true } }

/** The file the exported page writes and the options page reads. */
const FILE = { v: CHANGE_SCHEMA_VERSION, sourceId: 'marked-for-later', exportedAt: AT, ops: [OP] }

describe('siteExport/changeOps — the file', () => {
  test('names itself for the list and the moment', () => {
    const name = changeFileName('marked-for-later', new Date(Date.UTC(2026, 8, 7, 14, 51, 2)))
    assert.equal(name, 'ao3e-changes-marked-for-later-2026-09-07_14-51-02.json')
  })

  test('keeps a filename usable whatever the list was called', () => {
    const name = changeFileName('tag-works:Steve Rogers/Bucky Barnes', new Date(AT))
    assert.doesNotMatch(name, /[^\w\-.]/, 'nothing here should need escaping to type or tap')
    assert.match(changeFileName('///', new Date(AT)), /^ao3e-changes-export-/)
  })

  test('round-trips what the page wrote', () => {
    const { file, unreadable } = parseChangeExport(JSON.stringify(FILE))
    assert.deepEqual(file, FILE)
    assert.equal(unreadable, 0)
  })

  /**
   * The envelope is refused whole and the ops one at a time, on purpose: a file
   * that isn't ours can only be guessed at, while one corrupt op is no reason to
   * drop an afternoon's marking.
   */
  test('refuses a file it cannot vouch for', () => {
    assert.throws(() => parseChangeExport('not json'), /readable as JSON/)
    assert.throws(() => parseChangeExport('{"ops":[]}'), /exported site/)
    assert.throws(() => parseChangeExport(JSON.stringify({ ...FILE, ops: undefined })), /exported site/)
    assert.throws(
      () => parseChangeExport(JSON.stringify({ ...FILE, v: CHANGE_SCHEMA_VERSION + 1 })),
      /newer version/,
    )
  })

  test('counts the ops it cannot read rather than losing the rest', () => {
    const { file, unreadable } = parseChangeExport(JSON.stringify({
      ...FILE,
      ops: [
        OP,
        { ...OP, id: 'op-2', op: 'setEverything' },
        { ...OP, id: 'op-3', at: 'yesterday' },
        { ...OP, id: 'op-4', payload: { markId: 'favorite' } },
        { ...OP, id: 'op-5', payload: { markId: 'continue', on: true, progress: { chapter: 'four' } } },
        null,
      ],
    }))
    assert.deepEqual(file.ops.map(op => op.id), ['op-1'])
    assert.equal(unreadable, 5)
  })

  /** An op from a later schema with a field we don't read is still an op. */
  test('an unknown field is not a reason to refuse an op', () => {
    const { file, unreadable } = parseChangeExport(JSON.stringify({
      ...FILE,
      ops: [{ ...OP, source: 'somewhere new' }],
    }))
    assert.equal(unreadable, 0)
    assert.equal(file.ops.length, 1)
  })
})
