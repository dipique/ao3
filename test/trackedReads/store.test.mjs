import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { packRows, READ_RECORD_PREFIX, readRecordKey, recordedWorkIds, strayRecordKeys } from '../../src/common/trackedReads.ts'

describe('where records are kept', () => {
  test('one key per list, under the records’ prefix', () => {
    assert.equal(readRecordKey('abc123'), 'trackedRead.abc123')
    assert.ok(readRecordKey('x').startsWith(READ_RECORD_PREFIX))
  })
})

describe('recordedWorkIds', () => {
  test('every work any record holds, as decimal work ids, once', () => {
    const a = { rows: packRows([{ sid: '48x79', day: 20000 }, { sid: 'a', day: 20001 }]) }
    const b = { rows: packRows([{ sid: 'a', day: 20003 }]) }
    assert.deepEqual([...recordedWorkIds([a, b])].sort(), ['10', '7134741'])
  })

  test('anything that isn’t a record is passed over', () => {
    assert.deepEqual([...recordedWorkIds([null, 'x', {}, { rows: 3 }])], [])
  })
})

describe('strayRecordKeys', () => {
  test('the records of lists no longer tracked; run again over what is left, nothing', () => {
    const keys = ['trackedRead.a', 'trackedRead.gone', 'trackedRead.b', 'trackedRead.old', 'cache.trackedReview']
    const stray = strayRecordKeys(keys, ['a', 'b'])
    assert.deepEqual(stray, ['trackedRead.gone', 'trackedRead.old'])
    const left = keys.filter(key => !stray.includes(key))
    assert.deepEqual(strayRecordKeys(left, ['a', 'b']), [])
  })
})
