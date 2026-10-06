import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { syncStatusView } from '../../src/options_ui/model/syncStatus.ts'

/** This browser's sync version. */
const V = 7
const AT = new Date(2026, 9, 3, 18, 4).getTime()
const LAST_SYNCED = `Last synced ${new Date(AT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`

const ON = { enabled: true, pause: null, lastError: '', lastSyncAt: AT, staleBuild: false, backgroundOutdated: false, refusal: '' }
const OFF = { ...ON, enabled: false }

const SYNCING = { state: 'syncing', word: 'Syncing', severity: 'success' }
const OFF_CHIP = { state: 'off', word: 'Off', severity: 'neutral' }
const ERROR_CHIP = { state: 'error', word: 'Couldn\'t sync', detail: 'It will be tried again.', severity: 'destructive' }
const RELOAD = { state: 'stale', word: 'Reload needed', severity: 'destructive' }

const OVERHEAD = 300
/** Synced storage `percent` full of a 100 KB room, past the format's fixed overhead. */
function usage(percent) {
  return { used: OVERHEAD + percent * 1024, quota: OVERHEAD + 100 * 1024, overheadBytes: OVERHEAD }
}

const HEALTHY_USAGE = { usedKb: '68.0 KB', maxKb: '100.0 KB', pct: 68, level: 'success' }
const ADVICE = 'You\'re close to the sync storage limit. Reduce large filter lists or text replacements.'

