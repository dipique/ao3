// Whole-sync scenarios: several browsers running the real engine over one
// simulated sync server (see ./harness.mjs). The decision functions are tested
// on their own in decide.test.mjs; these are the interleavings between browsers,
// which is where sync actually goes wrong.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { createCloud, createDevice, createLegacyDevice, markedWorks, marksFixture, range, rulesFixture, textReplacementsFixture } from './harness.mjs'

/** The options the first sync build knew: everything but what came later. */
const LEGACY_KNOWN = Object.keys(OPTION_DEFAULTS).filter(key => !['rules', 'workMarks', 'pruneOrphanedBlurbs'].includes(key))
/** An option only the first sync build had, which newer builds drop on read. */
const LEGACY_ONLY = { hideTags: { enabled: true, filters: [{ name: 'An old tag', matcher: 'exact' }] } }

/** A browser with a reader's worth of data in it. */
function mainBrowser(cloud, name = 'laptop', settings = {}) {
  return createDevice(cloud, name, {
    options: { rules: rulesFixture(40), workMarks: marksFixture(range(1000, 60)), textReplacements: textReplacementsFixture(10) },
    ...settings,
  })
}

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
      await laptop.restart({ version: 2, init: true })
      await cloud.run()

      assert.equal(cloud.manifest().v, 2)
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
      await laptop.restart({ version: 3, init: true })
      await cloud.run()
      assert.equal(cloud.manifest().v, 3)

      assert.equal(desktop.meta.pause?.reason, 'newer-version')
      assert.equal(desktop.meta.pause.remoteVersion, 3)
      await desktop.edit({ wordsPerMinute: 123 })
      await cloud.run()
      assert.equal(desktop.meta.dirty, false, 'edits on the outdated build aren\'t queued to sync')
      assert.equal(cloud.manifest().v, 3)

      // A browser on the old build can't turn sync on at all.
      const fresh = createDevice(cloud, 'fresh')
      const result = await fresh.enableSync()
      assert.deepEqual(result, { ok: false, reason: 'newer-version', remoteVersion: 3, version: 2 })
      assert.equal(fresh.meta.enabled, false)

      await laptop.edit({ wordsPerMinute: 321 })
      await cloud.run()
      await desktop.restart({ version: 3, init: true })
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

      assert.equal(cloud.manifest().v, 2, 'the current version is back')
      for (const browser of [laptop, desktop]) {
        assert.equal(browser.options.rules.filters.length, 40, `${browser.name} kept its rules`)
        assert.equal(markedWorks(browser.options).size, 60, `${browser.name} kept its marks`)
        assert.equal(browser.meta.pause, null)
      }
    })
  })

  describe('an update that would remove most of a list', () => {
    /** A laptop and desktop in sync, then the desktop deletes 39 of the 40 rules. */
    async function bulkDelete() {
      const cloud = createCloud()
      const laptop = mainBrowser(cloud)
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

    test('a newer update within bounds applies and clears the hold', async () => {
      const { cloud, laptop, desktop } = await bulkDelete()
      await desktop.edit({ rules: rulesFixture(38) })
      await cloud.run()

      assert.equal(laptop.meta.pause, null)
      assert.equal(laptop.options.rules.filters.length, 38)
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
