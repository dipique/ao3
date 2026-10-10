import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { staleBackgroundMessage, syncPauseMessage, syncRefusalMessage } from '../../src/common/syncMessages.ts'

describe('sync messages', () => {
  test('a held update says what it would remove, and whether a backup exists', () => {
    const loss = { rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: { removed: 0, of: 26 }, marks: [] }
    const held = { reason: 'held', g: 5, w: 'x', loss, at: 0, backedUp: true }
    assert.equal(
      syncPauseMessage(held, 2),
      'Sync is on hold: an update from another browser would remove 348 of your 348 rules and 267 of your 282 marked works. This browser\'s settings are backed up.',
    )
    assert.doesNotMatch(syncPauseMessage({ ...held, backedUp: false }, 2), /backed up/)
  })

  test('a question as sync turns on says nothing changes until it is answered, and whether a backup exists', () => {
    const first = { reason: 'first-sync', g: 5, w: 'x', at: 0, backedUp: true, backupFailed: false, loss: null }
    assert.equal(
      syncPauseMessage(first, 2),
      'Sync is on hold: your synced settings differ from this browser\'s. Nothing changes until you choose which to keep. This browser\'s settings are backed up.',
    )
    assert.doesNotMatch(syncPauseMessage({ ...first, backedUp: false, backupFailed: true }, 2), /backed up/)
    assert.equal(syncPauseMessage({ ...first, otherCopy: true }, 2), syncPauseMessage(first, 2), 'asked over a copy another browser started, the same')
  })

  test('an out-of-date background says whether sync has stopped', () => {
    assert.match(staleBackgroundMessage(true), /Reload AO3 Enhancements .*Sync is paused until then\.$/)
    assert.match(staleBackgroundMessage(false), /Sync may not work until then\.$/)
  })

  test('version pauses name both versions', () => {
    assert.match(syncPauseMessage({ reason: 'newer-version', remoteVersion: 3 }, 2), /newer version.*sync version 3; this browser has 2\)/)
    assert.match(syncPauseMessage({ reason: 'older-cloud', remoteVersion: 1 }, 2), /^Waiting for an up-to-date browser: .*sync version 1; this browser has 2\)/)
    assert.match(syncRefusalMessage({ ok: false, reason: 'newer-version', remoteVersion: 3, version: 2 }), /^Can't turn on sync: .*sync version 3; this browser has 2\)/)
  })

  test('version pauses read in full', () => {
    assert.equal(
      syncPauseMessage({ reason: 'newer-version', remoteVersion: 9 }, 7),
      'Sync is paused: your synced settings were saved by a newer version of AO3 Enhancements (sync version 9; this browser has 7). Update or reload the extension in this browser. Changes you make here won\'t sync until then.',
    )
    assert.equal(
      syncPauseMessage({ reason: 'older-cloud', remoteVersion: 5 }, 7),
      'Waiting for an up-to-date browser: your synced settings were saved by an older version of AO3 Enhancements (sync version 5; this browser has 7). They\'ll sync here once a browser running this version saves them.',
    )
  })
})