const none = { removed: 0, of: 0 }
const LOSS = { rules: { removed: 18, of: 22 }, markedWorks: { removed: 204, of: 374 }, textReplacements: none, trackedLists: { removed: 5, of: 7 }, marks: ['Favorite', 'Ongoing'] }
const HELD = { reason: 'held', g: 5, w: 'desktop.x', at: 0, backedUp: true, loss: LOSS }

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
      assert.deepEqual(syncStatusView({ ...OFF, refusal: REFUSAL, usage: usage(68) }, V), {
        chip: OFF_CHIP,
        callouts: [{ state: 'refusal', severity: 'destructive', text: REFUSAL, hook: { 'data-sync-refusal': '' } }],
      })
    })

    test('still calls out a stale background, under an Off chip', () => {
      const view = syncStatusView({ ...OFF, staleBuild: true }, V)
      assert.deepEqual(view.chip, OFF_CHIP)
      assert.deepEqual(view.callouts.map(c => [c.state, c.hook]), [['stale', { 'data-sync-stale': '' }]])
    })
  })

  describe('on', () => {
    test('healthy: syncing, when it last synced, and how full the synced storage is', () => {
      assert.deepEqual(syncStatusView({ ...ON, usage: usage(68) }, V), {
        chip: SYNCING,
        lastSynced: LAST_SYNCED,
        callouts: [],
        usage: HEALTHY_USAGE,
      })
    })

    test('before its first sync, says it hasn\'t synced yet', () => {
      assert.equal(syncStatusView({ ...ON, lastSyncAt: 0 }, V).lastSynced, 'Not synced yet')
    })

    test('no usage bar until the usage is known', () => {
      assert.equal('usage' in syncStatusView(ON, V), false)
      assert.equal('usage' in syncStatusView({ ...ON, usage: null }, V), false)
    })

    test('a failed sync: the error takes the place of when it last synced', () => {
      assert.deepEqual(syncStatusView({ ...ON, lastError: 'QUOTA_BYTES quota exceeded', usage: usage(68) }, V), {
        chip: ERROR_CHIP,
        callouts: [{ state: 'error', severity: 'destructive', text: 'QUOTA_BYTES quota exceeded', hook: { 'data-sync-error': '' } }],
        usage: HEALTHY_USAGE,
      })
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
        assert.equal(view.usage.advice, percent >= 90 ? ADVICE : undefined, `${percent}%`)
        assert.deepEqual(view.chip, SYNCING, `${percent}%`)
        assert.deepEqual(view.callouts, [], `${percent}%`)
      }
    })

    test('judges the figure it shows, rounded', () => {
      const view = syncStatusView({ ...ON, usage: usage(69.5) }, V)
      assert.equal(view.usage.pct, 70)
      assert.equal(view.usage.level, 'warning')
      assert.equal(view.usage.usedKb, '69.5 KB')
    })

    test('leaves the format\'s overhead out, and stays within the bar', () => {
      assert.deepEqual(syncStatusView({ ...ON, usage: { used: 100, quota: 2048 + OVERHEAD, overheadBytes: OVERHEAD } }, V).usage, { usedKb: '0.0 KB', maxKb: '2.0 KB', pct: 0, level: 'success' })
      const over = syncStatusView({ ...ON, usage: { used: OVERHEAD + 4096, quota: OVERHEAD + 2048, overheadBytes: OVERHEAD } }, V).usage
      assert.equal(over.pct, 100)
      assert.equal(over.level, 'destructive')
      const noRoom = syncStatusView({ ...ON, usage: { used: OVERHEAD, quota: OVERHEAD, overheadBytes: OVERHEAD } }, V).usage
      assert.equal(noRoom.pct, 0)
    })
  })

  describe('held', () => {
    test('asks: the losses one per line, the backup, and two answers with their consequences', () => {
      assert.deepEqual(syncStatusView({ ...ON, pause: HELD, usage: usage(68) }, V), {
        chip: { state: 'held', word: 'On hold', detail: 'An update from another browser is waiting for your answer.', severity: 'warning' },
        lastSynced: LAST_SYNCED,
        callouts: [{
          state: 'held',
          severity: 'warning',
          text: 'An update from another browser would remove:',
          hook: { 'data-sync-pause': 'held' },
          decision: {
            lines: ['18 of your 22 rules', '204 of your 374 marked works', '5 of your 7 tracked lists (they stay saved on this browser if you keep a copy)', 'the marks “Favorite”, “Ongoing”'],
            backup: 'A backup of this browser\'s settings was saved first.',
            answers: [
              { choice: 'keep', label: 'Keep this browser\'s settings', consequence: 'Sends this browser\'s settings to your other browsers. What the update had is kept as a backup first.' },
              { choice: 'accept', label: 'Accept the update', consequence: 'Replaces this browser\'s settings with the other browser\'s. Yours were backed up when sync held.' },
            ],
          },
        }],
        usage: HEALTHY_USAGE,
      })
    })

    test('without a backup, claims none', () => {
      const { decision } = syncStatusView({ ...ON, pause: { ...HELD, backedUp: false } }, V).callouts[0]
      assert.equal(decision.backup, null)
      const accept = decision.answers.find(answer => answer.choice === 'accept')
      assert.equal(accept.consequence, 'Replaces this browser\'s settings with the other browser\'s.')
      assert.match(decision.answers.find(answer => answer.choice === 'keep').consequence, /kept as a backup first/, 'declining always keeps the update')
    })

    test('reads a loss stored by a build that weighed fewer collections', () => {
      const { trackedLists, ...older } = LOSS
      const { decision } = syncStatusView({ ...ON, pause: { ...HELD, loss: older } }, V).callouts[0]
      assert.deepEqual(decision.lines, ['18 of your 22 rules', '204 of your 374 marked works', 'the marks “Favorite”, “Ongoing”'])
    })
  })

  describe('version pauses', () => {
    test('the cloud newer: paused until this browser is updated', () => {
      const view = syncStatusView({ ...ON, pause: { reason: 'newer-version', remoteVersion: 9 } }, V)
      assert.deepEqual(view.chip, { state: 'newer-version', word: 'Paused', detail: 'This browser is older than your synced settings. It lifts by itself once updated.', severity: 'warning' })
      assert.equal(view.lastSynced, LAST_SYNCED)
      assert.deepEqual(view.callouts, [{
        state: 'newer-version',
        severity: 'warning',
        text: `Your synced settings were saved by a newer version of AO3 Enhancements (sync version 9; this browser has ${V}). Update or reload the extension in this browser. Changes you make here won't sync until then.`,
        hook: { 'data-sync-pause': 'newer-version' },
      }])
    })

    test('the cloud older: waiting for a browser at this version', () => {
      const view = syncStatusView({ ...ON, pause: { reason: 'older-cloud', remoteVersion: 5 } }, V)
      assert.deepEqual(view.chip, { state: 'older-cloud', word: 'Waiting', detail: 'Your synced settings are older than this browser.', severity: 'warning' })
      assert.equal(view.lastSynced, LAST_SYNCED)
      assert.deepEqual(view.callouts, [{
        state: 'older-cloud',
        severity: 'warning',
        text: `Your synced settings were saved by an older version of AO3 Enhancements (sync version 5; this browser has ${V}). They'll sync here once a browser running this version saves them.`,
        hook: { 'data-sync-pause': 'older-cloud' },
      }])
    })
  })

  describe('an out-of-date background', () => {
    test('found stale by the background: reload needed, and sync is paused', () => {
      const view = syncStatusView({ ...ON, staleBuild: true }, V)
      assert.deepEqual(view.chip, RELOAD)
      assert.equal(view.lastSynced, LAST_SYNCED)
      assert.equal(view.callouts.length, 1)
      assert.equal(view.callouts[0].state, 'stale')
      assert.equal(view.callouts[0].severity, 'destructive')
      assert.deepEqual(view.callouts[0].hook, { 'data-sync-stale': '' })
      assert.match(view.callouts[0].text, /Reload AO3 Enhancements .*Sync is paused until then\.$/)
    })

    test('suspected by the page: reload needed, and sync may not work', () => {
      const view = syncStatusView({ ...ON, backgroundOutdated: true }, V)
      assert.deepEqual(view.chip, RELOAD)
      assert.equal(view.callouts.length, 1)
      assert.match(view.callouts[0].text, /Sync may not work until then\.$/)
    })

    test('both: one callout, the background\'s own finding', () => {
      const view = syncStatusView({ ...ON, staleBuild: true, backgroundOutdated: true }, V)
      assert.equal(view.callouts.length, 1)
      assert.match(view.callouts[0].text, /Sync is paused until then\.$/)
    })
  })

  describe('states stack', () => {
    test('the chip takes the most severe; the callouts follow in severity order', () => {
      const view = syncStatusView({ ...ON, pause: { reason: 'newer-version', remoteVersion: 9 }, lastError: 'QUOTA_BYTES quota exceeded', usage: usage(94) }, V)
      assert.deepEqual(view.chip, ERROR_CHIP)
      assert.equal('lastSynced' in view, false)
      assert.deepEqual(view.callouts.map(c => [c.severity, c.hook]), [
        ['destructive', { 'data-sync-error': '' }],
        ['warning', { 'data-sync-pause': 'newer-version' }],
      ])
      assert.equal(view.usage.level, 'destructive')
      assert.equal(view.usage.advice, ADVICE)
    })

    test('a stale background comes before an error, and both before a hold', () => {
      const view = syncStatusView({ ...ON, pause: HELD, lastError: 'Could not read synced data (incomplete).', staleBuild: true }, V)
      assert.deepEqual(view.chip, RELOAD)
      assert.deepEqual(view.callouts.map(c => c.state), ['stale', 'error', 'held'])
      assert.deepEqual(view.callouts.map(c => c.hook), [{ 'data-sync-stale': '' }, { 'data-sync-error': '' }, { 'data-sync-pause': 'held' }])
    })

    test('a refusal and a stale background, while off', () => {
      const view = syncStatusView({ ...OFF, refusal: REFUSAL, backgroundOutdated: true }, V)
      assert.deepEqual(view.chip, OFF_CHIP)
      assert.deepEqual(view.callouts.map(c => c.state), ['stale', 'refusal'])
    })
  })
})
