import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { installMock, storedLists } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * The background's half of saved lists, over a `storage.local` mock: the
 * migration an install or update runs, and the planner it runs again whenever
 * the tracked lists or the stored lists change. What the planner decides is
 * tested next door (`savedLists.test.mjs`); this is what ends up in storage.
 */

const skip = skipWithoutChrome

const AO3 = 'https://archiveofourown.org'
const TRACKED_LISTS = { enabled: true, target: 40, reviewedThrough: 20_000 }

/** Tracked, with a view filter. */
const HP = { id: 'hp1', kind: 'works-filter', url: '/tags/Harry%20Potter/works', alias: 'Harry Potter, no Draco', type: 'fandom', entity: 'Harry Potter', filter: { facets: { characters: { ex: ['Draco Malfoy'] } } }, tracked: true, since: 20_000 }
/** Paused, with two copies stored at its address: by date and by kudos. */
const COFFEE = { id: 'c0ffee', kind: 'text-search', url: '/works/search?work_search[query]=coffee', alias: 'Coffee shop AUs', type: 'search', entity: 'coffee', tracked: false, since: 19_990 }
/** Paused, and never titled. */
const SERIES = { id: 'ser1es', kind: 'series-works', url: '/series/9991', alias: '', tracked: false, since: 19_990 }
/** Paused, at an address that isn't the archive's. */
const ELSEWHERE = { id: 'e1sew', kind: 'tag-works', url: 'https://example.com/tags/x', alias: 'Elsewhere', tracked: false, since: 19_990 }

/** The record a legacy entry becomes: its id, query and title, and nothing that says it was paused. */
function recordOf({ id, kind, url, alias, type, entity, filter }) {
  return Object.fromEntries(Object.entries({ id, kind, url, title: alias, type, entity, filter }).filter(([, value]) => value !== undefined))
}

const blurb = id => `<li class="work blurb group" id="work_${id}" role="article"><h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4></li>`

