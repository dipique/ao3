import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { LOCAL_ONLY } from '../../src/common/syncCodec.ts'
import { rowSyncs } from '../../src/options_ui/model/rowSync.ts'

describe('rowSyncs', () => {
  test('a row editing an option that syncs, syncs', () => {
    assert.equal(rowSyncs(['showTotalTime']), true)
  })

  test('a row editing only options kept on this device does not', () => {
    assert.ok(LOCAL_ONLY.has('verbose'))
    assert.equal(rowSyncs(['verbose']), false)
  })

  test('a row editing one option of each kind syncs', () => {
    assert.equal(rowSyncs(['user', 'rules']), true)
  })

  test('a row editing no option does not', () => {
    assert.equal(rowSyncs([]), false)
  })

  test('a row badged as working on this device alone does not, whatever it edits', () => {
    assert.equal(rowSyncs(['readerMode'], ['this-device']), false)
    assert.equal(rowSyncs(['showTotalTime'], ['needs-login']), true)
  })
})
