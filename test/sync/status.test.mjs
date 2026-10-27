import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SYNC_CONSISTENCY_WAIT_MS } from '../../src/common/constants.ts'
import { pullLossParts } from '../../src/common/syncGuard.ts'
import { HELD_BACKUP_NOTE, staleBackgroundMessage, versionPauseReason } from '../../src/common/syncMessages.ts'
import { formatMoment } from '../../src/options_ui/model/moments.ts'
import { sentence } from '../../src/options_ui/model/phrases.ts'
import { NOT_SYNCED_YET, syncStatusView, YOURS } from '../../src/options_ui/model/syncStatus.ts'

/** This browser's sync version. */
const V = 7
const AT = new Date(2026, 9, 3, 18, 4).getTime()

const ON = { enabled: true, pause: null, lastError: '', lastSyncAt: AT, staleBuild: false, backgroundOutdated: false, refusal: '' }
const OFF = { ...ON, enabled: false }

const SYNCING = { state: 'syncing', severity: 'success' }
const OFF_CHIP = { state: 'off', severity: 'neutral' }
const ERROR_CHIP = { state: 'error', severity: 'destructive' }
const RELOAD = { state: 'stale', severity: 'destructive' }

/** What a chip is about, and how severe it is: what it says of it is its own. */
const chipOf = view => view.chip && { state: view.chip.state, severity: view.chip.severity }

/** Whether `lastSynced` says when sync last succeeded. */
const saysWhen = lastSynced => lastSynced.includes(formatMoment(AT))

const OVERHEAD = 300
/** Synced storage `percent` full of a 100 KB room, past the format's fixed overhead. */
function usage(percent) {
  return { used: OVERHEAD + percent * 1024, quota: OVERHEAD + 100 * 1024, overheadBytes: OVERHEAD }
}

/** The usage bar's figures, as numbers: kilobytes used and of how many, the percentage, the level, and whether it advises. */
const figures = ({ usedKb, maxKb, pct, level, advice }) => ({ used: Number.parseFloat(usedKb), max: Number.parseFloat(maxKb), pct, level, advice: !!advice })

const HEALTHY_USAGE = { used: 68, max: 100, pct: 68, level: 'success', advice: false }

const none = { removed: 0, of: 0 }
const LOSS = { rules: { removed: 18, of: 22 }, markedWorks: { removed: 204, of: 374 }, textReplacements: none, trackedLists: { removed: 5, of: 7 }, marks: ['Favorite', 'Ongoing'] }
const HELD = { reason: 'held', g: 5, w: 'desktop.x', at: 0, backedUp: true, backupFailed: false, loss: LOSS }

/** What a held update's answer `choice` says it does. */
const consequence = (decision, choice) => decision.answers.find(answer => answer.choice === choice).consequence

/** What an answer says of this browser's settings being backed up: `backedUp`, `failed`, or null for nothing. */
function saysOfYours(text) {
  if (text.includes(YOURS.backedUp))
    return 'backedUp'
  return text.includes(YOURS.failed) ? 'failed' : null
}

const REFUSAL = `Can't turn on sync: your synced settings need a newer version of AO3 Enhancements (sync version 9; this browser has ${V}). Update or reload the extension first.`

