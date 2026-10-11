// Whole-sync scenarios: several browsers running the real engine over one
// simulated sync server (see ./harness.mjs). The decision functions are tested
// on their own in decide.test.mjs; these are the interleavings between browsers,
// which is where sync actually goes wrong.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SYNC_CONSISTENCY_WAIT_MS } from '../../src/common/constants.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { addressOf, planRetitle, planStopTracking, planTrack, planTrackSearch } from '../../src/common/savedLists.ts'
import { decode, MANIFEST_KEY, SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { HELD_BACKUP_NOTE } from '../../src/common/syncMessages.ts'
import { syncStatusView } from '../../src/options_ui/model/syncStatus.ts'
import { createCloud, createDevice, createLegacyDevice, markedWorks, marksFixture, range, rulesFixture, textReplacementsFixture, trackedListsFixture } from './harness.mjs'

/** The options the first sync build knew: everything but what came later. */
const LEGACY_KNOWN = Object.keys(OPTION_DEFAULTS).filter(key => !['rules', 'workMarks', 'pruneOrphanedBlurbs'].includes(key))
/** An option only the first sync build had, which newer builds drop on read. */
const LEGACY_ONLY = { hideTags: { enabled: true, filters: [{ name: 'An old tag', matcher: 'exact' }] } }
/** The newest sync version a build from before the synced copy's ID speaks. */
const BEFORE_IDS = 11

/** A reader's worth of data. */
const MAIN = { rules: rulesFixture(40), workMarks: marksFixture(range(1000, 60)), textReplacements: textReplacementsFixture(10), trackedLists: trackedListsFixture(12) }

/** A browser with a reader's worth of data in it. */
function mainBrowser(cloud, name = 'laptop', settings = {}) {
  return createDevice(cloud, name, { options: MAIN, ...settings })
}

/** Browsers syncing the reader's data, one after another. */
async function inSync(...names) {
  const cloud = createCloud()
  const browsers = []
  for (const name of names) {
    const browser = browsers.length ? createDevice(cloud, name) : mainBrowser(cloud, name)
    await browser.enableSync()
    await cloud.run()
    browsers.push(browser)
  }
  return { cloud, browsers }
}

/** The question a pause asks, as the options page words it: its backup note and its answers. */
function decisionOn(pause) {
  return syncStatusView({ enabled: true, pause, staleBuild: false, backgroundOutdated: false }, SYNC_SCHEMA_VERSION).callouts[0].decision
}

/** What the answer `choice` says it does. */
const consequence = (decision, choice) => decision.answers.find(answer => answer.choice === choice).consequence

describe('sync scenarios', () => {
  test('a change in one browser reaches the other', async () => {
    const cloud = createCloud()
    const laptop = mainBrowser(cloud)
    await laptop.enableSync()
    await cloud.run()
    const desktop = createDevice(cloud, 'desktop')
    await desktop.enableSync()
    await cloud.run()
    assert.equal(desktop.options.rules.filters.length, 40)

    await laptop.edit({ wordsPerMinute: 350 })
    await cloud.run()
    assert.equal(desktop.options.wordsPerMinute, 350)
  })

  test('a browser turning sync on adopts the cloud copy and writes nothing back', async () => {
    const cloud = createCloud()
    const laptop = mainBrowser(cloud)
    await laptop.enableSync()
    await cloud.run()
    const before = cloud.manifest()

    const fresh = createDevice(cloud, 'fresh')
    await fresh.enableSync()
    await cloud.run()

    assert.equal(fresh.options.rules.filters.length, 40)
    assert.equal(markedWorks(fresh.options).size, 60)
    assert.deepEqual(fresh.backups.map(b => b.kind), ['pre-sync'])
    assert.equal(cloud.manifest().g, before.g, 'the adopting browser pushed nothing')
  })

  /**
   * Turning sync on over a synced copy replaces this browser's settings with
   * it, so it backs them up first whatever daily backups say, and asks which
   * to keep when both hold settings of their own that differ. Where nothing
   * is lost either way, it doesn't ask.
   */
  describe('turning sync on', () => {
    const V = SYNC_SCHEMA_VERSION
    /** Settings of this browser's own: the laptop's, with a rule more and a reading speed of its own. */
    const OWN = { ...MAIN, rules: rulesFixture(41), wordsPerMinute: 320 }

    /** A laptop syncing the reader's data, and a desktop with settings of its own and sync off. */
    async function withCloud(desktopSettings = {}) {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN, ...desktopSettings })
      await desktop.settle()
      return { cloud, laptop, desktop }
    }

    /** The desktop turns sync on over the laptop's copy, and is asked which settings to keep. */
    async function asked(desktopSettings) {
      const setup = await withCloud(desktopSettings)
      await setup.desktop.enableSync()
      await setup.cloud.run()
      assert.equal(setup.desktop.meta.pause?.reason, 'first-sync', 'precondition: asked')
      return setup
    }

    test('over an empty cloud, seeds it from this browser under an ID of its own, with nothing to back up', async () => {
      const cloud = createCloud()
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.match(cloud.manifest().w, /^desktop-/)
      assert.equal(typeof cloud.manifest().i, 'string')
      assert.equal(desktop.meta.meta.i, cloud.manifest().i, 'agreed on')
      assert.deepEqual(desktop.backups, [])
    })

    test('over a copy that matches, agrees silently and pushes nothing', async () => {
      const { cloud, desktop } = await withCloud({ options: MAIN })
      const before = cloud.manifest()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.deepEqual(cloud.manifest(), before)
      assert.equal(desktop.meta.meta.g, before.g, 'agreed')
      assert.equal(desktop.meta.dirty, false)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'])
    })

    /** Such a copy is a browser that turned sync on with its settings untouched: adopting it would reset every setting here. */
    test('over a copy holding nothing beyond defaults, sends this browser\'s settings silently', async () => {
      for (const own of [OWN, { wordsPerMinute: 320 }]) {
        const cloud = createCloud()
        const fresh = createDevice(cloud, 'fresh')
        await fresh.enableSync()
        await cloud.run()
        const desktop = createDevice(cloud, 'desktop', { options: own })
        await desktop.settle()
        await desktop.enableSync()
        await cloud.run()

        const what = `${Object.keys(own).length} settings`
        assert.equal(desktop.meta.pause, null, what)
        assert.equal(desktop.options.wordsPerMinute, 320, what)
        assert.equal(desktop.options.rules.filters.length, own.rules?.filters.length ?? 0, what)
        assert.match(cloud.manifest().w, /^desktop-/, what)
        assert.equal(desktop.meta.dirty, false, what)
        assert.equal(fresh.options.wordsPerMinute, 320, `the other browser takes them: ${what}`)
        assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'], what)
      }
    })

    test('a new profile adopts the copy, backed up first with daily backups off', async () => {
      const { cloud, desktop } = await withCloud({ options: {}, meta: { backupsEnabled: false } })
      const before = cloud.manifest()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.rules.filters.length, 40)
      assert.deepEqual(cloud.manifest(), before, 'nothing pushed')
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'])
    })

    test('over a copy that differs, asks, and applies and pushes nothing until answered', async () => {
      const { cloud, laptop, desktop } = await withCloud({ meta: { backupsEnabled: false } })
      const before = cloud.manifest()
      await desktop.enableSync()
      await cloud.run()

      const { at, ...pause } = desktop.meta.pause ?? {}
      assert.deepEqual(pause, { reason: 'first-sync', g: before.g, w: before.w, backedUp: true, backupFailed: false, loss: null })
      assert.equal(typeof at, 'number')
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.equal(desktop.options.rules.filters.length, 41)
      assert.deepEqual(cloud.manifest(), before)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'], 'backed up with daily backups off')
      assert.deepEqual(desktop.backups[0].options, desktop.options, 'this browser\'s own settings')

      // An edit made while it asks stays here, and isn't pushed.
      await desktop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.deepEqual(cloud.manifest(), before, 'nothing pushed while it asks')
      assert.equal(laptop.options.wordsPerMinute, 200)
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'still asking')
    })

    test('"accept" uses the synced settings, backing up again what it replaces', async () => {
      const { cloud, laptop, desktop } = await asked()
      await desktop.edit({ wordsPerMinute: 330 })
      const before = cloud.manifest()
      assert.equal(await desktop.resolveHeld('accept'), true)
      await cloud.run()

      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.rules.filters.length, 40)
      assert.equal(desktop.options.wordsPerMinute, 200, 'the edit made while it asked is replaced too')
      assert.deepEqual(cloud.manifest(), before, 'nothing pushed')
      assert.equal(desktop.meta.dirty, false)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync', 'pre-sync'])
      assert.equal(desktop.backups[0].options.wordsPerMinute, 320, 'this browser\'s settings as sync turned on')
      assert.equal(desktop.backups[1].options.wordsPerMinute, 330, 'and as they were replaced')
      assert.equal(desktop.backups[1].options.rules.filters.length, 41)

      await laptop.edit({ wordsPerMinute: 400 })
      await cloud.run()
      assert.equal(desktop.options.wordsPerMinute, 400, 'syncing as usual from then on')
    })

    test('"accept" with nothing changed since it asked backs up nothing more: the backup taken as it asked holds what it replaces', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { desktop } = await asked({ meta: { backupsEnabled } })
        assert.equal(await desktop.resolveHeld('accept'), true)
        assert.equal(desktop.options.wordsPerMinute, 200, daily)
        assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320]], daily)
      }
    })

    /**
     * Answering backs up again what changed while it asked. A backup that
     * can't be written then refuses the first press: nothing is applied, and
     * the question records that this browser's settings aren't backed up, so
     * it says so before a second press uses the synced settings anyway.
     */
    test('a backup that can\'t be written as "accept" applies refuses the first press, which then says yours aren\'t backed up; a second press applies, daily backups on or off', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { cloud, desktop } = await asked({ meta: { backupsEnabled } })
        await desktop.edit({ wordsPerMinute: 330 })
        desktop.breakBackups()
        const question = desktop.meta.pause
        const before = cloud.manifest()

        assert.deepEqual(await desktop.answer('accept'), { resolved: false, refused: 'unbacked' }, daily)
        assert.deepEqual(desktop.meta.pause, { ...question, backedUp: false, backupFailed: true }, daily)
        assert.equal(desktop.options.wordsPerMinute, 330, `nothing applied, ${daily}`)
        assert.equal(desktop.options.rules.filters.length, 41, daily)
        const decision = decisionOn(desktop.meta.pause)
        assert.equal(decision.backup, null, daily)
        assert.equal(consequence(decision, 'accept'), 'Replaces this browser\'s settings with your synced settings. Yours aren\'t backed up: the backup couldn\'t be saved.', daily)

        assert.equal(await desktop.resolveHeld('accept'), true, daily)
        await cloud.run()
        assert.equal(desktop.meta.pause, null, daily)
        assert.equal(desktop.options.wordsPerMinute, 200, daily)
        assert.deepEqual(cloud.manifest(), before, `nothing pushed, ${daily}`)
        assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320]], daily)
      }
    })

    /** The day's backup, due as the answer applies, is a backup the answer takes too. */
    test('the day\'s backup that can\'t be written as "accept" applies refuses the first press the same way', async () => {
      const { desktop } = await asked({ meta: { backupsEnabled: true } })
      await desktop.setMeta({ lastBackupDate: '' })
      desktop.breakBackups()
      assert.deepEqual(await desktop.answer('accept'), { resolved: false, refused: 'unbacked' })
      assert.deepEqual([desktop.meta.pause?.reason, desktop.meta.pause?.backedUp, desktop.meta.pause?.backupFailed], ['first-sync', false, true])
      assert.equal(desktop.options.wordsPerMinute, 320, 'nothing applied')

      assert.equal(await desktop.resolveHeld('accept'), true)
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 200)
    })

    /** A backup that would repeat the newest of its kind isn't written, and counts as backed up: nothing was due. */
    test('with nothing changed since it asked, "accept" goes ahead at the first press though backups can\'t be written', async () => {
      const { desktop } = await asked({ meta: { backupsEnabled: false } })
      desktop.breakBackups()
      assert.equal(await desktop.resolveHeld('accept'), true)
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 200)
    })

    test('"keep" replaces the synced settings on every browser, keeping them as a backup first', async () => {
      const { cloud, laptop, desktop } = await asked()
      assert.equal(await desktop.resolveHeld('keep'), true)
      await cloud.run()

      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.match(cloud.manifest().w, /^desktop-/)
      assert.equal(laptop.options.wordsPerMinute, 320)
      assert.equal(laptop.options.rules.filters.length, 41)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync', 'sync-declined'])
      assert.equal(desktop.backups[1].options.wordsPerMinute, 200, 'the synced settings are restorable')
      assert.equal(desktop.backups[1].options.rules.filters.length, 40)
    })

    test('after "keep", each other browser weighs this browser\'s settings with its own deletion guard', async () => {
      const { cloud, laptop, desktop } = await asked({ options: { ...OWN, rules: rulesFixture(2) } })
      assert.equal(await desktop.resolveHeld('keep'), true)
      await cloud.run()
      assert.match(cloud.manifest().w, /^desktop-/)
      assert.equal(laptop.meta.pause?.reason, 'held')
      assert.deepEqual(laptop.meta.pause.loss.rules, { removed: 38, of: 40 })
      assert.equal(laptop.options.rules.filters.length, 40)
    })

    test('turning sync off before answering changes nothing, and turning it on again asks again', async () => {
      const { cloud, desktop } = await asked()
      const before = cloud.manifest()
      await desktop.disableSync()
      await cloud.run()
      assert.equal(desktop.meta.enabled, false)
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(cloud.manifest(), before)

      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'], 'nothing changed, so the backup it took the first time holds them')
    })

    test('turned on again with nothing changed, its backup is the one already taken, and the question says they are backed up', async () => {
      const { cloud, desktop } = await asked({ meta: { backupsEnabled: false } })
      await desktop.disableSync()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.deepEqual([desktop.meta.pause.backedUp, desktop.meta.pause.backupFailed], [true, false])
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'])
      assert.deepEqual(desktop.backups[0].options, desktop.options)

      const decision = decisionOn(desktop.meta.pause)
      assert.equal(decision.backup, HELD_BACKUP_NOTE)
      assert.equal(consequence(decision, 'accept'), 'Replaces this browser\'s settings with your synced settings. Yours are backed up.')
    })

    test('a newer copy arriving while it asks is weighed afresh: asked over it, or settled once it no longer differs', async () => {
      const { cloud, laptop, desktop } = await asked()
      await laptop.edit({ wordsPerMinute: 250 })
      await cloud.run()
      const newer = cloud.manifest()
      assert.deepEqual([desktop.meta.pause?.reason, desktop.meta.pause?.g, desktop.meta.pause?.w], ['first-sync', newer.g, newer.w])
      assert.equal(desktop.meta.pause.backedUp, true)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'])

      await laptop.edit({ rules: rulesFixture(41), wordsPerMinute: 320 })
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.meta.meta.g, cloud.manifest().g, 'agreed')
      assert.match(cloud.manifest().w, /^laptop-/, 'nothing pushed')
    })

    test('an older build\'s copy arriving while it asks is waited on, and the question asked again once a current copy is back', async () => {
      const { cloud, desktop } = await asked()
      const legacy = createLegacyDevice(cloud, 'legacy', { knownKeys: LEGACY_KNOWN, legacyOptions: LEGACY_ONLY })
      await legacy.overwrite()
      cloud.deliver()
      await desktop.settle()
      assert.equal(desktop.meta.pause?.reason, 'older-cloud', 'nothing to ask about that it could adopt')
      assert.equal(desktop.options.wordsPerMinute, 320)

      // The laptop, which has synced before, replaces the older copy.
      await cloud.run()
      assert.equal(cloud.manifest().v, V)
      assert.match(cloud.manifest().w, /^laptop-/)
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.deepEqual([desktop.meta.pause.g, desktop.meta.pause.w], [cloud.manifest().g, cloud.manifest().w])
      assert.equal(desktop.options.wordsPerMinute, 320)
    })

    test('a pull the cloud starts as sync turns on waits behind it, rather than applying on the agreement it forgets', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      // The desktop synced with the laptop before, then turned sync off and set a reading speed of its own.
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()
      await desktop.disableSync()
      await desktop.edit({ wordsPerMinute: 320 })
      await laptop.edit({ wordsPerMinute: 250 })
      await cloud.run()

      const turning = desktop.engine.setEnabled(true)
      desktop.engine.onStorageChanged({ om: { newValue: cloud.manifest() } }, 'sync')
      await turning
      await desktop.settle()
      await cloud.run()

      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.equal(desktop.options.wordsPerMinute, 320)
    })

    test('turned on and straight off again, before turning on has had its turn, it stays off', async () => {
      const { cloud, desktop } = await withCloud()
      const before = cloud.manifest()
      const turningOn = desktop.engine.setEnabled(true)
      const turningOff = desktop.engine.setEnabled(false)
      await Promise.all([turningOn, turningOff])
      await desktop.settle()
      await cloud.run()

      assert.equal(desktop.meta.enabled, false)
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(cloud.manifest(), before)
    })

    test('the deletion guard: the question takes the hold\'s place, and using the synced settings applies them with no second hold', async () => {
      const { cloud, desktop } = await withCloud({ options: { ...OWN, rules: rulesFixture(60) } })
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.deepEqual(desktop.meta.pause.loss.rules, { removed: 20, of: 60 })

      assert.equal(await desktop.resolveHeld('accept'), true)
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.rules.filters.length, 40)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'])
      assert.equal(desktop.backups[0].options.rules.filters.length, 60, 'the backup taken as it asked holds what it replaced')
    })

    test('a newer sync version refuses before any backup or question', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud, 'laptop', { version: V + 1 })
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await desktop.settle()
      assert.deepEqual(await desktop.enableSync(), { ok: false, reason: 'newer-version', remoteVersion: V + 1, version: V })
      assert.equal(desktop.meta.pause, null)
      assert.deepEqual(desktop.backups, [])
    })

    test('an older version\'s copy is waited on, backed up, and the question asked once a copy at this version arrives', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud, 'laptop', { version: V - 1 })
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN, meta: { backupsEnabled: false } })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'older-cloud')
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'])

      await laptop.restart({ version: V, init: true })
      await cloud.run()
      assert.equal(cloud.manifest().v, V)
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.equal(desktop.meta.pause.backedUp, true)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(desktop.backups.at(-1).options, desktop.options, 'its settings as it asks are backed up')
    })

    test('a copy that can\'t be read in full as sync turns on is read again, and the question then backs up what it asks over', async () => {
      const { desktop } = await withCloud({ meta: { backupsEnabled: false } })
      const chunk = desktop.peer.view.get('o0')
      desktop.peer.view.delete('o0')
      await desktop.enableSync()
      assert.equal(desktop.meta.pause, null, 'nothing to ask about yet')
      assert.equal(desktop.options.wordsPerMinute, 320)

      await desktop.edit({ wordsPerMinute: 330 })
      desktop.peer.view.set('o0', chunk)
      await desktop.react()
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.equal(desktop.meta.pause.backedUp, true)
      assert.equal(desktop.options.wordsPerMinute, 330)
      assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320], ['pre-sync', 330]])
    })

    test('a newer sync version\'s copy arriving while it asks pauses it, and once updated it asks again', async () => {
      const { cloud, laptop, desktop } = await asked()
      await laptop.restart({ version: V + 1, init: true })
      await laptop.edit({ wordsPerMinute: 260 })
      await cloud.run()
      assert.equal(cloud.manifest().v, V + 1)
      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.options.wordsPerMinute, 320)

      await desktop.restart({ version: V + 1, init: true })
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.deepEqual([desktop.meta.pause.g, desktop.meta.pause.w], [cloud.manifest().g, cloud.manifest().w])
      assert.equal(desktop.meta.pause.backedUp, true)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'], 'asked again over the same settings: the backup it has holds them')
    })

    test('a browser taken back to an older build while it asks pauses for the copy rather than adopt it', async () => {
      const { cloud, desktop } = await asked()
      const before = cloud.manifest()
      await desktop.restart({ version: V - 1, init: true })
      await desktop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.options.wordsPerMinute, 330)
      assert.equal(desktop.options.rules.filters.length, 41)
      assert.deepEqual(cloud.manifest(), before)
    })

    test('a backup that can\'t be written doesn\'t stop it asking, daily backups on or off, and records that it failed', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { cloud, desktop } = await withCloud({ failBackups: true, meta: { backupsEnabled } })
        const before = cloud.manifest()
        assert.deepEqual(await desktop.enableSync(), { ok: true }, daily)
        await cloud.run()
        assert.equal(desktop.meta.enabled, true, daily)
        assert.equal(desktop.meta.pause?.reason, 'first-sync', daily)
        assert.equal(desktop.meta.pause.backedUp, false, daily)
        assert.equal(desktop.meta.pause.backupFailed, true, daily)
        assert.equal(desktop.options.wordsPerMinute, 320, daily)
        assert.deepEqual(cloud.manifest(), before, daily)
      }
    })

    /** The question already says this browser's settings aren't backed up, so the first press is the reader's second word on it. */
    test('one whose backup failed uses the synced settings at the first press, daily backups on or off', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { desktop } = await asked({ failBackups: true, meta: { backupsEnabled } })
        assert.equal(await desktop.resolveHeld('accept'), true, daily)
        assert.equal(desktop.meta.pause, null, daily)
        assert.equal(desktop.options.wordsPerMinute, 200, daily)
      }
    })
  })

  /**
   * Each synced copy carries an ID, the same through every upload over it,
   * and each browser keeps the ID of the copy it last agreed with. A copy
   * under another ID is one another browser started: taken as an update, it
   * would replace every setting here unasked, so it is weighed as turning sync
   * on weighs a copy.
   */
  describe('the synced copy\'s ID', () => {
    /** Settings of the desktop's own: the reader's, with a rule more and a reading speed of its own. */
    const OWN = { ...MAIN, rules: rulesFixture(41), wordsPerMinute: 320 }

    /**
     * A desktop holding `desktop` and a laptop holding `laptop` turn sync on at
     * once, so each finds no synced copy and seeds one. The desktop's write
     * reaches the sync service first, so the laptop's lands last, and the
     * desktop is sent it.
     */
    async function race({ desktop: desktopOptions = OWN, laptop: laptopOptions = MAIN, meta = {} } = {}) {
      const cloud = createCloud()
      const desktop = createDevice(cloud, 'desktop', { options: desktopOptions, meta })
      const laptop = createDevice(cloud, 'laptop', { options: laptopOptions })
      await desktop.settle()
      await laptop.settle()
      await desktop.enableSync()
      await laptop.enableSync()
      const ids = { desktop: desktop.meta.meta.i, laptop: laptop.meta.meta.i }
      await cloud.run()
      assert.equal(cloud.manifest().i, ids.laptop, 'precondition: the laptop\'s copy landed last, and its ID stands')
      return { cloud, desktop, laptop, ids }
    }

    test('two browsers turning sync on at once each seed under an ID of their own', async () => {
      const { ids } = await race()
      assert.equal(typeof ids.desktop, 'string')
      assert.equal(typeof ids.laptop, 'string')
      assert.notEqual(ids.desktop, ids.laptop)
    })

    test('the copy that lands last is weighed by the other browser as turning sync on weighs one: asked, backed up first, nothing replaced', async () => {
      const { cloud, desktop, laptop } = await race({ meta: { backupsEnabled: false } })
      const { at, ...pause } = desktop.meta.pause ?? {}
      assert.deepEqual(pause, { reason: 'first-sync', otherCopy: true, g: cloud.manifest().g, w: cloud.manifest().w, backedUp: true, backupFailed: false, loss: null })
      assert.equal(desktop.options.wordsPerMinute, 320, 'nothing replaced')
      assert.equal(desktop.options.rules.filters.length, 41)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['sync-held'], 'backed up first, with daily backups off')
      assert.deepEqual(desktop.backups[0].options, desktop.options)

      await desktop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.match(cloud.manifest().w, /^laptop-/, 'nothing pushed while it asks')
      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.wordsPerMinute, 200)
    })

    test('the copy the other browser takes no notice of is weighed when that browser uploads again', async () => {
      // The laptop's write reaches the service first this time, so the desktop's lands last. The generation's
      // tie-break puts the desktop's behind the laptop's, so the laptop doesn't pull it.
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await laptop.settle()
      await desktop.settle()
      await laptop.enableSync()
      await desktop.enableSync()
      await cloud.run()
      assert.match(cloud.manifest().w, /^desktop-/, 'precondition: the desktop\'s copy landed last')
      assert.deepEqual([laptop.meta.pause, laptop.options.wordsPerMinute], [null, 200], 'precondition: the laptop took no notice of it')

      await laptop.edit({ wordsPerMinute: 250 })
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.equal(desktop.meta.pause.otherCopy, true)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['sync-held'])
    })

    test('"keep" uploads this browser\'s settings under the copy\'s ID, which the browser that agreed with it takes as an update', async () => {
      const { cloud, desktop, laptop, ids } = await race()
      assert.equal(await desktop.resolveHeld('keep'), true)
      await cloud.run()

      assert.equal(desktop.meta.pause, null)
      assert.match(cloud.manifest().w, /^desktop-/)
      assert.equal(cloud.manifest().i, ids.laptop)
      assert.equal(desktop.meta.meta.i, ids.laptop)
      assert.equal(laptop.meta.pause, null, 'taken with no question')
      assert.equal(laptop.options.wordsPerMinute, 320)
      assert.equal(laptop.options.rules.filters.length, 41)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['sync-held', 'sync-declined'])
      assert.equal(desktop.backups[1].options.wordsPerMinute, 200, 'the laptop\'s settings are restorable')

      await laptop.edit({ wordsPerMinute: 400 })
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 400, 'syncing as one from then on')
    })

    test('"accept" takes the copy and its ID, and the two sync as one from then on', async () => {
      const { cloud, desktop, laptop, ids } = await race()
      const before = cloud.manifest()
      assert.equal(await desktop.resolveHeld('accept'), true)
      await cloud.run()

      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 200)
      assert.equal(desktop.options.rules.filters.length, 40)
      assert.equal(desktop.meta.meta.i, ids.laptop)
      assert.deepEqual(cloud.manifest(), before, 'nothing pushed')
      assert.deepEqual(desktop.backups.map(b => b.kind), ['sync-held'], 'nothing changed since it asked: the backup taken then holds them')

      await desktop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.wordsPerMinute, 330)
    })

    test('"accept" backs up again what changed while it asked, under the question\'s kind', async () => {
      const { desktop } = await race({ meta: { backupsEnabled: false } })
      await desktop.edit({ wordsPerMinute: 330 })
      assert.equal(await desktop.resolveHeld('accept'), true)
      assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['sync-held', 320], ['sync-held', 330]])
    })

    test('where nothing is lost either way, it settles with no question, and takes the copy\'s ID', async () => {
      const cases = [
        ['this browser holds nothing beyond defaults: the copy is taken', { desktop: {} }, MAIN],
        ['the copy holds nothing beyond defaults: this browser\'s settings are sent over it', { laptop: {} }, OWN],
        ['the copy matches: agreed on', { desktop: MAIN }, MAIN],
      ]
      for (const [what, settings, settled] of cases) {
        const { cloud, desktop, laptop, ids } = await race(settings)
        assert.equal(desktop.meta.pause, null, what)
        assert.equal(laptop.meta.pause, null, what)
        for (const browser of [desktop, laptop]) {
          assert.equal(browser.options.wordsPerMinute, settled.wordsPerMinute ?? 200, `${browser.name}: ${what}`)
          assert.equal(browser.options.rules.filters.length, settled.rules.filters.length, `${browser.name}: ${what}`)
          assert.equal(browser.meta.meta.i, ids.laptop, `${browser.name}: ${what}`)
        }
        assert.equal(cloud.manifest().i, ids.laptop, what)
        assert.deepEqual(desktop.backups, [], `nothing to back up: ${what}`)
      }
    })

    test('a question a copy under another ID raised goes, with nothing applied, once the copy gives way to this browser\'s own', async () => {
      // The laptop's write reaches the service first, so the desktop's lands last; but the service shows the
      // desktop the laptop's copy before it settles.
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await laptop.settle()
      await desktop.settle()
      await laptop.enableSync()
      await desktop.enableSync()
      await desktop.receive(laptop.synced)
      assert.equal(desktop.meta.pause?.otherCopy, true, 'precondition: asked over the laptop\'s copy')

      await desktop.edit({ wordsPerMinute: 330 })
      cloud.deliver()
      await desktop.settle()
      assert.match(cloud.manifest().w, /^desktop-/, 'precondition: the desktop\'s copy landed last')
      assert.equal(desktop.meta.pause, null, 'the copy it asked over is gone')
      assert.equal(desktop.options.wordsPerMinute, 330, 'nothing applied')
      assert.equal(desktop.options.rules.filters.length, 41)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['sync-held'], 'its backup stays')

      await cloud.run()
      assert.equal(cloud.manifest().g, 2)
      assert.match(cloud.manifest().w, /^desktop-/, 'the edit made while it asked is sent')
      assert.equal(laptop.meta.pause?.otherCopy, true, 'which the laptop, under its own ID, weighs in turn')
    })

    /** Sync was on before the ID: whatever copy it agreed with, it can't say which. */
    describe('a browser upgraded with sync on, which has no ID', () => {
      test('takes the first copy with one as an ordinary update, and its ID, with no question', async () => {
        // On a build from before the ID, the desktop seeds as the laptop does; its copy lands first.
        const cloud = createCloud()
        const desktop = createDevice(cloud, 'desktop', { options: OWN, version: BEFORE_IDS, ids: false })
        const laptop = mainBrowser(cloud)
        await desktop.settle()
        await laptop.settle()
        await desktop.enableSync()
        await laptop.enableSync()
        await desktop.restart({ version: SYNC_SCHEMA_VERSION, ids: true })
        assert.equal(desktop.meta.meta.i, undefined, 'precondition: agreed, with no ID')
        assert.equal(typeof laptop.meta.meta.i, 'string', 'precondition: the laptop seeded under one')

        await cloud.run()
        assert.match(cloud.manifest().w, /^laptop-/, 'precondition: the laptop\'s copy landed last')
        assert.equal(desktop.meta.pause, null)
        assert.equal(desktop.options.wordsPerMinute, 200, 'out-of-date settings without an ID give way')
        assert.equal(desktop.meta.meta.i, laptop.meta.meta.i)
        assert.deepEqual(desktop.backups, [])

        await desktop.edit({ wordsPerMinute: 330 })
        await cloud.run()
        assert.equal(cloud.manifest().i, laptop.meta.meta.i, 'and uploads under it')
        assert.equal(laptop.options.wordsPerMinute, 330)
        assert.equal(laptop.meta.pause, null)
      })

      test('agreed on a copy with one as a build from before the ID, moves it up under that copy\'s ID, which the browsers holding it take as an update', async () => {
        const cloud = createCloud()
        const laptop = mainBrowser(cloud, 'laptop', { version: BEFORE_IDS })
        await laptop.enableSync()
        await cloud.run()
        const desktop = createDevice(cloud, 'desktop', { version: BEFORE_IDS, ids: false })
        await desktop.enableSync()
        await cloud.run()
        const id = cloud.manifest().i
        assert.equal(typeof id, 'string', 'precondition: the laptop seeded under an ID')
        await desktop.restart({ version: SYNC_SCHEMA_VERSION, ids: true, init: true })
        assert.equal(desktop.meta.meta.i, undefined, 'precondition: agreed on the laptop\'s copy, with no ID')

        await desktop.edit({ wordsPerMinute: 330 })
        await cloud.run()
        assert.equal(cloud.manifest().v, SYNC_SCHEMA_VERSION)
        assert.equal(cloud.manifest().i, id)
        assert.equal(desktop.meta.meta.i, id)

        await laptop.restart({ version: SYNC_SCHEMA_VERSION, init: true })
        await cloud.run()
        assert.equal(laptop.meta.pause, null, 'an ordinary update')
        assert.equal(laptop.options.wordsPerMinute, 330)
      })
    })

    /** Browsers that all synced on a build from before the ID, so the synced copy has none. */
    async function upgradedTogether(settings = {}) {
      const cloud = createCloud()
      const browsers = [mainBrowser(cloud, 'laptop', { ids: false, ...settings }), createDevice(cloud, 'desktop', { ids: false, ...settings }), createDevice(cloud, 'tablet', { ids: false, ...settings })]
      for (const browser of browsers) {
        await browser.enableSync()
        await cloud.run()
      }
      return { cloud, browsers }
    }

    test('a browser with no ID moving the synced copy up from an older sync version starts it under a new ID, which the browsers updated after it take', async () => {
      const { cloud, browsers } = await upgradedTogether({ version: BEFORE_IDS })
      const [laptop, ...rest] = browsers
      await laptop.restart({ version: SYNC_SCHEMA_VERSION, ids: true, init: true })
      await cloud.run()
      const id = cloud.manifest().i
      assert.equal(cloud.manifest().v, SYNC_SCHEMA_VERSION, 'precondition: moved up')
      assert.equal(typeof id, 'string')
      assert.equal(laptop.meta.meta.i, id)

      for (const browser of rest) {
        assert.equal(browser.meta.pause?.reason, 'newer-version', `precondition: ${browser.name} waits to be updated`)
        await browser.restart({ version: SYNC_SCHEMA_VERSION, ids: true, init: true })
        await cloud.run()
      }
      for (const browser of browsers) {
        assert.equal(browser.meta.pause, null, browser.name)
        assert.equal(browser.meta.meta.i, id, browser.name)
        assert.equal(browser.options.rules.filters.length, 40, browser.name)
      }
    })

    /**
     * A build at 11 from before the ID, taking a copy another browser started
     * as an update, would pass it on without its ID, as an update to every
     * browser that holds one. At a sync version it doesn't speak, it waits.
     */
    test('a build at 11 from before the ID pauses for a copy at this sync version, passing nothing on without its ID, and takes it once updated', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud, 'laptop', { version: BEFORE_IDS })
      await laptop.enableSync()
      await cloud.run()
      const older = createDevice(cloud, 'older', { version: BEFORE_IDS, ids: false })
      await older.enableSync()
      await cloud.run()
      const id = cloud.manifest().i
      assert.equal(typeof id, 'string', 'precondition: the laptop seeded under an ID')

      await laptop.restart({ version: SYNC_SCHEMA_VERSION, init: true })
      await laptop.edit({ wordsPerMinute: 250 })
      await cloud.run()
      assert.deepEqual([cloud.manifest().v, cloud.manifest().i], [SYNC_SCHEMA_VERSION, id], 'precondition: the updated laptop moved the copy up under its ID')
      assert.equal(older.meta.pause?.reason, 'newer-version')
      assert.equal(older.options.wordsPerMinute, 200, 'not taken')

      await older.edit({ wordsPerMinute: 260 })
      await cloud.run()
      assert.deepEqual([cloud.manifest().w, cloud.manifest().i], [laptop.meta.meta.w, id], 'nothing passed on')
      assert.equal(laptop.options.wordsPerMinute, 250)

      await older.restart({ version: SYNC_SCHEMA_VERSION, ids: true, init: true })
      await cloud.run()
      assert.equal(older.meta.pause, null)
      assert.equal(older.options.wordsPerMinute, 250, 'the copy, taken as an update')
      assert.equal(older.meta.meta.i, id)
      assert.deepEqual(older.backups.map(b => b.kind), ['pre-sync'], 'no question: only the backup turning sync on took')
    })

    test('turning sync off gives a browser a new ID in place of the one it agreed on', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const id = laptop.meta.meta.i
      assert.equal(typeof id, 'string', 'precondition: seeded under an ID')

      await laptop.disableSync()
      assert.equal(typeof laptop.meta.meta.i, 'string')
      assert.notEqual(laptop.meta.meta.i, id)
    })

    test('turned off and on again, a browser that seeds does so under a new ID', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()
      const first = cloud.manifest().i
      assert.equal(typeof first, 'string', 'precondition: seeded under an ID')
      assert.equal(laptop.meta.meta.i, first)

      // With the laptop's sync off, the synced copy is cleared from the desktop.
      await laptop.disableSync()
      await desktop.engine.clearSyncedData()
      await desktop.settle()
      await cloud.run()
      assert.equal(cloud.manifest(), null, 'precondition: no synced copy')

      await laptop.edit({ wordsPerMinute: 330 })
      await laptop.enableSync()
      await cloud.run()
      assert.match(cloud.manifest().w, /^laptop-/)
      assert.equal(typeof cloud.manifest().i, 'string')
      assert.notEqual(cloud.manifest().i, first)
      assert.equal(laptop.meta.meta.i, cloud.manifest().i)
    })

    /**
     * No build writes a copy at this sync version without an ID. One that
     * arrives anyway can't say which copy it was written over: it is taken as
     * an update, and the browser keeps its ID, which its next upload puts back.
     */
    test('a copy at this sync version with no ID is an ordinary update, and the next upload puts the ID back', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      const id = laptop.meta.meta.i
      assert.equal(desktop.meta.meta.i, id, 'precondition: both agreed on the laptop\'s copy')
      laptop.peer.online = false
      await laptop.edit({ wordsPerMinute: 250 })
      assert.equal(await laptop.pushOffline(), true)
      const { i, ...unnamed } = laptop.synced[MANIFEST_KEY]
      await desktop.receive({ ...laptop.synced, [MANIFEST_KEY]: unnamed })
      assert.deepEqual([desktop.meta.pause, desktop.options.wordsPerMinute, desktop.meta.meta.i], [null, 250, id])

      await desktop.edit({ wordsPerMinute: 260 })
      laptop.peer.online = true
      await cloud.run()
      assert.deepEqual([cloud.manifest().i, laptop.meta.pause, laptop.options.wordsPerMinute], [id, null, 260])
    })
  })

  /**
   * Two browsers answering *Keep* over one copy before either has received
   * the other's upload both upload under the copy's ID. Each *Keep* starts a
   * line of its own, chosen over the copy's, which every upload after it
   * carries on, and a browser whose line comes from its own *Keep* weighs a
   * copy that never saw it as a copy another browser started: asked about,
   * backed up first. Ordinary edits made at once stay last-writer-wins.
   */
  describe('two browsers keeping their own settings at once', () => {
    /** The desktop's settings of its own and the tablet's: the reader's, each with rules more and a reading speed of its own. */
    const DESKTOP = { ...MAIN, rules: rulesFixture(41), wordsPerMinute: 320 }
    const TABLET = { ...MAIN, rules: rulesFixture(42), wordsPerMinute: 310 }
    const SETTINGS = { desktop: DESKTOP, tablet: TABLET }

    /**
     * A laptop syncing the reader's data, then a desktop and a tablet with
     * settings of their own turning sync on over it, each asked which to keep.
     * `order` is the order they reach the sync service in: the second's
     * writes land last.
     */
    async function bothAsked(order = ['desktop', 'tablet']) {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const browsers = Object.fromEntries(order.map(name => [name, createDevice(cloud, name, { options: SETTINGS[name] })]))
      for (const name of order) {
        await browsers[name].settle()
        await browsers[name].enableSync()
      }
      await cloud.run()
      for (const name of order)
        assert.equal(browsers[name].meta.pause?.reason, 'first-sync', `precondition: ${name} asked`)
      return { cloud, laptop, ...browsers }
    }

    /** `browsers` each answer *Keep* before any has received another's upload. */
    async function allKeep(...browsers) {
      for (const browser of browsers)
        assert.equal(await browser.resolveHeld('keep'), true, `${browser.name} answered`)
    }

    /** The settings that tell the reader's browsers apart. */
    const ownOf = browser => [browser.options.wordsPerMinute, browser.options.rules.filters.length]

    test('the one whose upload lands first is asked again over the other\'s, backed up first, with nothing replaced', async () => {
      const { cloud, laptop, desktop, tablet } = await bothAsked(['desktop', 'tablet'])
      const id = cloud.manifest().i
      await allKeep(desktop, tablet)
      await cloud.run()
      assert.match(cloud.manifest().w, /^tablet-/, 'precondition: the tablet\'s upload landed last')
      assert.equal(cloud.manifest().i, id, 'precondition: both under the copy\'s ID')

      const { at, ...pause } = desktop.meta.pause ?? {}
      assert.deepEqual(pause, { reason: 'first-sync', otherCopy: true, g: cloud.manifest().g, w: cloud.manifest().w, backedUp: true, backupFailed: false, loss: null })
      assert.deepEqual(ownOf(desktop), [320, 41], 'nothing replaced')
      assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320], ['sync-declined', 200], ['sync-held', 320]], 'backed up as it is asked again')
      assert.deepEqual(tablet.meta.pause, null)
      assert.deepEqual(ownOf(laptop), [310, 42], 'the laptop, which kept nothing, takes the copy as an update')

      // Answered, the desktop's settings go up over the tablet's, which it has seen: an update to the rest.
      assert.equal(await desktop.resolveHeld('keep'), true)
      await cloud.run()
      for (const browser of [desktop, laptop, tablet]) {
        assert.equal(browser.meta.pause, null, browser.name)
        assert.deepEqual(ownOf(browser), [320, 41], browser.name)
      }
      await tablet.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.deepEqual([desktop.meta.pause, desktop.options.wordsPerMinute], [null, 330], 'syncing as one from then on')
    })

    /**
     * A browser takes no notice of an upload that loses the generation's
     * tie-break to the one it agreed with, so the two stand apart until one
     * uploads again. That upload carries on its writer's own *Keep*'s line,
     * which the other's never saw.
     */
    test('one whose upload lands last but loses the tie-break is asked once the other uploads again, whichever does', async () => {
      for (const next of ['tablet', 'desktop']) {
        const { cloud, laptop, desktop, tablet } = await bothAsked(['tablet', 'desktop'])
        await allKeep(desktop, tablet)
        await cloud.run()
        assert.match(cloud.manifest().w, /^desktop-/, 'precondition: the desktop\'s upload landed last')
        assert.deepEqual([tablet.meta.pause, ...ownOf(tablet)], [null, 310, 42], 'precondition: the tablet took no notice of it')
        assert.deepEqual([desktop.meta.pause, laptop.meta.pause], [null, null])

        const uploader = { tablet, desktop }[next]
        const asked = next === 'tablet' ? desktop : tablet
        await uploader.edit({ wordsPerMinute: 333 })
        await cloud.run()
        assert.match(cloud.manifest().w, new RegExp(`^${next}-`), `precondition: the ${next} uploaded`)
        assert.equal(asked.meta.pause?.reason, 'first-sync', `${asked.name} asked once the ${next} uploads`)
        assert.equal(asked.meta.pause.otherCopy, true)
        assert.deepEqual(ownOf(asked), ownOf({ options: SETTINGS[asked.name] }), `nothing of the ${asked.name}'s replaced`)
        assert.deepEqual(asked.backups.at(-1), { kind: 'sync-held', options: asked.options }, `the ${asked.name} backed up first`)
      }
    })

    test('three seeding at once: the two asked over the third\'s copy keep their own at once, and the one replaced unseen is asked again', async () => {
      const cloud = createCloud()
      const desktop = createDevice(cloud, 'desktop', { options: DESKTOP })
      const laptop = mainBrowser(cloud)
      const tablet = createDevice(cloud, 'tablet', { options: TABLET })
      for (const browser of [desktop, laptop, tablet])
        await browser.settle()
      for (const browser of [desktop, laptop, tablet])
        await browser.enableSync()
      await cloud.run()
      assert.match(cloud.manifest().w, /^tablet-/, 'precondition: the tablet\'s seed landed last')
      for (const browser of [desktop, laptop])
        assert.equal(browser.meta.pause?.otherCopy, true, `precondition: ${browser.name} asked over it`)

      await allKeep(desktop, laptop)
      await cloud.run()
      assert.match(cloud.manifest().w, /^laptop-/, 'precondition: the laptop\'s upload landed last')
      assert.equal(desktop.meta.pause?.otherCopy, true, 'the desktop asked again')
      assert.deepEqual(ownOf(desktop), [320, 41], 'nothing replaced')
      assert.equal(desktop.meta.pause.backedUp, true)
      assert.deepEqual(desktop.backups.map(b => b.kind), ['sync-held', 'sync-declined'], 'its settings are the ones the backup taken as it was first asked holds')
      assert.deepEqual(desktop.backups[0].options, desktop.options)
      assert.equal(laptop.meta.pause, null)
    })

    /**
     * Settings sent over a copy holding nothing beyond defaults are sent as
     * a *Keep* sends them, unasked: two browsers turning sync on at once over
     * such a copy each send theirs, and the one whose upload is replaced
     * unseen would lose its settings with no backup at all.
     */
    test('two sending their settings over a copy holding nothing beyond defaults at once: the one replaced unseen is asked, backed up first', async () => {
      const cloud = createCloud()
      const laptop = createDevice(cloud, 'laptop')
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: DESKTOP })
      const tablet = createDevice(cloud, 'tablet', { options: TABLET })
      for (const browser of [desktop, tablet])
        await browser.settle()
      for (const browser of [desktop, tablet])
        await browser.enableSync()
      await cloud.run()

      assert.match(cloud.manifest().w, /^tablet-/, 'precondition: the tablet\'s settings landed last')
      assert.equal(desktop.meta.pause?.otherCopy, true, 'the desktop asked')
      assert.deepEqual(ownOf(desktop), [320, 41], 'nothing replaced')
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync', 'sync-held'])
      assert.deepEqual(desktop.backups.at(-1).options, desktop.options)
      assert.deepEqual([tablet.meta.pause, laptop.meta.pause], [null, null])
      assert.deepEqual(ownOf(laptop), [310, 42])
    })

    test('a held update kept by two browsers at once: the one replaced unseen is asked where the two differ, and settles silently where they don\'t', async () => {
      for (const differ of [true, false]) {
        const { cloud, browsers: [laptop, desktop, tablet] } = await inSync('laptop', 'desktop', 'tablet')
        await laptop.edit({ rules: rulesFixture(1) })
        await cloud.run()
        for (const browser of [desktop, tablet])
          assert.equal(browser.meta.pause?.reason, 'held', `precondition: ${browser.name} held`)
        if (differ)
          await desktop.edit({ wordsPerMinute: 300 })

        await allKeep(desktop, tablet)
        await cloud.run()
        assert.match(cloud.manifest().w, /^tablet-/, 'precondition: the tablet\'s upload landed last')
        assert.equal(tablet.meta.pause, null)
        assert.equal(desktop.options.rules.filters.length, 40, 'nothing replaced')
        if (differ) {
          assert.equal(desktop.meta.pause?.otherCopy, true, 'asked again')
          assert.equal(desktop.options.wordsPerMinute, 300)
          assert.deepEqual(desktop.backups.at(-1), { kind: 'sync-held', options: desktop.options })
        }
        else {
          assert.equal(desktop.meta.pause, null, 'the same settings: nothing to ask')
        }
      }
    })

    test('asked again over an upload the service then gives way to this browser\'s own, the question goes', async () => {
      const { cloud, desktop, tablet } = await bothAsked(['tablet', 'desktop'])
      await allKeep(desktop, tablet)
      await desktop.receive(tablet.synced)
      assert.equal(desktop.meta.pause?.otherCopy, true, 'precondition: asked over the tablet\'s upload')

      cloud.deliver()
      await desktop.settle()
      assert.match(cloud.manifest().w, /^desktop-/, 'precondition: the desktop\'s landed last')
      assert.equal(desktop.meta.pause, null)
      assert.deepEqual(ownOf(desktop), [320, 41], 'nothing applied')
    })

    /**
     * A *Keep* backs up the copy it read, then uploads over whatever is there
     * by then, under that copy's ID, in a line of its own chosen over the
     * copy it read: another *Keep* landing in between never saw it.
     */
    test('a Keep upload landing between another\'s reading the copy and uploading: its browser is asked again, backed up first', async () => {
      const { cloud, desktop, tablet } = await bothAsked(['desktop', 'tablet'])
      assert.equal(await tablet.resolveHeld('keep'), true)
      desktop.whileBackingUp(() => cloud.deliver())
      assert.equal(await desktop.resolveHeld('keep'), true)
      assert.match(desktop.synced[MANIFEST_KEY].w, /^desktop-/)
      assert.equal(desktop.backups.at(-1).options.wordsPerMinute, 200, 'precondition: the desktop backed up the copy it read, not the tablet\'s')

      await cloud.run()
      assert.match(cloud.manifest().w, /^desktop-/, 'precondition: the desktop\'s upload went over the tablet\'s')
      assert.equal(tablet.meta.pause?.otherCopy, true, 'the tablet asked again')
      assert.deepEqual(ownOf(tablet), [310, 42], 'nothing replaced')
      assert.deepEqual(tablet.backups.at(-1), { kind: 'sync-held', options: tablet.options })
    })

    test('an ordinary upload landing there is replaced as last-writer-wins replaces any', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: DESKTOP })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'precondition: asked')

      await laptop.edit({ wordsPerMinute: 250 })
      await laptop.react()
      desktop.whileBackingUp(() => cloud.deliver())
      assert.equal(await desktop.resolveHeld('keep'), true)
      await cloud.run()
      assert.match(cloud.manifest().w, /^desktop-/)
      assert.equal(laptop.meta.pause, null, 'no question')
      assert.deepEqual(ownOf(laptop), [320, 41])
    })

    /** The desktop keeps its own settings over the laptop's, which the laptop takes. */
    async function keptOver() {
      const cloud = createCloud()
      const desktop = createDevice(cloud, 'desktop', { options: DESKTOP })
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'precondition: asked')
      assert.equal(await desktop.resolveHeld('keep'), true)
      await cloud.run()
      assert.deepEqual(ownOf(laptop), [320, 41], 'precondition: the laptop took the desktop\'s settings')
      return { cloud, desktop, laptop }
    }

    /** Two browsers' edits, each pushed before either has received the other's; the second's lands last. */
    async function editAtOnce(cloud, [first, second]) {
      await first.edit({ wordsPerMinute: 330 })
      await second.edit({ wordsPerMinute: 340 })
      await first.react()
      await second.react()
      await cloud.run()
      assert.match(cloud.manifest().w, new RegExp(`^${second.name}-`), `precondition: the ${second.name}'s edit landed last`)
    }

    test('ordinary edits made at once stay last-writer-wins, with no question', async () => {
      const cloud = createCloud()
      const desktop = createDevice(cloud, 'desktop')
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      await desktop.enableSync()
      await cloud.run()
      await editAtOnce(cloud, [desktop, laptop])
      for (const browser of [desktop, laptop]) {
        assert.equal(browser.meta.pause, null, browser.name)
        assert.equal(browser.options.wordsPerMinute, 340, browser.name)
      }
    })

    test('right after a Keep too: the edit of a browser that took it is an ordinary update', async () => {
      const { cloud, desktop, laptop } = await keptOver()
      await editAtOnce(cloud, [desktop, laptop])
      for (const browser of [desktop, laptop]) {
        assert.equal(browser.meta.pause, null, browser.name)
        assert.equal(browser.options.wordsPerMinute, 340, browser.name)
      }
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync', 'sync-declined'], 'nothing asked, nothing backed up')
    })

    /**
     * Each upload carries on the line of the *Keep* it comes from: a browser
     * that took the *Keep* upload and then uploads twice, the first never
     * reaching the browser that kept, has still seen it.
     */
    test('right after a Keep, however many uploads a browser that took it makes before one reaches the browser that kept, they are ordinary updates', async () => {
      const { cloud, desktop, laptop } = await keptOver()
      desktop.peer.online = false
      for (const wordsPerMinute of [350, 360]) {
        await laptop.edit({ wordsPerMinute })
        await cloud.run()
      }
      desktop.peer.online = true
      await cloud.run()
      assert.deepEqual([desktop.meta.pause, desktop.options.wordsPerMinute], [null, 360])
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync', 'sync-declined'], 'nothing asked, nothing backed up')
    })

    /**
     * Every upload carries on the line of the *Keep* it comes from, so the
     * browser that kept sees its *Keep* in an upload however many browsers'
     * uploads came between, the ones before it missed included.
     */
    test('right after a Keep or a send, a run of other browsers\' edits the browser that kept missed the first of: ordinary updates', async () => {
      for (const sent of [false, true]) {
        const cloud = createCloud()
        const laptop = createDevice(cloud, 'laptop', { options: sent ? {} : MAIN })
        const tablet = createDevice(cloud, 'tablet')
        for (const browser of [laptop, tablet]) {
          await browser.enableSync()
          await cloud.run()
        }
        const desktop = createDevice(cloud, 'desktop', { options: DESKTOP })
        await desktop.settle()
        await desktop.enableSync()
        await cloud.run()
        if (!sent)
          assert.equal(await desktop.resolveHeld('keep'), true)
        await cloud.run()
        assert.deepEqual(ownOf(tablet), [320, 41], 'precondition: the tablet took the desktop\'s settings')

        desktop.peer.online = false
        await laptop.edit({ wordsPerMinute: 330 })
        await cloud.run()
        await tablet.edit({ wordsPerMinute: 340 })
        await cloud.run()
        desktop.peer.online = true
        await cloud.run()
        const what = sent ? 'sent' : 'kept'
        assert.deepEqual([desktop.meta.pause, ...ownOf(desktop)], [null, 340, 41], what)
        assert.deepEqual(desktop.backups.map(b => b.kind), sent ? ['pre-sync'] : ['pre-sync', 'sync-declined'], `${what}: nothing asked, nothing backed up`)
      }
    })

    /**
     * The browser that kept goes on weighing what arrives against its *Keep*
     * while the line it agrees with comes from it, past the first upload that
     * saw it: the other browser's *Keep* can still arrive later, in an upload
     * written over it.
     */
    test('the other browser that kept, offline across the race, landing an edit over uploads that saw the first\'s Keep: the first is asked, backed up first', async () => {
      const { cloud, laptop, desktop, tablet } = await bothAsked(['desktop', 'tablet'])
      tablet.peer.online = false
      await allKeep(desktop, tablet)
      await cloud.run()
      await laptop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.deepEqual([desktop.meta.pause, ...ownOf(desktop)], [null, 330, 41], 'precondition: the desktop took the laptop\'s edit over its settings')

      await tablet.edit({ wordsPerMinute: 311 })
      assert.equal(await tablet.pushOffline(), true)
      tablet.peer.online = true
      await cloud.run()
      assert.match(cloud.manifest().w, /^tablet-/, 'precondition: the tablet\'s edit landed last')
      assert.equal(desktop.meta.pause?.otherCopy, true, 'the desktop asked')
      assert.deepEqual(ownOf(desktop), [330, 41], 'nothing replaced')
      assert.deepEqual(desktop.backups.at(-1), { kind: 'sync-held', options: desktop.options })
      assert.equal(tablet.meta.pause, null)
    })

    /**
     * A question a copy that never saw this browser's *Keep* raised goes only
     * once a copy that did is there again: an upload of an older line, under
     * the copy's ID, doesn't end it.
     */
    test('a question over a copy that never saw this browser\'s Keep stands over an older upload landing under the copy\'s ID, and this browser\'s edits wait', async () => {
      const { cloud, browsers: [laptop, phone] } = await inSync('laptop', 'phone')
      phone.peer.online = false
      await phone.edit({ wordsPerMinute: 205 })
      assert.equal(await phone.pushOffline(), true)
      await laptop.edit({ wordsPerMinute: 210 })
      await cloud.run()

      const desktop = createDevice(cloud, 'desktop', { options: DESKTOP })
      const tablet = createDevice(cloud, 'tablet', { options: TABLET })
      for (const browser of [desktop, tablet])
        await browser.settle()
      for (const browser of [desktop, tablet])
        await browser.enableSync()
      await cloud.run()
      await allKeep(desktop, tablet)
      await cloud.run()
      await laptop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.equal(desktop.meta.pause?.otherCopy, true, 'precondition: the desktop asked over the laptop\'s edit to the tablet\'s settings')
      const asked = { g: desktop.meta.pause.g, w: desktop.meta.pause.w }

      phone.peer.online = true
      await cloud.run()
      assert.match(cloud.manifest().w, /^phone-/, 'precondition: the phone\'s upload, from before either Keep, landed last')
      assert.ok(cloud.manifest().g < desktop.meta.meta.g, 'precondition: at an older generation, which isn\'t pulled')
      assert.deepEqual({ g: desktop.meta.pause?.g, w: desktop.meta.pause?.w }, asked, 'still asked')

      await desktop.edit({ wordsPerMinute: 321 })
      await desktop.edit({ wordsPerMinute: 322 })
      await cloud.run()
      assert.match(cloud.manifest().w, /^phone-/, 'nothing of the desktop\'s sent')
      assert.deepEqual(ownOf(tablet), [330, 42])
    })
  })

  /**
   * The sync service doesn't promise that the parts of one upload arrive
   * together, so a browser can read a synced copy whose manifest names parts
   * that aren't there, or don't match it. While it can't be read whole,
   * another browser is taken to be still sending it: the read is retried, and
   * keeping this browser's settings, which backs the synced ones up first, is
   * refused. Still so past the wait, the options page says the synced settings
   * are inconsistent and offers to replace them with this browser's.
   */
  describe('a synced copy that can\'t be read whole', () => {
    const WAIT = SYNC_CONSISTENCY_WAIT_MS
    /** Settings of the desktop's own: the reader's, with a rule more and a reading speed of its own. */
    const OWN = { ...MAIN, rules: rulesFixture(41), wordsPerMinute: 320 }

    /** The manifest of `sender`'s newest upload reaches `receiver` ahead of its parts. */
    async function manifestFirst(sender, receiver) {
      await receiver.receive({ ...receiver.synced, [MANIFEST_KEY]: sender.synced[MANIFEST_KEY] })
    }

    /** `sender` uploads `update`, and its parts never reach the sync service: only its manifest does, which every browser then reads. */
    async function partsLost(cloud, sender, update) {
      await sender.edit(update)
      await sender.react()
      sender.peer.outbox = sender.peer.outbox.filter(([key]) => key === MANIFEST_KEY)
      await cloud.run()
    }

    /** The synced copy as the sync service holds it, decoded. */
    const served = cloud => decode(Object.fromEntries(cloud.server))

    /** What the options page says of `browser`'s sync. */
    const panelOf = browser => syncStatusView({ ...browser.meta, staleBuild: false, backgroundOutdated: false }, SYNC_SCHEMA_VERSION)
    const inconsistentCallout = browser => panelOf(browser).callouts.find(callout => callout.state === 'inconsistent')

    /** The upload `manifest` names: its generation and writer token. */
    const uploadOf = manifest => ({ g: manifest.g, w: manifest.w })

    test('turning sync on: a copy caught partway is waited on, and keeping this browser\'s settings refused, until the rest arrives', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN, meta: { backupsEnabled: false } })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      const question = desktop.meta.pause
      assert.equal(question?.reason, 'first-sync', 'precondition: asked')

      await laptop.edit({ wordsPerMinute: 250 })
      await laptop.react()
      await manifestFirst(laptop, desktop)
      assert.deepEqual(desktop.meta.inconsistent, { since: desktop.meta.inconsistent?.since, overdue: false, replaceable: false, upload: uploadOf(laptop.synced[MANIFEST_KEY]) })
      assert.equal(typeof desktop.meta.inconsistent.since, 'number')
      assert.deepEqual(desktop.meta.pause, question, 'the question stands')

      assert.deepEqual(await desktop.answer('keep'), { resolved: false, refused: 'sending' })
      assert.deepEqual(desktop.meta.pause, question, 'nothing cleared')
      assert.deepEqual(desktop.peer.outbox, [], 'nothing sent')
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'], 'nothing backed up')
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.equal(inconsistentCallout(desktop), undefined, 'nothing said within the wait')

      // The rest arrives: the question is asked again, over the whole copy.
      await cloud.run()
      assert.equal(desktop.meta.inconsistent, null)
      assert.equal(desktop.meta.pause?.reason, 'first-sync')
      assert.deepEqual([desktop.meta.pause.g, desktop.meta.pause.w], [cloud.manifest().g, cloud.manifest().w])
      assert.equal(desktop.options.wordsPerMinute, 320)

      assert.deepEqual(await desktop.answer('keep'), { resolved: true })
      await cloud.run()
      assert.equal(laptop.options.wordsPerMinute, 320)
      assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320], ['sync-declined', 250]], 'the copy kept over, once whole, backed up first')
    })

    test('a held update: keeping this browser\'s settings is refused while a newer copy is caught partway', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await desktop.edit({ rules: rulesFixture(1) })
      await cloud.run()
      const hold = laptop.meta.pause
      assert.equal(hold?.reason, 'held', 'precondition: held')

      await desktop.edit({ wordsPerMinute: 250 })
      await desktop.react()
      await manifestFirst(desktop, laptop)
      assert.deepEqual(await laptop.answer('keep'), { resolved: false, refused: 'sending' })
      assert.deepEqual(laptop.meta.pause, hold, 'nothing cleared')
      assert.deepEqual(laptop.peer.outbox, [], 'nothing sent')
      assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held'], 'nothing backed up')
      assert.equal(laptop.options.rules.filters.length, 40)

      await cloud.run()
      assert.equal(laptop.meta.inconsistent, null)
      assert.equal(laptop.meta.pause?.reason, 'held', 'held again, over the whole copy')
      assert.deepEqual([laptop.meta.pause.g, laptop.meta.pause.w], [cloud.manifest().g, cloud.manifest().w])
    })

    /**
     * Using the synced settings applies nothing of a copy that can't be read,
     * so it is refused as keeping is: the question stands, and nothing is
     * backed up, applied or cleared.
     */
    test('turning sync on: using the synced settings over a copy caught partway is refused as keeping them is, until the rest arrives', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN, meta: { backupsEnabled: false } })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      await desktop.edit({ wordsPerMinute: 330 })
      const question = desktop.meta.pause
      assert.equal(question?.reason, 'first-sync', 'precondition: asked')

      await laptop.edit({ wordsPerMinute: 250 })
      await laptop.react()
      await manifestFirst(laptop, desktop)
      assert.deepEqual(await desktop.answer('accept'), { resolved: false, refused: 'sending' })
      assert.deepEqual(desktop.meta.pause, question, 'nothing cleared')
      assert.deepEqual(desktop.backups.map(b => b.kind), ['pre-sync'], 'nothing backed up')
      assert.equal(desktop.options.wordsPerMinute, 330, 'nothing applied')
      assert.deepEqual(desktop.peer.outbox, [], 'nothing sent')

      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'asked again, over the whole copy')
      assert.deepEqual(await desktop.answer('accept'), { resolved: true })
      assert.equal(desktop.options.wordsPerMinute, 250)
      assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320], ['pre-sync', 330]], 'backed up as it applied, once whole')
    })

    /**
     * The answer reads the synced copy once: what it applies is the copy it
     * found whole, though a newer upload starts arriving as it backs up. The
     * newer one is weighed in its turn, as any update is.
     */
    test('turning sync on: using the synced settings applies the copy it found whole, though a newer upload starts arriving as it backs up', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN, meta: { backupsEnabled: false } })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      await desktop.edit({ wordsPerMinute: 330 })
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'precondition: asked')
      const found = cloud.manifest()

      await laptop.edit({ wordsPerMinute: 250 })
      await laptop.react()
      const newer = laptop.synced[MANIFEST_KEY]
      desktop.whileBackingUp(() => {
        desktop.peer.view.set(MANIFEST_KEY, newer)
        desktop.peer.notify({ [MANIFEST_KEY]: { newValue: newer } })
      })
      assert.deepEqual(await desktop.answer('accept'), { resolved: true })
      assert.equal(desktop.options.wordsPerMinute, 200, 'the copy it found whole, applied')
      assert.deepEqual([desktop.meta.meta.g, desktop.meta.meta.w], [found.g, found.w])
      assert.deepEqual(desktop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['pre-sync', 320], ['pre-sync', 330]])
      assert.deepEqual(desktop.meta.inconsistent?.upload, uploadOf(newer), 'the newer one waited on')

      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 250, 'the newer one, whole, taken as an update')
    })

    test('a held update: accepting it is refused too while a newer copy is caught partway', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await desktop.edit({ rules: rulesFixture(1) })
      await cloud.run()
      const hold = laptop.meta.pause
      assert.equal(hold?.reason, 'held', 'precondition: held')

      await desktop.edit({ wordsPerMinute: 250 })
      await desktop.react()
      await manifestFirst(desktop, laptop)
      assert.deepEqual(await laptop.answer('accept'), { resolved: false, refused: 'sending' })
      assert.deepEqual(laptop.meta.pause, hold, 'nothing cleared')
      assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held'], 'nothing backed up')
      assert.equal(laptop.options.rules.filters.length, 40, 'nothing applied')
    })

    test('past the wait, either answer to a question over the copy is refused, saying it is inconsistent', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      const question = desktop.meta.pause
      assert.equal(question?.reason, 'first-sync', 'precondition: asked')

      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.overdue, true, 'precondition: past the wait')
      for (const choice of ['accept', 'keep'])
        assert.deepEqual(await desktop.answer(choice), { resolved: false, refused: 'inconsistent' }, choice)
      assert.deepEqual(desktop.meta.pause, question)
      assert.equal(desktop.options.wordsPerMinute, 320)
    })

    /** Within the wait another browser is taken to be still sending it, and past it the record says so: a read error would say the same less helpfully. */
    test('caught partway, it records no read error, through the read\'s retries and past the wait', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      assert.equal(desktop.meta.inconsistent?.overdue, false, 'precondition: waiting')
      assert.equal(desktop.meta.lastError, '')
      assert.equal(panelOf(desktop).chip.state, 'syncing')

      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.lastError, '')
      assert.deepEqual(panelOf(desktop).callouts.map(callout => callout.state), ['inconsistent'])
    })

    test('a read error an earlier build recorded goes once the copy reads whole and raises a question', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await laptop.setMeta({ lastError: 'Could not read synced data (incomplete).' })
      await desktop.edit({ rules: rulesFixture(1) })
      await cloud.run()
      assert.equal(laptop.meta.pause?.reason, 'held', 'precondition: held')
      assert.equal(laptop.meta.lastError, '')
      assert.deepEqual(panelOf(laptop).callouts.map(callout => callout.state), ['held'])
    })

    /** A question sends and applies nothing, so an upload that failed, as one over the quota does, has still failed. */
    test('an upload\'s error stays as the copy raises a question', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      const failed = 'Settings are too large to sync — reduce filter lists or text replacements.'
      await laptop.setMeta({ lastError: failed })
      await desktop.edit({ rules: rulesFixture(1) })
      await cloud.run()
      assert.equal(laptop.meta.pause?.reason, 'held', 'precondition: held')
      assert.equal(laptop.meta.lastError, failed)
      assert.deepEqual(panelOf(laptop).callouts.map(callout => callout.state), ['error', 'held'])
    })

    /**
     * The wait runs from when this browser first read an upload partial. A
     * newer upload, caught partway in its turn, may still be on its way, so it
     * is waited on afresh, however long the one before had been.
     */
    test('a newer upload caught partway is waited on afresh', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      const first = desktop.meta.inconsistent
      assert.equal(first?.overdue, false, 'precondition: waiting')

      desktop.advance(WAIT / 2)
      await partsLost(cloud, laptop, { wordsPerMinute: 260 })
      const second = desktop.meta.inconsistent
      assert.deepEqual(second.upload, uploadOf(cloud.manifest()))
      assert.notDeepEqual(second.upload, first.upload)
      assert.equal(second.since, first.since + WAIT / 2, 'from when the newer upload was read')

      desktop.advance(WAIT / 2)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent.overdue, false, 'not past at the first upload\'s wait')
      assert.equal(inconsistentCallout(desktop), undefined)
      assert.equal(await desktop.replace(), false)

      desktop.advance(WAIT / 2)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent.overdue, true, 'past at its own, read again as it ends')
      assert.equal(inconsistentCallout(desktop).decision.answers[0].choice, 'replace')
    })

    /** A record kept by a build that didn't say which upload it was read under can't tell whether a newer one is arriving. */
    test('a record with no upload, past the wait, is waited on afresh as the copy is next read, then offers again', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      const { upload, ...kept } = desktop.meta.inconsistent
      await desktop.setMeta({ inconsistent: { ...kept, since: kept.since - WAIT, overdue: true, replaceable: true } })
      await desktop.restart()
      assert.equal(inconsistentCallout(desktop).decision.answers[0].choice, 'replace', 'precondition: offered, as it was kept')

      assert.equal(await desktop.replace(), false, 'read again, waited on afresh')
      assert.deepEqual(desktop.meta.inconsistent, { since: kept.since, overdue: false, replaceable: false, upload })
      assert.equal(inconsistentCallout(desktop), undefined)

      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent.overdue, true, 'read again as its wait ends')
      assert.equal(await desktop.replace(), true)
      await cloud.run()
      assert.equal((await served(cloud)).ok, true, 'replaced')
      assert.equal(desktop.meta.inconsistent, null)
    })

    test('still partial past the wait: inconsistent, with the offer to replace it with this browser\'s settings', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      assert.equal((await served(cloud)).ok, false, 'precondition: the synced copy can\'t be read whole')
      assert.equal(desktop.meta.inconsistent?.overdue, false)
      assert.equal(desktop.options.wordsPerMinute, 200)
      assert.equal(laptop.meta.inconsistent, null, 'the laptop agreed on its own upload, and reads nothing')

      assert.equal(await desktop.replace(), false, 'no offer within the wait')
      assert.deepEqual(desktop.peer.outbox, [])

      desktop.advance(WAIT - 1)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent.overdue, false, 'not before the wait is up')
      assert.equal(inconsistentCallout(desktop), undefined)

      desktop.advance(1)
      await cloud.run()
      assert.deepEqual(desktop.meta.inconsistent, { since: desktop.meta.inconsistent.since, overdue: true, replaceable: true, upload: uploadOf(cloud.manifest()) })
      const callout = inconsistentCallout(desktop)
      assert.equal(panelOf(desktop).chip.state, 'inconsistent')
      assert.deepEqual(callout.decision.answers.map(answer => answer.choice), ['replace'])
      assert.deepEqual(await desktop.answer('keep'), { resolved: false }, 'nothing asked, so nothing to keep')
    })

    /**
     * The replacement goes up under a new ID, so every other browser weighs it
     * as a copy another browser started: where its own settings differ, it
     * asks, backed up first, and where they don't, it takes the copy's ID with
     * no question.
     */
    test('the offer replaces the synced copy with this browser\'s settings under a new ID, which each other browser weighs', async () => {
      const { cloud, browsers: [laptop, desktop, tablet] } = await inSync('laptop', 'desktop', 'tablet')
      const id = cloud.manifest().i
      const tabletBackups = tablet.backups
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.replaceable, true, 'precondition: offered')

      assert.equal(await desktop.replace(), true)
      await cloud.run()
      const replaced = await served(cloud)
      assert.equal(replaced.ok, true, 'whole again')
      assert.equal(replaced.options.wordsPerMinute, undefined, 'this browser\'s settings: the reading speed at its default')
      assert.equal(replaced.options.rules.filters.length, 40)
      assert.match(cloud.manifest().w, /^desktop-/)
      assert.equal(typeof cloud.manifest().i, 'string')
      assert.notEqual(cloud.manifest().i, id, 'under a new ID')
      assert.equal(desktop.meta.meta.i, cloud.manifest().i)
      assert.equal(desktop.meta.inconsistent, null)
      assert.equal(desktop.meta.lastError, '')
      assert.equal(desktop.options.wordsPerMinute, 200, 'this browser\'s own settings untouched')

      assert.equal(laptop.meta.pause?.reason, 'first-sync', 'the laptop\'s own settings differ: asked')
      assert.equal(laptop.meta.pause.otherCopy, true)
      assert.equal(laptop.options.wordsPerMinute, 250, 'nothing replaced')
      assert.deepEqual(laptop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['sync-held', 250]], 'backed up first')

      assert.equal(tablet.meta.pause, null, 'the tablet\'s settings are the same: no question')
      assert.equal(tablet.meta.inconsistent, null)
      assert.equal(tablet.meta.meta.i, cloud.manifest().i)
      assert.deepEqual(tablet.backups, tabletBackups, 'nothing to back up')
    })

    /**
     * Each replacement goes up under a new ID of its own, so the browser
     * whose replacement is replaced weighs the other's as a copy another
     * browser started, as every other browser does. Where the two stand
     * apart, a replacement losing the generation's tie-break, the next upload
     * of either is weighed so by the other.
     */
    test('two browsers replacing the synced copy at about once: the one replaced asks before using the other\'s, backed up first', async () => {
      for (const order of [['desktop', 'tablet'], ['tablet', 'desktop']]) {
        const { cloud, browsers } = await inSync('laptop', ...order)
        const { laptop, desktop, tablet } = Object.fromEntries(browsers.map(browser => [browser.name, browser]))
        await partsLost(cloud, laptop, { wordsPerMinute: 250 })
        // Edits made while the copy can't be read whole wait here.
        await desktop.edit({ wordsPerMinute: 300 })
        await tablet.edit({ wordsPerMinute: 310 })
        for (const browser of [desktop, tablet])
          browser.advance(WAIT)
        await cloud.run()
        for (const browser of [desktop, tablet])
          assert.equal(browser.meta.inconsistent?.replaceable, true, `precondition: ${browser.name} offered`)

        assert.equal(await desktop.replace(), true)
        assert.equal(await tablet.replace(), true)
        await cloud.run()
        assert.match(cloud.manifest().w, new RegExp(`^${order[1]}-`), `precondition: the ${order[1]}'s replacement landed last`)
        if (order[1] === 'desktop') {
          assert.equal(tablet.meta.pause, null, 'precondition: the tablet, whose replacement wins the tie-break, took no notice of the desktop\'s')
          await tablet.edit({ wordsPerMinute: 311 })
          await cloud.run()
        }
        assert.equal(desktop.meta.pause?.otherCopy, true, `${order}: the desktop asked`)
        assert.equal(desktop.options.wordsPerMinute, 300, `${order}: nothing replaced`)
        assert.deepEqual(desktop.backups.at(-1), { kind: 'sync-held', options: desktop.options }, `${order}: backed up first`)
        assert.equal(laptop.meta.pause?.otherCopy, true, `${order}: the laptop asked`)
        assert.equal(laptop.options.wordsPerMinute, 250, `${order}: nothing replaced`)
      }
    })

    test('two browsers keeping their own over the replacement at about once: the one replaced unseen is asked again', async () => {
      const { cloud, browsers: [laptop, desktop, tablet] } = await inSync('laptop', 'desktop', 'tablet')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      await tablet.edit({ wordsPerMinute: 310 })
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(await desktop.replace(), true)
      await cloud.run()
      for (const browser of [laptop, tablet])
        assert.equal(browser.meta.pause?.otherCopy, true, `precondition: ${browser.name} asked over the replacement`)

      for (const browser of [laptop, tablet])
        assert.equal(await browser.resolveHeld('keep'), true)
      await cloud.run()
      assert.match(cloud.manifest().w, /^tablet-/, 'precondition: the tablet\'s landed last')
      assert.equal(laptop.meta.pause?.otherCopy, true, 'the laptop asked again')
      assert.equal(laptop.meta.pause.backedUp, true)
      assert.equal(laptop.options.wordsPerMinute, 250, 'nothing replaced')
      assert.deepEqual(laptop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['sync-held', 250], ['sync-declined', 200]], 'the backup taken as it was first asked holds its settings')
      assert.equal(tablet.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 310, 'the desktop, which kept nothing over it, takes the tablet\'s')
    })

    /**
     * A replacement holding nothing beyond defaults would ask no other browser
     * anything: each one holding settings of its own would send them over it
     * at about once, and the one landing last would reach the rest as an
     * ordinary update, with no backup: the laptop's own edits among them.
     */
    test('a browser holding nothing beyond defaults is offered no replacement', async () => {
      const cloud = createCloud()
      const browsers = []
      for (const [name, options] of [['laptop', MAIN], ['desktop', {}], ['tablet', {}]]) {
        const browser = createDevice(cloud, name, { options, meta: { backupsEnabled: false } })
        await browser.enableSync()
        await cloud.run()
        browsers.push(browser)
      }
      const [laptop] = browsers
      await partsLost(cloud, laptop, { wordsPerMinute: 250, rules: rulesFixture(42) })
      const fresh = createDevice(cloud, 'fresh', { meta: { backupsEnabled: false } })
      await fresh.enableSync()
      await cloud.run()
      fresh.advance(WAIT)
      await cloud.run()
      assert.equal(fresh.meta.inconsistent?.overdue, true, 'precondition: past the wait')

      assert.equal(fresh.meta.inconsistent.replaceable, false)
      assert.equal(inconsistentCallout(fresh).decision, undefined, 'said, with no offer')
      assert.equal(await fresh.replace(), false)
      await cloud.run()
      assert.equal((await served(cloud)).ok, false, 'nothing sent')
      assert.deepEqual([laptop.options.wordsPerMinute, laptop.options.rules.filters.length], [250, 42], 'the laptop\'s own edits stand')
    })

    test('a question standing over a copy that has since gone partial is ended by the replacement', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'precondition: asked')

      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.replaceable, true, 'precondition: offered')
      assert.equal(await desktop.replace(), true)
      await cloud.run()

      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 320)
      assert.equal((await served(cloud)).options.wordsPerMinute, 320)
      await desktop.edit({ wordsPerMinute: 330 })
      await cloud.run()
      assert.equal((await served(cloud)).options.wordsPerMinute, 330, 'syncing again')
    })

    test('a part changing under the copy a question was asked over is read again as the wait ends', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'first-sync', 'precondition: asked')

      // Another upload's part lands under the same manifest, which the pull has already weighed.
      const writer = createDevice(createCloud(), 'writer', { options: { wordsPerMinute: 250 } })
      await writer.enableSync()
      cloud.server.set('o0', writer.synced.o0)
      cloud.deliver()
      await desktop.settle()
      assert.equal((await served(cloud)).ok, false, 'precondition: the synced copy can\'t be read whole')
      assert.equal(desktop.meta.inconsistent, null, 'precondition: the pull doesn\'t read the copy it asked over again')

      assert.deepEqual(await desktop.answer('keep'), { resolved: false, refused: 'sending' })
      desktop.advance(WAIT)
      await cloud.run()
      assert.deepEqual(desktop.meta.inconsistent, { since: desktop.meta.inconsistent?.since, overdue: true, replaceable: true, upload: uploadOf(cloud.manifest()) })
    })

    test('past the wait, the copy a question was asked over read whole again ends the record', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { options: OWN })
      await desktop.settle()
      await desktop.enableSync()
      await cloud.run()
      const question = desktop.meta.pause
      assert.equal(question?.reason, 'first-sync', 'precondition: asked')

      const part = cloud.server.get('o0')
      const writer = createDevice(createCloud(), 'writer', { options: { wordsPerMinute: 250 } })
      await writer.enableSync()
      cloud.server.set('o0', writer.synced.o0)
      cloud.deliver()
      await desktop.settle()
      await desktop.answer('keep')
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.overdue, true, 'precondition: past the wait')

      cloud.server.set('o0', part)
      cloud.deliver()
      await desktop.settle()
      await cloud.run()
      assert.equal((await served(cloud)).ok, true, 'precondition: whole again')
      assert.equal(desktop.meta.inconsistent, null)
      assert.equal(inconsistentCallout(desktop), undefined)
      assert.deepEqual(desktop.meta.pause, question, 'the question stands')
    })

    test('the wait outlasts the worker restarting', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      assert.equal(desktop.meta.inconsistent?.overdue, false, 'precondition: waiting')
      await desktop.restart()
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.overdue, true)
    })

    test('a newer sync version\'s copy, whole or not, gets no offer: the version pause applies', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      assert.equal(desktop.meta.inconsistent?.overdue, false, 'precondition: waiting on a copy at this version')

      await laptop.restart({ version: SYNC_SCHEMA_VERSION + 1, init: true })
      await cloud.run()
      assert.equal(cloud.manifest().v, SYNC_SCHEMA_VERSION + 1)
      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.meta.inconsistent, null)

      await partsLost(cloud, laptop, { wordsPerMinute: 260 })
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.meta.inconsistent, null)
      assert.equal(inconsistentCallout(desktop), undefined)
      assert.equal(await desktop.replace(), false)
    })

    test('turning sync off forgets it, and turning it on again waits afresh', async () => {
      const { cloud, browsers: [laptop, desktop] } = await inSync('laptop', 'desktop')
      await partsLost(cloud, laptop, { wordsPerMinute: 250 })
      desktop.advance(WAIT)
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.overdue, true, 'precondition: past the wait')

      await desktop.disableSync()
      assert.equal(desktop.meta.inconsistent, null)
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.meta.inconsistent?.overdue, false)
    })
  })

  test('the incident: a stale build\'s partial copy can\'t cost the main browser its rules or marks', async () => {
    const cloud = createCloud()
    const laptop = mainBrowser(cloud, 'laptop', { version: 1 })
    await laptop.enableSync()
    await cloud.run()
    createLegacyDevice(cloud, 'legacy', { knownKeys: LEGACY_KNOWN, legacyOptions: LEGACY_ONLY })

    // Every change on the laptop is echoed back as a copy without rules or marks.
    await laptop.edit({ textReplacements: textReplacementsFixture(11) })
    await cloud.run()
    assert.match(cloud.manifest().w, /^legacy\./, 'precondition: the newest cloud copy is the stale build\'s')

    // A second browser turns sync on against that copy, then marks two works.
    const fresh = createDevice(cloud, 'fresh', { version: 1 })
    await fresh.enableSync()
    await cloud.run()
    await fresh.edit({ workMarks: marksFixture(range(5000, 2)) })
    await cloud.run()

    assert.equal(laptop.options.rules.filters.length, 40, 'rules survive')
    assert.equal(markedWorks(laptop.options).size, 60, 'marked works survive')
    assert.equal(laptop.options.textReplacements.rules.length, 11)
    // On one sync version, the guard is what catches it: the fresh browser's
    // copy (rules empty, two marked works) was held rather than applied. The
    // stale build then echoed a newer copy that leaves rules and marks alone,
    // which is within bounds, so it applied and superseded the held one.
    assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held'])
    assert.equal(laptop.meta.pause, null)
  })

  describe('sync versions', () => {
    // The build under test speaks the current version; `V + 1` stands for a
    // newer build, and version 1 for the stale build the legacy device mimics.
    const V = SYNC_SCHEMA_VERSION

    test('rollout: an older build\'s copy is waited on, not adopted, until an updated browser replaces it', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud, 'laptop', { version: 1 })
      await laptop.enableSync()
      await cloud.run()
      const legacy = createLegacyDevice(cloud, 'legacy', { knownKeys: LEGACY_KNOWN, legacyOptions: LEGACY_ONLY })
      await laptop.edit({ textReplacements: textReplacementsFixture(11) })
      await cloud.run()
      assert.equal(cloud.manifest().v, 1, 'precondition: the cloud holds the stale build\'s copy')

      // A browser on the new build turns sync on. It can't adopt that copy and
      // has nothing agreed of its own to replace it with.
      const fresh = createDevice(cloud, 'fresh')
      await fresh.enableSync()
      await cloud.run()
      assert.equal(fresh.meta.pause?.reason, 'older-cloud')
      assert.equal(fresh.options.rules.filters.length, 0)
      assert.equal(cloud.manifest().v, 1, 'nothing pushed over it')

      // The laptop is updated, and moves the cloud to the new version.
      const pushes = legacy.pushes
      await laptop.restart({ version: V, init: true })
      await cloud.run()

      assert.equal(cloud.manifest().v, V)
      assert.equal(legacy.pushes, pushes, 'the stale build went quiet')
      assert.equal(fresh.meta.pause, null)
      assert.equal(fresh.options.rules.filters.length, 40)
      assert.equal(markedWorks(fresh.options).size, 60)
      assert.equal(fresh.options.textReplacements.rules.length, 11)
      assert.equal(laptop.options.rules.filters.length, 40)
      assert.deepEqual(fresh.backups.map(b => b.kind), ['pre-sync'], 'its own settings were backed up before adopting')
    })

    test('a newer build\'s copy pauses an older browser, which resumes once updated', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()

      // The laptop is updated to a build with a higher sync version.
      await laptop.restart({ version: V + 1, init: true })
      await cloud.run()
      assert.equal(cloud.manifest().v, V + 1)

      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.meta.pause.remoteVersion, V + 1)
      await desktop.edit({ wordsPerMinute: 123 })
      await cloud.run()
      assert.equal(desktop.meta.dirty, false, 'edits on the outdated build aren\'t queued to sync')
      assert.equal(cloud.manifest().v, V + 1)

      // A browser on the old build can't turn sync on at all.
      const fresh = createDevice(cloud, 'fresh')
      const result = await fresh.enableSync()
      assert.deepEqual(result, { ok: false, reason: 'newer-version', remoteVersion: V + 1, version: V })
      assert.equal(fresh.meta.enabled, false)

      await laptop.edit({ wordsPerMinute: 321 })
      await cloud.run()
      await desktop.restart({ version: V + 1, init: true })
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assert.equal(desktop.options.wordsPerMinute, 321, 'the update adopted the newer copy')
    })

    test('an offline old build overwriting the cloud is replaced, not adopted', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()

      const legacy = createLegacyDevice(cloud, 'legacy', { knownKeys: LEGACY_KNOWN, legacyOptions: LEGACY_ONLY })
      await legacy.overwrite()
      await cloud.run()

      assert.equal(cloud.manifest().v, V, 'the current version is back')
      for (const browser of [laptop, desktop]) {
        assert.equal(browser.options.rules.filters.length, 40, `${browser.name} kept its rules`)
        assert.equal(markedWorks(browser.options).size, 60, `${browser.name} kept its marks`)
        assert.equal(browser.meta.pause, null)
      }
    })
  })

  describe('an update that would remove most of a list', () => {
    /** A laptop (set up with `laptopSettings`) and desktop in sync, then the desktop deletes 39 of the 40 rules. */
    async function bulkDelete(laptopSettings = {}) {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud, 'laptop', laptopSettings)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()
      await desktop.edit({ rules: rulesFixture(1) })
      await cloud.run()
      return { cloud, laptop, desktop }
    }

    test('is held, backed up once, and blocks this browser\'s pushes', async () => {
      const { cloud, laptop } = await bulkDelete()
      assert.equal(laptop.options.rules.filters.length, 40)
      assert.equal(laptop.meta.pause?.reason, 'held')
      assert.equal(laptop.meta.pause.backedUp, true)

      // Hearing about the same copy again doesn't re-assess or re-back-up it,
      // and the laptop's own edits wait instead of answering for the reader.
      const before = cloud.manifest()
      await laptop.edit({ wordsPerMinute: 999 })
      await cloud.run()
      assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held'])
      assert.equal(cloud.manifest().w, before.w, 'nothing pushed while held')
    })

    /** Accepting replaces every setting, so this browser's are backed up whatever daily backups say. */
    test('is backed up with daily backups off', async () => {
      const { laptop } = await bulkDelete({ meta: { backupsEnabled: false } })
      assert.equal(laptop.meta.pause?.reason, 'held')
      assert.equal(laptop.meta.pause.backedUp, true)
      assert.equal(laptop.meta.pause.backupFailed, false)
      assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held'])
      assert.deepEqual(laptop.backups[0].options, laptop.options, 'this browser\'s own settings, as they were held over')
    })

    test('is held all the same when backups can\'t be written, daily backups on or off, and records that its backup failed', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { laptop } = await bulkDelete({ failBackups: true, meta: { backupsEnabled } })
        assert.equal(laptop.options.rules.filters.length, 40, `not applied, ${daily}`)
        assert.equal(laptop.meta.pause?.reason, 'held', daily)
        assert.equal(laptop.meta.pause.backedUp, false, daily)
        assert.equal(laptop.meta.pause.backupFailed, true, daily)
        assert.deepEqual(laptop.backups, [], daily)
      }
    })

    test('one whose backup failed is accepted at the first press, daily backups on or off: it already says yours aren\'t backed up', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { cloud, laptop } = await bulkDelete({ failBackups: true, meta: { backupsEnabled } })
        assert.equal(await laptop.resolveHeld('accept'), true, daily)
        await cloud.run()
        assert.equal(laptop.meta.pause, null, daily)
        assert.equal(laptop.options.rules.filters.length, 1, daily)
      }
    })

    test('"keep" pushes this browser\'s list back and saves the declined copy', async () => {
      const { cloud, laptop, desktop } = await bulkDelete()
      assert.equal(await laptop.resolveHeld('keep'), true)
      await cloud.run()

      assert.equal(laptop.meta.pause, null)
      assert.equal(desktop.options.rules.filters.length, 40, 'the laptop\'s rules won')
      const declined = laptop.backups.find(b => b.kind === 'sync-declined')
      assert.equal(declined?.options.rules.filters.length, 1, 'the desktop\'s version is restorable')
    })

    test('"accept" applies it', async () => {
      const { cloud, laptop } = await bulkDelete()
      assert.equal(await laptop.resolveHeld('accept'), true)
      await cloud.run()

      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.rules.filters.length, 1)
      assert.equal(laptop.meta.dirty, false)
    })

    /** Accepting replaces the edits made while it was held too, which the hold's backup doesn't hold. */
    test('"accept" backs this browser\'s settings up again as it applies, with what changed while it was held, daily backups on or off', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { cloud, laptop } = await bulkDelete({ meta: { backupsEnabled } })
        await laptop.edit({ wordsPerMinute: 999, textReplacements: textReplacementsFixture(12) })
        assert.equal(await laptop.resolveHeld('accept'), true, daily)
        await cloud.run()

        assert.equal(laptop.meta.pause, null, daily)
        assert.equal(laptop.options.rules.filters.length, 1, daily)
        assert.equal(laptop.options.wordsPerMinute, OPTION_DEFAULTS.wordsPerMinute, `the edit made while held is replaced too, ${daily}`)
        assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held', 'sync-held'], daily)
        const [held, accepted] = laptop.backups
        assert.equal(held.options.wordsPerMinute, OPTION_DEFAULTS.wordsPerMinute, `the hold's backup: the settings as it held, ${daily}`)
        assert.equal(accepted.options.wordsPerMinute, 999, `and as they were replaced, ${daily}`)
        assert.equal(accepted.options.textReplacements.rules.length, 12, daily)
        assert.equal(accepted.options.rules.filters.length, 40, daily)
        assert.equal(laptop.dailyBackups.length, backupsEnabled ? 1 : 0, `the day's backup is its own, ${daily}`)
      }
    })

    test('"accept" with nothing changed since it was held backs up nothing more: the hold\'s backup holds what it replaces', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { cloud, laptop } = await bulkDelete({ meta: { backupsEnabled } })
        assert.equal(await laptop.resolveHeld('accept'), true, daily)
        await cloud.run()
        assert.equal(laptop.options.rules.filters.length, 1, daily)
        assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held'], daily)
        assert.equal(laptop.backups[0].options.rules.filters.length, 40, daily)
      }
    })

    /** As "use" does, when its own backup fails: see the same test under turning sync on. */
    test('a backup that can\'t be written as "accept" applies refuses the first press, which then says yours aren\'t backed up; a second press applies, daily backups on or off', async () => {
      for (const backupsEnabled of [true, false]) {
        const daily = `daily backups ${backupsEnabled ? 'on' : 'off'}`
        const { cloud, laptop } = await bulkDelete({ meta: { backupsEnabled } })
        await laptop.edit({ wordsPerMinute: 999 })
        laptop.breakBackups()
        const hold = laptop.meta.pause

        assert.deepEqual(await laptop.answer('accept'), { resolved: false, refused: 'unbacked' }, daily)
        assert.deepEqual(laptop.meta.pause, { ...hold, backedUp: false, backupFailed: true }, daily)
        assert.equal(laptop.options.rules.filters.length, 40, `nothing applied, ${daily}`)
        const decision = decisionOn(laptop.meta.pause)
        assert.equal(decision.backup, null, daily)
        assert.equal(consequence(decision, 'accept'), 'Replaces this browser\'s settings with the other browser\'s. Yours aren\'t backed up: the backup couldn\'t be saved.', daily)

        assert.equal(await laptop.resolveHeld('accept'), true, daily)
        await cloud.run()
        assert.equal(laptop.meta.pause, null, daily)
        assert.equal(laptop.options.rules.filters.length, 1, daily)
        assert.deepEqual(laptop.backups.map(b => [b.kind, b.options.wordsPerMinute]), [['sync-held', OPTION_DEFAULTS.wordsPerMinute]], daily)
      }
    })

    test('the day\'s backup that can\'t be written as "accept" applies refuses the first press the same way', async () => {
      const { laptop } = await bulkDelete({ meta: { backupsEnabled: true } })
      await laptop.setMeta({ lastBackupDate: '' })
      laptop.breakBackups()
      assert.deepEqual(await laptop.answer('accept'), { resolved: false, refused: 'unbacked' })
      assert.deepEqual([laptop.meta.pause?.reason, laptop.meta.pause?.backedUp, laptop.meta.pause?.backupFailed], ['held', false, true])
      assert.equal(laptop.options.rules.filters.length, 40, 'nothing applied')

      assert.equal(await laptop.resolveHeld('accept'), true)
      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.rules.filters.length, 1)
    })

    /** Such a hold says nothing of a backup, since accepting takes one: the first press refused, it then says why there is none. */
    test('a hold an older build recorded with daily backups off, whose backup as "accept" applies can\'t be written, is refused the same way', async () => {
      const { cloud, laptop } = await bulkDelete({ meta: { backupsEnabled: false } })
      const { backupFailed, ...older } = { ...laptop.meta.pause, backedUp: false }
      await laptop.setMeta({ pause: older })
      await laptop.edit({ wordsPerMinute: 999 })
      laptop.breakBackups()
      assert.equal(consequence(decisionOn(older), 'accept'), 'Replaces this browser\'s settings with the other browser\'s.', 'precondition: it says nothing of a backup')

      assert.deepEqual(await laptop.answer('accept'), { resolved: false, refused: 'unbacked' })
      assert.deepEqual(laptop.meta.pause, { ...older, backupFailed: true })
      assert.equal(consequence(decisionOn(laptop.meta.pause), 'accept'), 'Replaces this browser\'s settings with the other browser\'s. Yours aren\'t backed up: the backup couldn\'t be saved.')
      assert.equal(await laptop.resolveHeld('accept'), true)
      await cloud.run()
      assert.equal(laptop.options.rules.filters.length, 1)
    })

    test('held again over settings an earlier hold backed up, it points to that backup, and says they are backed up', async () => {
      const { cloud, laptop, desktop } = await bulkDelete({ meta: { backupsEnabled: false } })
      assert.equal(await laptop.resolveHeld('keep'), true)
      await cloud.run()
      assert.equal(desktop.options.rules.filters.length, 40, 'precondition: the laptop\'s rules went back')

      await desktop.edit({ rules: rulesFixture(1) })
      await cloud.run()
      assert.equal(laptop.meta.pause?.reason, 'held')
      assert.deepEqual([laptop.meta.pause.backedUp, laptop.meta.pause.backupFailed], [true, false])
      assert.deepEqual(laptop.backups.map(b => b.kind), ['sync-held', 'sync-declined'], 'the first hold\'s backup holds the same settings')
      assert.deepEqual(laptop.backups[0].options, laptop.options)

      const decision = decisionOn(laptop.meta.pause)
      assert.equal(decision.backup, HELD_BACKUP_NOTE)
      assert.equal(consequence(decision, 'accept'), 'Replaces this browser\'s settings with the other browser\'s. Yours are backed up.')
    })

    test('a newer update within bounds applies and clears the hold', async () => {
      const { cloud, laptop, desktop } = await bulkDelete()
      await desktop.edit({ rules: rulesFixture(38) })
      await cloud.run()

      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.rules.filters.length, 38)
    })

    /**
     * Tracked lists are as losable as the rest: each one is a query the reader
     * built by hand, and a browser that arrives with an empty list looks exactly
     * like a reader who deleted them all.
     */
    test('the tracked lists get the same check', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.options.trackedLists.lists.length, 12)

      await desktop.edit({ trackedLists: trackedListsFixture(2) })
      await cloud.run()

      assert.equal(laptop.options.trackedLists.lists.length, 12, 'not applied')
      assert.equal(laptop.meta.pause?.reason, 'held')
      assert.deepEqual(laptop.meta.pause.loss.trackedLists, { removed: 10, of: 12 })

      assert.equal(await laptop.resolveHeld('accept'), true)
      await cloud.run()
      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.trackedLists.lists.length, 2)
    })

    /** Renaming every list is an edit, and passes straight through to the other browser's records. */
    test('renaming them all is not a loss', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()

      const edited = trackedListsFixture(12, { reviewedThrough: 20100 })
      for (const entry of edited.lists)
        entry.alias = `${entry.alias} — renamed`
      await desktop.edit({ trackedLists: edited })
      await cloud.run()

      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.trackedLists.reviewedThrough, 20100)
      assert.deepEqual(laptop.options.trackedLists.lists.map(entry => entry.alias), edited.lists.map(entry => entry.alias))
      assert.deepEqual(Object.values(laptop.options.savedLists.lists).map(record => record.title), edited.lists.map(entry => entry.alias))
    })

    /**
     * Refining a list replaces its query and view filter and keeps its id, so
     * refining every one of them on one browser is twelve edits on the other,
     * not twelve lists lost and twelve new ones.
     */
    test('re-filtering them all is not a loss', async () => {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()

      const refined = trackedListsFixture(12)
      for (const entry of refined.lists) {
        entry.url = `${entry.url}&work_search%5Bexcluded_tag_names%5D=Angst`
        entry.filter = { facets: { characters: { ex: ['Draco Malfoy'] } } }
      }
      await desktop.edit({ trackedLists: refined })
      await cloud.run()

      assert.equal(laptop.meta.pause, null)
      assert.deepEqual(laptop.options.trackedLists.lists.map(entry => entry.id), refined.lists.map(entry => entry.id))
      assert.equal(laptop.options.trackedLists.lists.every(entry => entry.url.endsWith('=Angst') && entry.filter?.facets?.characters?.ex?.[0] === 'Draco Malfoy'), true)
    })
  })

  /**
   * Every saved list has a record on its browser that never syncs, and only the
   * lists tracked right now are entries in `trackedLists`. A browser on a build
   * from before that holds untracked ("paused") lists as entries too.
   */
  describe('saved lists', () => {
    const V = SYNC_SCHEMA_VERSION
    const OLD_BUILD = { version: V - 1, savedLists: false }

    /** Twelve tracked lists, and three paused ones with titles of their own, as a build from before saved lists held them. */
    function withPaused() {
      const option = trackedListsFixture(12)
      for (let i = 0; i < 3; i++)
        option.lists.push({ id: `p${i}`, kind: 'tag-works', url: `/tags/paused%20${i}`, alias: `Paused ${i}`, tracked: false, since: 19990 })
      return option
    }

    const TRACKED_IDS = trackedListsFixture(12).lists.map(entry => entry.id)
    const ids = lists => lists.map(entry => entry.id)
    const listState = device => ({ tracked: device.options.trackedLists, saved: device.options.savedLists })
    const written = state => ({ trackedLists: state.tracked, savedLists: state.saved })

    /** A stored copy of fixture list `i`, as its search view stores one. */
    const copyOf = i => ({
      v: 3,
      scrapedAt: 1_000,
      ids: '',
      descriptor: { sourceId: 'text-search', label: `Search: word ${i}`, listUrl: `https://archiveofourown.org${trackedListsFixture(12).lists[i].url}` },
    })

    /** A laptop and a desktop on a build from before saved lists, in sync, holding the paused lists as entries. */
    async function oldBrowsers() {
      const cloud = createCloud()
      const laptop = createDevice(cloud, 'laptop', { ...OLD_BUILD, options: { rules: rulesFixture(40), trackedLists: withPaused() } })
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', OLD_BUILD)
      await desktop.enableSync()
      await cloud.run()
      assert.equal(desktop.options.trackedLists.lists.length, 15, 'precondition: the paused lists synced, as entries')

      // The laptop is updated first, and moves the cloud to the new version.
      await laptop.restart({ version: V, savedLists: true, migrate: true, init: true })
      await cloud.run()
      return { cloud, laptop, desktop }
    }

    /** Each of the desktop's paused lists is a record of its own, title and all. */
    function assertPausedKept(desktop) {
      const records = desktop.options.savedLists.lists
      for (let i = 0; i < 3; i++)
        assert.deepEqual(records[`p${i}`], { id: `p${i}`, kind: 'tag-works', url: `/tags/paused%20${i}`, title: `Paused ${i}` })
      assert.deepEqual(ids(desktop.options.trackedLists.lists), TRACKED_IDS)
    }

    test('the first browser updated moves its paused lists into records, and syncs only what is tracked', async () => {
      const { cloud, laptop } = await oldBrowsers()
      assert.equal(cloud.manifest().v, V)
      assert.deepEqual(ids(laptop.options.trackedLists.lists), TRACKED_IDS)
      assert.equal(laptop.options.savedLists.v, 1)
      assert.deepEqual(laptop.options.savedLists.lists.p0, { id: 'p0', kind: 'tag-works', url: '/tags/paused%200', title: 'Paused 0' })
      assert.equal(Object.values(laptop.options.savedLists.lists).some(record => record.mirror), false, 'a migrated record is this browser\'s own')
    })

    test('an old build\'s paused entries survive a newer copy, which it waits on rather than adopts', async () => {
      const { cloud, desktop } = await oldBrowsers()
      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.options.trackedLists.lists.length, 15)
      assert.deepEqual(desktop.options.trackedLists.lists.filter(entry => !entry.tracked).map(entry => entry.alias), ['Paused 0', 'Paused 1', 'Paused 2'])

      // Updated, it moves them into records before it takes the copy.
      await desktop.restart({ version: V, savedLists: true, migrate: true, init: true })
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assertPausedKept(desktop)
      assert.equal(desktop.backups.some(backup => backup.kind === 'sync-held'), false, 'the lists both had tracked raise nothing')
    })

    test('a pull that reaches the engine before the migration loses nothing', async () => {
      const { cloud, desktop } = await oldBrowsers()
      // The update's first pull runs before the migration does.
      await desktop.restart({ version: V, savedLists: true, init: true })
      await cloud.run()
      assert.equal(desktop.meta.pause, null)
      assertPausedKept(desktop)
    })

    test('a tracked entry arriving without a copy makes a record of it, under its id and title', async () => {
      const cloud = createCloud()
      const laptop = createDevice(cloud, 'laptop', { options: { trackedLists: trackedListsFixture(2) } })
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()

      const query = { kind: 'text-search', url: '/works/search?work_search[query]=tea', type: 'search', entity: 'tea' }
      const plan = planTrackSearch(listState(laptop), query, 'Tea', 20400)
      await laptop.edit(written(plan.state))
      await cloud.run()

      assert.deepEqual(desktop.options.savedLists.lists[plan.id], { id: plan.id, ...query, title: 'Tea', mirror: true })
      assert.equal(laptop.options.savedLists.lists[plan.id].mirror, undefined, 'the tracker\'s own record is no mirror')
      assert.deepEqual(desktop.options.trackedLists.lists.at(-1), { id: plan.id, ...query, alias: 'Tea', tracked: true, since: 20400 })
    })

    /**
     * A laptop tracking twelve lists, and a desktop that adopted them and then
     * stored a copy of the second, which joins that list's record by address.
     */
    async function mirrored() {
      const cloud = createCloud()
      const laptop = createDevice(cloud, 'laptop', { options: { trackedLists: trackedListsFixture(12) } })
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop')
      await desktop.enableSync()
      await cloud.run()
      await desktop.store('text-search:word-1', copyOf(1))
      assert.deepEqual(Object.keys(desktop.options.savedLists.lists), TRACKED_IDS, 'precondition: the copy is the second list\'s, not a list of its own')
      assert.equal(Object.values(desktop.options.savedLists.lists).every(record => record.mirror), true, 'precondition: all only mirrored')
      return { cloud, laptop, desktop }
    }

    test('a copy stored before its list arrived is a list of its own, beside the tracked one', async () => {
      const cloud = createCloud()
      const laptop = createDevice(cloud, 'laptop', { options: { trackedLists: trackedListsFixture(2) } })
      await laptop.enableSync()
      await cloud.run()
      const desktop = createDevice(cloud, 'desktop', { stored: { 'text-search:word-1': copyOf(1) } })
      await desktop.enableSync()
      await cloud.run()

      const records = Object.values(desktop.options.savedLists.lists)
      const atAddress = records.filter(record => addressOf(record.url) === addressOf(trackedListsFixture(2).lists[1].url))
      assert.equal(atAddress.length, 2, 'nothing is merged')
      assert.deepEqual(atAddress.map(record => record.title).sort(), ['Search 1', 'Search: word 1'], 'the copy\'s list under its search\'s default title')
      assert.deepEqual(ids(desktop.options.trackedLists.lists), ['l0', 'l1'])
    })

    test('tracking stopped on one browser: the other keeps the lists it holds a copy of or changed, and lets the rest go', async () => {
      const { cloud, laptop, desktop } = await mirrored()
      // The desktop retitles one, which makes it a list it has had a hand in.
      await desktop.edit(written(planRetitle(listState(desktop), 'l2', 'Word two').state))
      await cloud.run()
      assert.equal(laptop.options.savedLists.lists.l2.title, 'Word two')

      let state = listState(laptop)
      for (const id of ['l0', 'l1', 'l2'])
        state = planStopTracking(state, id)
      await laptop.edit(written(state))
      await cloud.run()

      assert.equal(desktop.meta.pause, null, 'three lists is within bounds')
      assert.deepEqual(ids(desktop.options.trackedLists.lists), TRACKED_IDS.slice(3))
      const records = desktop.options.savedLists.lists
      assert.equal(records.l0, undefined, 'only ever mirrored, and nothing of it held here')
      assert.deepEqual(records.l1, { id: 'l1', kind: 'text-search', url: trackedListsFixture(12).lists[1].url, title: 'Search 1' }, 'kept for its copy, and no longer a mirror')
      assert.deepEqual(records.l2, { id: 'l2', kind: 'text-search', url: trackedListsFixture(12).lists[2].url, title: 'Word two' }, 'kept, with the last title it had')
      for (const id of ['l0', 'l1', 'l2'])
        assert.ok(laptop.options.savedLists.lists[id], `${id} stays saved where tracking stopped`)

      // Tracked again on the desktop: the entry is back, and the laptop's record takes the tracker's title.
      await desktop.edit(written(planRetitle(listState(desktop), 'l2', 'Word 2').state))
      await cloud.run()
      assert.equal(laptop.options.savedLists.lists.l2.title, 'Word two', 'a saved list\'s title doesn\'t sync')
      await desktop.edit(written(planTrack(listState(desktop), 'l2', 20400).state))
      await cloud.run()
      assert.equal(laptop.options.trackedLists.lists.find(entry => entry.id === 'l2').alias, 'Word 2')
      assert.equal(laptop.options.savedLists.lists.l2.title, 'Word 2')
    })

    test('tracking stopped on most of the lists is held, and accepting it keeps what this browser holds', async () => {
      const { cloud, laptop, desktop } = await mirrored()
      let state = listState(laptop)
      for (const id of TRACKED_IDS.slice(0, 6))
        state = planStopTracking(state, id)
      await laptop.edit(written(state))
      await cloud.run()

      assert.equal(desktop.meta.pause?.reason, 'held')
      assert.deepEqual(desktop.meta.pause.loss.trackedLists, { removed: 6, of: 12 })
      assert.deepEqual(ids(desktop.options.trackedLists.lists), TRACKED_IDS, 'nothing is applied while it is held')
      assert.deepEqual(Object.keys(desktop.options.savedLists.lists), TRACKED_IDS)

      assert.equal(await desktop.resolveHeld('accept'), true)
      await cloud.run()
      assert.deepEqual(ids(desktop.options.trackedLists.lists), TRACKED_IDS.slice(6))
      assert.deepEqual(Object.keys(desktop.options.savedLists.lists), ['l1', ...TRACKED_IDS.slice(6)], 'the one with a copy stays saved')
    })
  })

  test('a browser adopting a copy it can\'t reproduce doesn\'t push it back', async () => {
    const cloud = createCloud()
    const laptop = mainBrowser(cloud, 'laptop', { version: 1 })
    await laptop.enableSync()
    await cloud.run()
    createLegacyDevice(cloud, 'legacy', { knownKeys: LEGACY_KNOWN, legacyOptions: LEGACY_ONLY })
    await laptop.edit({ textReplacements: textReplacementsFixture(11) })
    await cloud.run()
    const echo = cloud.manifest()
    assert.match(echo.w, /^legacy\./, 'precondition: the newest cloud copy is the stale build\'s')

    // The stale copy carries an option this build drops, so no browser on it
    // can ever hash to what the copy says.
    const fresh = createDevice(cloud, 'fresh', { version: 1 })
    await fresh.enableSync()
    await cloud.run()

    assert.equal(fresh.meta.dirty, false)
    assert.equal(fresh.options.textReplacements.rules.length, 11, 'the copy was adopted')
    assert.equal(cloud.manifest().w, echo.w, 'and nothing was pushed over it')
  })

  test('a background running an out-of-date build doesn\'t sync', async () => {
    const cloud = createCloud()
    const laptop = mainBrowser(cloud)
    await laptop.enableSync()
    await cloud.run()
    const desktop = createDevice(cloud, 'desktop')
    await desktop.enableSync()
    await cloud.run()

    // The desktop's background finds build.json doesn't match its own build.
    await desktop.setMeta({ staleBuild: { running: 'old', onDisk: 'new' } })
    await desktop.edit({ wordsPerMinute: 111 })
    await laptop.edit({ rules: rulesFixture(41) })
    await cloud.run()
    assert.equal(laptop.options.wordsPerMinute, 200, 'the stale background pushed nothing')
    assert.equal(desktop.options.rules.filters.length, 40, 'and adopted nothing')

    // Reloaded onto the current build: it catches up, and its own edit follows.
    await desktop.setMeta({ staleBuild: null })
    await desktop.restart({ init: true })
    await desktop.edit({ wordsPerMinute: 112 })
    await cloud.run()
    assert.equal(desktop.options.rules.filters.length, 41)
    assert.equal(laptop.options.wordsPerMinute, 112)
  })

  test('a pending push survives a worker restart', async () => {
    const cloud = createCloud()
    const laptop = mainBrowser(cloud)
    await laptop.enableSync()
    await cloud.run()
    const desktop = createDevice(cloud, 'desktop')
    await desktop.enableSync()
    await cloud.run()

    // An import writes options and reloads the extension before the push fires.
    await laptop.edit({ wordsPerMinute: 400 })
    assert.ok(laptop.alarms.length, 'precondition: a push was scheduled')
    await laptop.restart()
    await cloud.run()

    assert.equal(desktop.options.wordsPerMinute, 400)
  })
})