/** Copies of searches, the built-ins, the review's window and an undescribed list. */
const STORED = storedLists({
  'text-search:coffee-by-date': { scrapedAt: 1_000, blurbsHtml: [blurb(1)], descriptor: { sourceId: 'text-search', label: 'Search: coffee', listUrl: `${AO3}/works/search?work_search%5Bquery%5D=coffee` } },
  'text-search:coffee-by-kudos': { scrapedAt: 2_000, blurbsHtml: [blurb(2)], descriptor: { sourceId: 'text-search', label: 'Search: coffee', listUrl: `${AO3}/works/search?work_search%5Bquery%5D=coffee&work_search%5Bsort_column%5D=kudos_count` } },
  'text-search:tea': { scrapedAt: 3_000, blurbsHtml: [blurb(3)], descriptor: { sourceId: 'text-search', label: 'Search: tea', listUrl: `${AO3}/works/search?work_search%5Bquery%5D=tea` } },
  'tag-works:old%20tag': { scrapedAt: 500, blurbsHtml: [blurb(4)] },
  'marked-for-later:me': { scrapedAt: 4_000, blurbsHtml: [blurb(5)], descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later', listUrl: `${AO3}/users/me/readings?show=to-read` } },
  'tracked-review': { scrapedAt: 5_000, blurbsHtml: [blurb(6)], descriptor: { sourceId: 'tracked-review', label: 'Tracked review', listUrl: `${AO3}/users/me/readings#ao3e-tracked` } },
})

/** The record the planner makes for the stored search no entry is, under the search's default title. */
const TEA = { kind: 'text-search', url: '/works/search?work_search[query]=tea', title: 'Search: tea', type: 'search', entity: 'tea' }

/** A legacy install's storage: tracked and paused entries, stored lists, and no saved-list records. */
const LEGACY = {
  'option.trackedLists': { ...TRACKED_LISTS, lists: [HP, COFFEE, SERIES, ELSEWHERE] },
  ...STORED,
}

describe('saved lists in the background', { skip }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage('test/trackedLists/backgroundEntry.ts', 'Background', {
      prepare: blank => blank.evaluate(installMock, {}),
    }))
    await page.evaluate(() => {
      window.store = async () => window.browser.storage.local.get(null)
      window.reset = async (seed = {}) => {
        await window.browser.storage.local.clear()
        await window.browser.storage.local.set(seed)
        window.__writes.length = 0
      }
      /** Every option write since the last reset, by key. */
      window.optionWrites = () => window.__writes.flatMap(write => Object.keys(write).filter(key => key.startsWith('option.')))
      /** Let a storage listener's run start, then wait for it and any after it. */
      window.settled = async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        await window.Background.reconcileSavedLists()
      }
    })
  }, { timeout: 120000 })

  after(async () => close?.())

  test('a legacy install migrates: paused entries leave what syncs for records of their own, and every list has one', async () => {
    const result = await page.evaluate(async (seed) => {
      await window.reset(seed)
      await window.Background.migrate()
      const migrated = await window.store()
      // Idempotent: the next update, or an import, changes nothing.
      window.__writes.length = 0
      await window.Background.migrate()
      await window.Background.reconcileSavedLists()
      return { tracked: migrated['option.trackedLists'], saved: migrated['option.savedLists'], lists: migrated['cache.searchLists'], again: window.optionWrites() }
    }, LEGACY)

    assert.deepEqual(result.tracked, { ...TRACKED_LISTS, lists: [HP] }, 'only the tracked list still syncs')
    const { v, lists } = result.saved
    assert.equal(v, 1)
    const made = Object.values(lists).filter(record => !['hp1', 'c0ffee', 'ser1es', 'e1sew'].includes(record.id))
    assert.deepEqual(lists, {
      hp1: recordOf(HP),
      c0ffee: recordOf(COFFEE),
      ser1es: { ...recordOf(SERIES), title: 'Series: 9991' },
      e1sew: recordOf(ELSEWHERE),
      [made[0]?.id]: { id: made[0]?.id, ...TEA },
    }, 'one record more, for the stored search no entry is; none for the copies of a list, the built-ins, the window or an undescribed list; the list never titled takes its default')
    assert.equal(Object.values(lists).some(record => 'mirror' in record), false, 'a migrated record is this browser\'s own')
    assert.deepEqual(Object.keys(result.lists), Object.keys(STORED['cache.searchLists']), 'the stored lists are left as they were')
    assert.deepEqual(result.again, [], 'a second run writes nothing')
  })

  test('the planner follows every change to the tracked or the stored lists', async () => {
    const steps = await page.evaluate(async ({ HP, AO3 }) => {
      const local = window.browser.storage.local
      const tracked = async () => (await local.get('option.trackedLists'))['option.trackedLists']
      const records = async () => (await local.get('option.savedLists'))['option.savedLists'].lists
      window.Background.watchSavedLists(Promise.resolve(true))
      await window.settled()
      const out = {}

      // A pull brings an entry this browser has never seen.
      const arrived = { id: 'arr1v', kind: 'series-works', url: '/series/77', alias: 'From elsewhere', type: 'series', entity: 'The Other Series', tracked: true, since: 20_100 }
      await local.set({ 'option.trackedLists': { ...await tracked(), lists: [HP, arrived] } })
      await window.settled()
      out.arrived = (await records()).arr1v

      // Tracking it stops on that other browser, and nothing of it is held here.
      await local.set({ 'option.trackedLists': { ...await tracked(), lists: [HP] } })
      await window.settled()
      out.left = (await records()).arr1v ?? null

      // A backup from before saved lists is restored: its paused entry comes back.
      const restored = { id: 'r3st0', kind: 'tag-works', url: '/tags/marriage%20problems', alias: 'Marriage', tracked: false, since: 19_000 }
      await local.set({ 'option.trackedLists': { ...await tracked(), lists: [HP, restored] } })
      await window.settled()
      out.restoredTracked = (await tracked()).lists.map(entry => entry.id)
      out.restored = (await records()).r3st0

      // A search view stores a list at an address no record has.
      const lists = (await local.get('cache.searchLists'))['cache.searchLists']
      await local.set({ 'cache.searchLists': { ...lists, 'series-works:88': { v: 3, scrapedAt: 9_000, ids: '', descriptor: { sourceId: 'series-works', label: 'Series: Eighty-Eight', listUrl: `${AO3}/series/88` } } } })
      await window.settled()
      out.stored = Object.values(await records()).find(record => record.url === '/series/88') ?? null
      out.recordCount = Object.keys(await records()).length

      // And a change elsewhere wakes nothing.
      window.__writes.length = 0
      await local.set({ 'option.wordsPerMinute': 300 })
      await window.settled()
      out.quiet = window.optionWrites()
      return out
    }, { HP, AO3 })

    assert.deepEqual(steps.arrived, { id: 'arr1v', kind: 'series-works', url: '/series/77', title: 'From elsewhere', type: 'series', entity: 'The Other Series', mirror: true })
    assert.equal(steps.left, null, 'a mirror with nothing held here goes with its entry')
    assert.deepEqual(steps.restoredTracked, ['hp1'], 'the restored paused entry leaves what syncs')
    assert.deepEqual(steps.restored, { id: 'r3st0', kind: 'tag-works', url: '/tags/marriage%20problems', title: 'Marriage' }, 'and keeps its title as a saved list')
    assert.deepEqual(steps.stored && { ...steps.stored, id: undefined }, { id: undefined, kind: 'series-works', url: '/series/88', title: 'Series: Eighty-Eight', type: 'series', entity: 'Eighty-Eight' })
    assert.equal(steps.recordCount, 7, 'every record from before is kept')
    assert.deepEqual(steps.quiet, ['option.wordsPerMinute'])
  })

  test('a collection\'s listing kept under its sidebar\'s number is refiled at its address, with what goes with its copy, and its two lists are one', async () => {
    // The sidebar submits the collection's own path with its number added,
    // which a listing's address leaves out.
    const LINK = '/collections/yuletide/works'
    const SUBMIT = `${LINK}?work_search[sort_column]=revised_at&collection_id=1`
    const NUMBERED = 'works-filter:/collections/yuletide/works?collection_id=1'
    const ADDRESS = 'works-filter:/collections/yuletide/works'
    const link = { id: 'l1nk', kind: 'works-filter', url: LINK, title: 'Collection: yuletide', type: 'collection', entity: 'yuletide' }
    const submit = { ...link, id: 'sub', url: SUBMIT, title: 'Yule' }
    const descriptor = { sourceId: 'works-filter', label: 'Collection: yuletide', listUrl: `${AO3}${SUBMIT}` }
    const kept = storedLists({ [NUMBERED]: { scrapedAt: 1_000, blurbsHtml: [blurb(7)], descriptor } })
    const job = { cacheKey: NUMBERED, descriptor, steps: ['caching'], queue: ['7'], done: 0, total: 1, startedAt: 1_000, updatedAt: 1_000, errors: [], errorCount: 0 }
    const seed = {
      ...kept,
      'option.trackedLists': { ...TRACKED_LISTS, lists: [] },
      'option.savedLists': { v: 1, lists: { l1nk: link, sub: submit } },
      'cache.searchMisses': { [NUMBERED]: '1', 'read-works:me': '2' },
      'siteExportJob': job,
    }

    const result = await page.evaluate(async (seed) => {
      await window.reset(seed)
      await window.Background.migrate()
      const migrated = await window.store()
      window.__writes.length = 0
      await window.Background.migrate()
      await window.Background.reconcileSavedLists()
      return { migrated, again: window.__writes.flatMap(write => Object.keys(write)) }
    }, seed)

    const { migrated } = result
    assert.deepEqual(migrated['cache.searchLists'], { [ADDRESS]: kept['cache.searchLists'][NUMBERED] }, 'where the search view looks for it now')
    assert.deepEqual(migrated['cache.searchMisses'], { [ADDRESS]: '1', 'read-works:me': '2' })
    assert.deepEqual(migrated.siteExportJob, { ...job, cacheKey: ADDRESS }, 'a stopped job on it stays on it')
    assert.deepEqual(migrated['option.savedLists'], { v: 1, lists: { sub: submit } }, 'one list, under the title the reader gave it')
    assert.deepEqual(result.again, [], 'a second run writes nothing')
  })
})