describe('syncStatusView', () => {
  describe('off', () => {
    test('is the switch alone', () => {
      assert.deepEqual(syncStatusView({ ...OFF, usage: usage(68) }, V), { callouts: [] })
    })

    test('says nothing of an error left from while it was on', () => {
      assert.deepEqual(syncStatusView({ ...OFF, lastError: 'QUOTA_BYTES quota exceeded' }, V), { callouts: [] })
    })

    test('refused: the switch stays off and says why', () => {
      const view = syncStatusView({ ...OFF, refusal: REFUSAL, usage: usage(68) }, V)
      assert.deepEqual(chipOf(view), OFF_CHIP)
      assert.deepEqual(view.callouts, [{ state: 'refusal', severity: 'destructive', text: REFUSAL, hook: { 'data-sync-refusal': '' } }])
      assert.equal('usage' in view, false)
    })

    test('still calls out a stale background, under an Off chip', () => {
      const view = syncStatusView({ ...OFF, staleBuild: true }, V)
      assert.deepEqual(chipOf(view), OFF_CHIP)
      assert.deepEqual(view.callouts.map(c => [c.state, c.hook]), [['stale', { 'data-sync-stale': '' }]])
    })
  })

  describe('on', () => {
    test('healthy: syncing, when it last synced, and how full the synced storage is', () => {
      const view = syncStatusView({ ...ON, usage: usage(68) }, V)
      assert.deepEqual(chipOf(view), SYNCING)
      assert.ok(saysWhen(view.lastSynced))
      assert.deepEqual(view.callouts, [])
      assert.deepEqual(figures(view.usage), HEALTHY_USAGE)
    })

    test('before its first sync, says it hasn\'t synced yet', () => {
      assert.equal(syncStatusView({ ...ON, lastSyncAt: 0 }, V).lastSynced, NOT_SYNCED_YET)
    })

    test('no usage bar until the usage is known', () => {
      assert.equal('usage' in syncStatusView(ON, V), false)
      assert.equal('usage' in syncStatusView({ ...ON, usage: null }, V), false)
    })

    test('a failed sync: the error takes the place of when it last synced', () => {
      const view = syncStatusView({ ...ON, lastError: 'QUOTA_BYTES quota exceeded', usage: usage(68) }, V)
      assert.deepEqual(chipOf(view), ERROR_CHIP)
      assert.equal('lastSynced' in view, false)
      assert.deepEqual(view.callouts, [{ state: 'error', severity: 'destructive', text: 'QUOTA_BYTES quota exceeded', hook: { 'data-sync-error': '' } }])
      assert.deepEqual(figures(view.usage), HEALTHY_USAGE)
    })

    test('a stray refusal is not shown once the switch is on', () => {
      assert.deepEqual(syncStatusView({ ...ON, refusal: REFUSAL }, V).callouts, [])
    })
  })

  describe('usage', () => {
    test('turns warning at 70%, and destructive with advice at 90%, leaving the chip alone', () => {
      const cases = [[69, 'success'], [70, 'warning'], [89, 'warning'], [90, 'destructive'], [94, 'destructive']]
      for (const [percent, level] of cases) {
        const view = syncStatusView({ ...ON, usage: usage(percent) }, V)
        assert.equal(view.usage.pct, percent)
        assert.equal(view.usage.level, level, `${percent}%`)
        assert.equal(!!view.usage.advice, percent >= 90, `${percent}%`)
        assert.deepEqual(chipOf(view), SYNCING, `${percent}%`)
        assert.deepEqual(view.callouts, [], `${percent}%`)
      }
    })

    test('judges the figure it shows, rounded', () => {
      const view = syncStatusView({ ...ON, usage: usage(69.5) }, V)
      assert.equal(view.usage.pct, 70)
      assert.equal(view.usage.level, 'warning')
      assert.equal(figures(view.usage).used, 69.5)
    })

    test('leaves the format\'s overhead out, and stays within the bar', () => {
      assert.deepEqual(figures(syncStatusView({ ...ON, usage: { used: 100, quota: 2048 + OVERHEAD, overheadBytes: OVERHEAD } }, V).usage), { used: 0, max: 2, pct: 0, level: 'success', advice: false })
      const over = syncStatusView({ ...ON, usage: { used: OVERHEAD + 4096, quota: OVERHEAD + 2048, overheadBytes: OVERHEAD } }, V).usage
      assert.equal(over.pct, 100)
      assert.equal(over.level, 'destructive')
      const noRoom = syncStatusView({ ...ON, usage: { used: OVERHEAD, quota: OVERHEAD, overheadBytes: OVERHEAD } }, V).usage
      assert.equal(noRoom.pct, 0)
    })
  })

  describe('held', () => {
    test('asks: the losses one per line, the backup, and two answers with their consequences', () => {
      const view = syncStatusView({ ...ON, pause: HELD, usage: usage(68) }, V)
      assert.deepEqual(chipOf(view), { state: 'held', severity: 'warning' })
      assert.ok(view.chip.detail, 'the chip says what is waiting')
      assert.ok(saysWhen(view.lastSynced))
      assert.deepEqual(figures(view.usage), HEALTHY_USAGE)
      assert.equal(view.callouts.length, 1)
      const [callout] = view.callouts
      assert.deepEqual([callout.state, callout.severity, callout.hook], ['held', 'warning', { 'data-sync-pause': 'held' }])
      assert.ok(callout.text)
      assert.deepEqual(callout.decision.lines, pullLossParts(LOSS))
      assert.equal(callout.decision.backup, HELD_BACKUP_NOTE)
      assert.deepEqual(callout.decision.answers.map(answer => answer.choice), ['keep', 'accept'])
      for (const answer of callout.decision.answers)
        assert.ok(answer.label && answer.consequence, `${answer.choice} is named, and says what it does`)
      assert.notEqual(consequence(callout.decision, 'keep'), consequence(callout.decision, 'accept'))
    })

    /** In the present tense: a backup that would repeat the newest of its kind isn't written, and that one stands in for it. */
    test('backed up as it was held: accepting says yours are backed up', () => {
      const { decision } = syncStatusView({ ...ON, pause: HELD }, V).callouts[0]
      assert.equal(decision.backup, HELD_BACKUP_NOTE)
      assert.equal(saysOfYours(consequence(decision, 'accept')), 'backedUp')
      assert.equal(saysOfYours(consequence(decision, 'keep')), null)
    })

    test('its backup couldn\'t be written: accepting says yours aren\'t backed up, and why', () => {
      const { decision } = syncStatusView({ ...ON, pause: { ...HELD, backedUp: false, backupFailed: true } }, V).callouts[0]
      const backedUp = syncStatusView({ ...ON, pause: HELD }, V).callouts[0].decision
      assert.equal(decision.backup, null)
      assert.equal(saysOfYours(consequence(decision, 'accept')), 'failed')
      assert.equal(consequence(decision, 'keep'), consequence(backedUp, 'keep'), 'declining always keeps the update')
    })

    /**
     * An older build backed up a hold only with daily backups on, and recorded
     * no failure. Accepting backs this browser's settings up as it applies, so
     * daily backups being off then has no bearing on it.
     */
    test('held by an older build with no backup: accepting says only what it replaces', () => {
      const { backupFailed, ...older } = HELD
      const { decision } = syncStatusView({ ...ON, pause: { ...older, backedUp: false } }, V).callouts[0]
      const backedUp = syncStatusView({ ...ON, pause: HELD }, V).callouts[0].decision
      assert.equal(decision.backup, null)
      assert.equal(saysOfYours(consequence(decision, 'accept')), null)
      assert.ok(consequence(backedUp, 'accept').startsWith(consequence(decision, 'accept')), 'what it replaces, as a hold with a backup says it')
      assert.equal(consequence(decision, 'keep'), consequence(backedUp, 'keep'), 'declining always keeps the update')
    })

    test('reads a loss stored by a build that weighed fewer collections', () => {
      const { trackedLists, ...older } = LOSS
      const { decision } = syncStatusView({ ...ON, pause: { ...HELD, loss: older } }, V).callouts[0]
      assert.deepEqual(decision.lines, pullLossParts(older))
      assert.equal(decision.lines.length, 3)
    })
  })

  /**
   * Sync turned on over a synced copy that differs from this browser's own
   * settings: drawn as a held update is, asking which to keep.
   */
  describe('asked which settings to keep, as sync turns on', () => {
    const FIRST = { reason: 'first-sync', g: 5, w: 'desktop.x', at: 0, backedUp: true, backupFailed: false, loss: null }

    test('asks: the two answers with their consequences, and the backup', () => {
      const view = syncStatusView({ ...ON, lastSyncAt: 0, pause: FIRST, usage: usage(68) }, V)
      assert.deepEqual(chipOf(view), { state: 'first-sync', severity: 'warning' })
      assert.ok(view.chip.detail, 'the chip says what is waiting')
      assert.equal(view.lastSynced, NOT_SYNCED_YET)
      assert.deepEqual(figures(view.usage), HEALTHY_USAGE)
      assert.equal(view.callouts.length, 1)
      const [callout] = view.callouts
      assert.deepEqual([callout.state, callout.severity, callout.hook], ['first-sync', 'warning', { 'data-sync-pause': 'first-sync' }])
      assert.ok(callout.text)
      assert.deepEqual(callout.decision.lines, [])
      assert.equal(callout.decision.backup, HELD_BACKUP_NOTE)
      assert.deepEqual(callout.decision.answers.map(answer => answer.choice), ['keep', 'accept'])
      assert.equal(saysOfYours(consequence(callout.decision, 'accept')), 'backedUp')
      assert.equal(saysOfYours(consequence(callout.decision, 'keep')), null)
    })

    test('where the deletion guard would hold the synced settings, says what using them would remove', () => {
      const asked = syncStatusView({ ...ON, pause: FIRST }, V).callouts[0]
      const { text, decision } = syncStatusView({ ...ON, pause: { ...FIRST, loss: LOSS } }, V).callouts[0]
      assert.notEqual(text, asked.text, 'it leads into the losses rather than asking')
      assert.deepEqual(decision.lines, pullLossParts(LOSS))
      assert.deepEqual(decision.answers.map(answer => answer.choice), ['keep', 'accept'])
    })

    test('its backup couldn\'t be written: using the synced settings says yours aren\'t backed up, and why', () => {
      const { decision } = syncStatusView({ ...ON, pause: { ...FIRST, backedUp: false, backupFailed: true } }, V).callouts[0]
      const backedUp = syncStatusView({ ...ON, pause: FIRST }, V).callouts[0].decision
      assert.equal(decision.backup, null)
      assert.equal(saysOfYours(consequence(decision, 'accept')), 'failed')
      assert.equal(consequence(decision, 'keep'), consequence(backedUp, 'keep'), 'keeping this browser\'s always keeps the synced settings')
    })

    test('says nothing once sync is off', () => {
      assert.deepEqual(syncStatusView({ ...OFF, pause: FIRST }, V), { callouts: [] })
    })

    /** The same question, asked while sync was on, over a synced copy another browser started. */
    test('asked over a copy another browser started: the same question, the chip saying where the settings came from', () => {
      const view = syncStatusView({ ...ON, pause: { ...FIRST, otherCopy: true } }, V)
      const own = syncStatusView({ ...ON, pause: FIRST }, V)
      assert.deepEqual(chipOf(view), { state: 'first-sync', severity: 'warning' })
      assert.notEqual(view.chip.detail, own.chip.detail)
      assert.deepEqual(view.callouts, own.callouts)
    })
  })

  /**
   * A synced copy this browser can't read whole, still so past the wait: no
   * other browser is taken to be sending the rest any more.
   */
  describe('synced settings that can\'t be read whole', () => {
    const MINUTES = SYNC_CONSISTENCY_WAIT_MS / 60_000
    const SINCE = AT - SYNC_CONSISTENCY_WAIT_MS
    const OVERDUE = { since: SINCE, overdue: true, replaceable: true }
    const CHIP = { state: 'inconsistent', severity: 'destructive' }
    const HOOK = { 'data-sync-inconsistent': '' }

    test('past the wait: says they are inconsistent, and offers to replace them with this browser\'s settings', () => {
      const view = syncStatusView({ ...ON, inconsistent: OVERDUE, usage: usage(68) }, V)
      assert.deepEqual(chipOf(view), CHIP)
      assert.ok(saysWhen(view.lastSynced))
      assert.deepEqual(figures(view.usage), HEALTHY_USAGE)
      assert.equal(view.callouts.length, 1)
      const [callout] = view.callouts
      assert.deepEqual([callout.state, callout.severity, callout.hook], ['inconsistent', 'destructive', HOOK])
      assert.match(callout.text, new RegExp(`\\b${MINUTES}\\b`), 'it says how long nothing has come to complete them')
      assert.deepEqual([callout.decision.lines, callout.decision.backup], [[], null])
      assert.deepEqual(callout.decision.answers.map(answer => answer.choice), ['replace'])
      assert.ok(callout.decision.answers[0].label && callout.decision.answers[0].consequence)
    })

    test('where this browser\'s own settings don\'t pass the same check, says so with no offer', () => {
      const view = syncStatusView({ ...ON, inconsistent: { ...OVERDUE, replaceable: false } }, V)
      const offered = syncStatusView({ ...ON, inconsistent: OVERDUE }, V).callouts[0]
      assert.deepEqual(chipOf(view), CHIP)
      assert.deepEqual(view.callouts, [{ state: 'inconsistent', severity: 'destructive', text: offered.text, hook: HOOK }])
    })

    test('within the wait says nothing: another browser may still be sending them', () => {
      assert.deepEqual(syncStatusView({ ...ON, inconsistent: { since: AT, overdue: false, replaceable: false } }, V), syncStatusView(ON, V))
    })

    test('says nothing once sync is off', () => {
      assert.deepEqual(syncStatusView({ ...OFF, inconsistent: OVERDUE }, V), { callouts: [] })
    })

    test('stacks after a stale background and before an error and a question, and the chip names it over the error', () => {
      const view = syncStatusView({ ...ON, inconsistent: OVERDUE, lastError: 'QUOTA_BYTES quota exceeded', pause: HELD }, V)
      assert.deepEqual(chipOf(view), CHIP)
      assert.deepEqual(view.callouts.map(c => c.state), ['inconsistent', 'error', 'held'])
      assert.deepEqual(syncStatusView({ ...ON, inconsistent: OVERDUE, staleBuild: true }, V).callouts.map(c => c.state), ['stale', 'inconsistent'])
    })
  })

  describe('version pauses', () => {
    for (const [reason, remoteVersion] of [['newer-version', 9], ['older-cloud', 5]]) {
      test(`${reason}: paused, saying why and what lifts it`, () => {
        const pause = { reason, remoteVersion }
        const view = syncStatusView({ ...ON, pause }, V)
        assert.deepEqual(chipOf(view), { state: reason, severity: 'warning' })
        assert.ok(view.chip.detail, 'the chip says which side is behind')
        assert.ok(saysWhen(view.lastSynced))
        assert.deepEqual(view.callouts, [{
          state: reason,
          severity: 'warning',
          text: sentence(versionPauseReason(pause, V)),
          hook: { 'data-sync-pause': reason },
        }])
      })
    }

    test('the chip says which side is behind', () => {
      const detail = reason => syncStatusView({ ...ON, pause: { reason, remoteVersion: 9 } }, V).chip.detail
      assert.notEqual(detail('newer-version'), detail('older-cloud'))
    })
  })

  describe('an out-of-date background', () => {
    test('found stale by the background: reload needed, and sync is paused', () => {
      const view = syncStatusView({ ...ON, staleBuild: true }, V)
      assert.deepEqual(chipOf(view), RELOAD)
      assert.ok(saysWhen(view.lastSynced))
      assert.deepEqual(view.callouts, [{ state: 'stale', severity: 'destructive', text: staleBackgroundMessage(true), hook: { 'data-sync-stale': '' } }])
    })

    test('suspected by the page: reload needed, and sync may not work', () => {
      const view = syncStatusView({ ...ON, backgroundOutdated: true }, V)
      assert.deepEqual(chipOf(view), RELOAD)
      assert.deepEqual(view.callouts.map(c => c.text), [staleBackgroundMessage(false)])
    })

    test('both: one callout, the background\'s own finding', () => {
      const view = syncStatusView({ ...ON, staleBuild: true, backgroundOutdated: true }, V)
      assert.deepEqual(view.callouts.map(c => c.text), [staleBackgroundMessage(true)])
    })
  })

  describe('states stack', () => {
    test('the chip takes the most severe; the callouts follow in severity order', () => {
      const view = syncStatusView({ ...ON, pause: { reason: 'newer-version', remoteVersion: 9 }, lastError: 'QUOTA_BYTES quota exceeded', usage: usage(94) }, V)
      assert.deepEqual(chipOf(view), ERROR_CHIP)
      assert.equal('lastSynced' in view, false)
      assert.deepEqual(view.callouts.map(c => [c.severity, c.hook]), [
        ['destructive', { 'data-sync-error': '' }],
        ['warning', { 'data-sync-pause': 'newer-version' }],
      ])
      assert.equal(view.usage.level, 'destructive')
      assert.ok(view.usage.advice)
    })

    test('a stale background comes before an error, and both before a hold', () => {
      const view = syncStatusView({ ...ON, pause: HELD, lastError: 'QUOTA_BYTES quota exceeded', staleBuild: true }, V)
      assert.deepEqual(chipOf(view), RELOAD)
      assert.deepEqual(view.callouts.map(c => c.state), ['stale', 'error', 'held'])
      assert.deepEqual(view.callouts.map(c => c.hook), [{ 'data-sync-stale': '' }, { 'data-sync-error': '' }, { 'data-sync-pause': 'held' }])
    })

    test('a refusal and a stale background, while off', () => {
      const view = syncStatusView({ ...OFF, refusal: REFUSAL, backgroundOutdated: true }, V)
      assert.deepEqual(chipOf(view), OFF_CHIP)
      assert.deepEqual(view.callouts.map(c => c.state), ['stale', 'refusal'])
    })
  })
})
