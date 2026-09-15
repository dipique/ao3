import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { syncPauseMessage, syncRefusalMessage } from '../../src/common/syncMessages.ts'

describe('sync messages', () => {
  test('a held update says what it would remove, and whether a backup exists', () => {
    const loss = { rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: { removed: 0, of: 26 }, marks: [] }
    const held = { reason: 'held', g: 5, w: 'x', loss, at: 0, backedUp: true }
    assert.equal(
      syncPauseMessage(held, 2),
      'Sync is on hold: an update from another browser would remove 348 of your 348 rules and 267 of your 282 marked works. A backup of this browser\'s settings was saved first.',
    )
    assert.doesNotMatch(syncPauseMessage({ ...held, backedUp: false }, 2), /backup/)
  })

  test('version pauses name both versions', () => {
    assert.match(syncPauseMessage({ reason: 'newer-version', remoteVersion: 3 }, 2), /newer version.*sync version 3; this browser has 2\)/)
    assert.match(syncPauseMessage({ reason: 'older-cloud', remoteVersion: 1 }, 2), /^Waiting for an up-to-date browser: .*sync version 1; this browser has 2\)/)
    assert.match(syncRefusalMessage({ ok: false, reason: 'newer-version', remoteVersion: 3, version: 2 }), /^Can't turn on sync: .*sync version 3; this browser has 2\)/)
  })
})
