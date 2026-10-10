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
const HELD = { reason: 'held', g: 5, w: 'desktop.x', at: 0, backedUp: true, backupFailed: false, loss: LOSS }
const BACKED_UP = 'A backup of this browser\'s settings was saved first.'
const REPLACES = 'Replaces this browser\'s settings with the other browser\'s.'
const KEEPS = 'Sends this browser\'s settings to your other browsers. What the update had is kept as a backup first.'

/** What a held update's answer `choice` says it does. */
const consequence = (decision, choice) => decision.answers.find(answer => answer.choice === choice).consequence

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

    test('backed up as it was held: accepting points to the backup', () => {
      const { decision } = syncStatusView({ ...ON, pause: HELD }, V).callouts[0]
      assert.equal(decision.backup, BACKED_UP)
      assert.equal(consequence(decision, 'accept'), `${REPLACES} Yours were backed up when sync held.`)
      assert.equal(consequence(decision, 'keep'), KEEPS)
    })

    test('its backup couldn\'t be written: accepting says yours aren\'t backed up, and why', () => {
      const { decision } = syncStatusView({ ...ON, pause: { ...HELD, backedUp: false, backupFailed: true } }, V).callouts[0]
      assert.equal(decision.backup, null)
      assert.equal(consequence(decision, 'accept'), `${REPLACES} Yours aren't backed up: the backup couldn't be saved.`)
      assert.equal(consequence(decision, 'keep'), KEEPS, 'declining always keeps the update')
    })

    /** An older build backed up a hold only with daily backups on, and recorded no failure. */
    test('held by an older build with no backup: accepting says daily backups were off when it held', () => {
      const { backupFailed, ...older } = HELD
      const { decision } = syncStatusView({ ...ON, pause: { ...older, backedUp: false } }, V).callouts[0]
      assert.equal(decision.backup, null)
      assert.equal(consequence(decision, 'accept'), `${REPLACES} Yours aren't backed up: daily backups were off when sync held.`)
      assert.equal(consequence(decision, 'keep'), KEEPS, 'declining always keeps the update')
    })

    test('reads a loss stored by a build that weighed fewer collections', () => {
      const { trackedLists, ...older } = LOSS
      const { decision } = syncStatusView({ ...ON, pause: { ...HELD, loss: older } }, V).callouts[0]
      assert.deepEqual(decision.lines, ['18 of your 22 rules', '204 of your 374 marked works', 'the marks “Favorite”, “Ongoing”'])
    })
  })

  /**
   * Sync turned on over a synced copy that differs from this browser's own
   * settings: drawn as a held update is, asking which to keep.
   */
  describe('asked which settings to keep, as sync turns on', () => {
    const FIRST = { reason: 'first-sync', g: 5, w: 'desktop.x', at: 0, backedUp: true, backupFailed: false, loss: null }
    const USES = 'Replaces this browser\'s settings with your synced settings.'
    const KEEPS_OWN = 'Replaces your synced settings with this browser\'s, on every browser that syncs. The synced settings are kept as a backup first.'

    test('asks: the two answers with their consequences, and the backup', () => {
      assert.deepEqual(syncStatusView({ ...ON, lastSyncAt: 0, pause: FIRST, usage: usage(68) }, V), {
        chip: { state: 'first-sync', word: 'On hold', detail: 'Turning on sync is waiting for your answer.', severity: 'warning' },
        lastSynced: 'Not synced yet',
        callouts: [{
          state: 'first-sync',
          severity: 'warning',
          text: 'Your synced settings differ from this browser\'s. Which do you want to keep?',
          hook: { 'data-sync-pause': 'first-sync' },
          decision: {
            lines: [],
            backup: BACKED_UP,
            answers: [
              { choice: 'keep', label: 'Keep this browser\'s settings', consequence: KEEPS_OWN },
              { choice: 'accept', label: 'Use the synced settings', consequence: `${USES} Yours were backed up first.` },
            ],
          },
        }],
        usage: HEALTHY_USAGE,
      })
    })

    test('where the deletion guard would hold the synced settings, says what using them would remove', () => {
      const { text, decision } = syncStatusView({ ...ON, pause: { ...FIRST, loss: LOSS } }, V).callouts[0]
      assert.equal(text, 'Your synced settings differ from this browser\'s. Using them would remove:')
      assert.deepEqual(decision.lines, ['18 of your 22 rules', '204 of your 374 marked works', '5 of your 7 tracked lists (they stay saved on this browser if you keep a copy)', 'the marks “Favorite”, “Ongoing”'])
      assert.deepEqual(decision.answers.map(answer => answer.choice), ['keep', 'accept'])
    })

    test('its backup couldn\'t be written: using the synced settings says yours aren\'t backed up, and why', () => {
      const { decision } = syncStatusView({ ...ON, pause: { ...FIRST, backedUp: false, backupFailed: true } }, V).callouts[0]
      assert.equal(decision.backup, null)
      assert.equal(consequence(decision, 'accept'), `${USES} Yours aren't backed up: the backup couldn't be saved.`)
      assert.equal(consequence(decision, 'keep'), KEEPS_OWN, 'keeping this browser\'s always keeps the synced settings')
    })

    test('says nothing once sync is off', () => {
      assert.deepEqual(syncStatusView({ ...OFF, pause: FIRST }, V), { callouts: [] })
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
