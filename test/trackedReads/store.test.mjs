import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { READ_RECORD_PREFIX, readRecordKey } from '../../src/common/trackedReads.ts'

describe('where records are kept', () => {
  test('one key per list, under the records’ prefix', () => {
    assert.equal(readRecordKey('abc123'), 'trackedRead.abc123')
    assert.ok(readRecordKey('x').startsWith(READ_RECORD_PREFIX))
  })
})
