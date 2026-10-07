// Whole-sync scenarios: several browsers running the real engine over one
// simulated sync server (see ./harness.mjs). The decision functions are tested
// on their own in decide.test.mjs; these are the interleavings between browsers,
// which is where sync actually goes wrong.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { addressOf, planRetitle, planStopTracking, planTrack, planTrackSearch } from '../../src/common/savedLists.ts'
import { SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { createCloud, createDevice, createLegacyDevice, markedWorks, marksFixture, range, rulesFixture, textReplacementsFixture, trackedListsFixture } from './harness.mjs'

/** The options the first sync build knew: everything but what came later. */
const LEGACY_KNOWN = Object.keys(OPTION_DEFAULTS).filter(key => !['rules', 'workMarks', 'pruneOrphanedBlurbs'].includes(key))
/** An option only the first sync build had, which newer builds drop on read. */
const LEGACY_ONLY = { hideTags: { enabled: true, filters: [{ name: 'An old tag', matcher: 'exact' }] } }

/** A browser with a reader's worth of data in it. */
function mainBrowser(cloud, name = 'laptop', settings = {}) {
  return createDevice(cloud, name, {
    options: { rules: rulesFixture(40), workMarks: marksFixture(range(1000, 60)), textReplacements: textReplacementsFixture(10), trackedLists: trackedListsFixture(12) },
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
