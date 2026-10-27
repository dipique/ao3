import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { describePullLoss } from '../../src/common/syncGuard.ts'
import { answerRefusedMessage, HELD_BACKUP_NOTE, staleBackgroundMessage, syncPauseMessage, syncRefusalMessage } from '../../src/common/syncMessages.ts'

/** Whether `text` gives the number `n` as a number of its own. */
const gives = (text, n) => new RegExp(`(?<![\\d.])${n}(?![\\d.])`).test(text)

describe('sync messages', () => {
  test('a held update says what it would remove, and whether a backup exists', () => {
    const loss = { rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: { removed: 0, of: 26 }, marks: [] }
    const held = { reason: 'held', g: 5, w: 'x', loss, at: 0, backedUp: true }
    assert.ok(syncPauseMessage(held, 2).includes(describePullLoss(loss)), 'it says what the update would remove')
    assert.ok(syncPauseMessage(held, 2).includes(HELD_BACKUP_NOTE))
    assert.ok(!syncPauseMessage({ ...held, backedUp: false }, 2).includes(HELD_BACKUP_NOTE))
  })

  test('a question as sync turns on says whether a backup exists', () => {
    const first = { reason: 'first-sync', g: 5, w: 'x', at: 0, backedUp: true, backupFailed: false, loss: null }
    assert.ok(syncPauseMessage(first, 2).includes(HELD_BACKUP_NOTE))
    assert.ok(!syncPauseMessage({ ...first, backedUp: false, backupFailed: true }, 2).includes(HELD_BACKUP_NOTE))
    assert.equal(syncPauseMessage({ ...first, otherCopy: true }, 2), syncPauseMessage(first, 2), 'asked over a copy another browser started, the same')
  })

  /**
   * Keeping this browser's settings backs the synced ones up first, and using
   * the synced settings applies them, which a copy that can't be read whole
   * allows neither. Using the synced settings, or accepting a held update,
   * backs this browser's settings up as it replaces them; where that backup,
   * or the day's, can't be saved, the first press is refused, and a second
   * applies.
   */
  test('an answer refused says why: each reason its own, and over inconsistent settings, what the answer needed of them', () => {
    const said = {
      sendingKeep: answerRefusedMessage('sending', 'keep'),
      sendingAccept: answerRefusedMessage('sending', 'accept'),
      inconsistentKeep: answerRefusedMessage('inconsistent', 'keep'),
      inconsistentAccept: answerRefusedMessage('inconsistent', 'accept'),
      unbacked: answerRefusedMessage('unbacked', 'accept'),
    }
    for (const [which, text] of Object.entries(said))
      assert.ok(text, which)
    assert.equal(said.sendingKeep, said.sendingAccept, 'still being sent, whichever was pressed')
    const distinct = [said.sendingKeep, said.inconsistentKeep, said.inconsistentAccept, said.unbacked]
    assert.equal(new Set(distinct).size, distinct.length)
  })

  test('an out-of-date background says whether sync has stopped', () => {
    assert.ok(staleBackgroundMessage(true))
    assert.ok(staleBackgroundMessage(false))
    assert.notEqual(staleBackgroundMessage(true), staleBackgroundMessage(false))
  })

  test('version pauses name both versions', () => {
    const cases = {
      newer: syncPauseMessage({ reason: 'newer-version', remoteVersion: 9 }, 7),
      older: syncPauseMessage({ reason: 'older-cloud', remoteVersion: 5 }, 7),
      refused: syncRefusalMessage({ ok: false, reason: 'newer-version', remoteVersion: 9, version: 7 }),
    }
    assert.ok(gives(cases.newer, 9) && gives(cases.newer, 7), cases.newer)
    assert.ok(gives(cases.older, 5) && gives(cases.older, 7), cases.older)
    assert.ok(gives(cases.refused, 9) && gives(cases.refused, 7), cases.refused)
    assert.notEqual(syncPauseMessage({ reason: 'newer-version', remoteVersion: 5 }, 7), cases.older, 'a newer and an older copy are told apart')
  })
})
