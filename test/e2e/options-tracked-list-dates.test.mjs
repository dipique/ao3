import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { isoDay, utcToday } from '../../src/common/trackedLists.ts'
import { backfillNote } from '../../src/options_ui/model/savedListRows.ts'
import { storedListIds, storedLists } from './helpers.mjs'
import { mentions, skip, startOptions, stubArchive, until } from './optionsPage.mjs'

const ARCHIVE = 'https://archiveofourown.org'
const TODAY = utcToday()
/** The last day marked reviewed. */
const REVIEWED = TODAY - 2
const HOUR = 60 * 60 * 1000

/** A tracked filtered listing's entry, and the record the background files for it. */
const tracked = (id, tag, since) => ({ id, kind: 'works-filter', url: `/tags/${tag}/works`, alias: tag, tracked: true, since })
const recordOf = ({ id, kind, url, alias }) => ({ id, kind, url, title: alias })

/** Tracked from four days ago, with a copy read whole. */
const BEES = tracked('b33s', 'Bees', TODAY - 4)
/** Tracked from today, with a copy read whole; nothing has been updated since. */
const MOTHS = tracked('m0ths', 'Moths', TODAY)
/** Tracked from a week ago, with no copy yet. */
const WASPS = tracked('w4sps', 'Wasps', TODAY - 7)
/** Saved, not tracked, with a copy. */
const ANTS = { id: '4nts', kind: 'works-filter', url: '/tags/Ants/works', title: 'Ants' }

const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

/** A tag's listing, one page long, its heading counting what it holds, as the archive's does. */
const listingPage = (tag, ids) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Works in ${tag}</title></head>
<body class="logged-in">
  <div id="main" class="works-index region">
    <h2 class="heading">${ids.length ? `1 - ${ids.length} of ${ids.length}` : '0'} Works in <a class="tag" href="/tags/${tag}">${tag}</a></h2>
    <ol class="work index group">${ids.map(blurb).join('')}</ol>
  </div>
</body></html>`

/** What each tag's listing holds, between whatever dates it is asked for. */
const LISTED = { Bees: [11, 12], Moths: [], Ants: [31, 32] }

/** A copy read whole, five hours ago. */
const wholeCopy = (tag, ids) => ({
  scrapedAt: Date.now() - 5 * HOUR,
  blurbsHtml: ids.map(blurb),
  descriptor: { sourceId: 'works-filter', label: `Tag: ${tag}`, listUrl: `${ARCHIVE}/tags/${tag}/works` },
})

const keyOf = tag => `works-filter:/tags/${tag}/works`

const SEED = {
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: REVIEWED, lists: [BEES, MOTHS, WASPS] },
  'option.savedLists': { v: 1, lists: Object.fromEntries([recordOf(BEES), recordOf(MOTHS), recordOf(WASPS), ANTS].map(one => [one.id, one])) },
  ...storedLists({
    [keyOf('Bees')]: wholeCopy('Bees', [1, 2, 3]),
    [keyOf('Moths')]: wholeCopy('Moths', [4, 5]),
    [keyOf('Ants')]: wholeCopy('Ants', [6]),
  }),
}

/** The day a request asked for works updated from, or null for none. */
const askedFrom = url => new URL(url).searchParams.get('work_search[date_from]')

/**
 * A tracked list's offline copy holds the works updated from the day the list
 * is tracked from: Refresh list on the options page reads its listing from
 * that day and keeps the date filter with the copy, and the link that keeps a
 * copy opens the list from that day. A saved list nothing tracks is read whole.
 * The day is changed from the list's row, which writes its entry alone.
 */
describe('options UI — the day a tracked list is tracked from', { skip }, () => {
  let session
  let options
  let archive

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: SEED,
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
      prepare: async (page) => {
        archive = await stubArchive(page, (url) => {
          const tag = /^\/tags\/([^/]+)\/works$/.exec(new URL(url).pathname)?.[1]
          return { body: listingPage(tag, LISTED[tag] ?? []) }
        })
      },
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const copyOf = async tag => (await options.stored('cache.searchLists'))?.[keyOf(tag)] ?? null
  const askedOf = tag => archive.asked.filter(url => new URL(url).pathname === `/tags/${tag}/works`)
  const sinceOf = async id => (await options.stored('option.trackedLists')).lists.find(one => one.id === id).since

  /** Press Refresh list in a row's details, once it can be pressed, and wait for the copy to be written. */
  async function refresh(id, tag) {
    const before = (await copyOf(tag)).scrapedAt
    const row = await options.savedListDetails(id)
    const button = await options.action(row, 'refresh')
    await until('Refresh list to be free to press', () => button.evaluate(el => !el.disabled))
    await options.press(button)
    await until(`${tag}'s copy to be written`, async () => (await copyOf(tag))?.scrapedAt > before)
  }

  /** Put `iso` (`YYYY-MM-DD`) in a row's tracking day, as its date picker does. */
  async function pickSince(id, iso) {
    const row = await options.savedListDetails(id)
    await row.$eval('[data-saved-list-since]', (input, value) => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, iso)
    return row
  }

  test('Refresh list reads a tracked list from its day, and keeps the date filter with its copy', async () => {
    await refresh(BEES.id, 'Bees')
    assert.ok(askedOf('Bees').length > 0)
    assert.deepEqual(askedOf('Bees').map(askedFrom), askedOf('Bees').map(() => isoDay(BEES.since)))
    const copy = await copyOf('Bees')
    assert.deepEqual(storedListIds(copy), ['11', '12'])
    assert.equal(copy.descriptor.dateFilter, `work_search[date_from]=${isoDay(BEES.since)}`)
    assert.equal(askedFrom(copy.descriptor.listUrl), null, 'the copy\'s address stays the whole listing\'s')
  })

  test('nothing updated since its day is an empty copy, not a refusal', async () => {
    await refresh(MOTHS.id, 'Moths')
    const copy = await copyOf('Moths')
    assert.deepEqual(storedListIds(copy), [])
    assert.equal(copy.descriptor.dateFilter, `work_search[date_from]=${isoDay(MOTHS.since)}`)
  })

  test('a saved list nothing tracks is read whole', async () => {
    await refresh(ANTS.id, 'Ants')
    assert.deepEqual(askedOf('Ants').map(askedFrom), askedOf('Ants').map(() => null))
    const copy = await copyOf('Ants')
    assert.deepEqual(storedListIds(copy), ['31', '32'])
    assert.equal('dateFilter' in copy.descriptor, false)
  })

  test('the link that keeps a copy of a tracked list opens it from its day', async () => {
    const row = await options.savedList(WASPS.id)
    const href = await row.$eval('[data-saved-list-part="caching"] [data-action="open"]', el => el.href)
    assert.equal(new URL(href).pathname, '/tags/Wasps/works')
    assert.equal(askedFrom(href), isoDay(WASPS.since))
  })

  test('pressing a tracked list\'s day opens its details on it, ready to change', async () => {
    const row = await options.savedList(WASPS.id)
    await options.press(await options.action(await row.$('[data-saved-list-part="status"]'), 'edit-since'))
    await until('the day to take focus', () => row.evaluate(el => document.activeElement === el.querySelector('[data-saved-list-since]')))
    assert.deepEqual(await row.$eval('[data-saved-list-since]', el => ({ value: el.value, max: el.max })), { value: isoDay(WASPS.since), max: isoDay(TODAY) })
  })

  test('a day picked there is the day the list is tracked from, on its entry alone; brought back into days already reviewed, it says what that can\'t do', async () => {
    const records = await options.stored('option.savedLists')
    const row = await pickSince(WASPS.id, isoDay(TODAY - 10))
    await until('the day to be written', async () => await sinceOf(WASPS.id) === TODAY - 10)
    assert.deepEqual(await options.stored('option.savedLists'), records, 'no record holds a day')
    await until('the note to be shown', async () => await row.$('[data-saved-list-note="backfill"]') !== null)
    const note = await row.$eval('[data-saved-list-note="backfill"]', el => el.textContent)
    assert.ok(mentions(note, backfillNote(WASPS.since, TODAY - 10, REVIEWED)), note)
    const href = await row.$eval('[data-saved-list-part="caching"] [data-action="open"]', el => el.href)
    assert.equal(askedFrom(href), isoDay(TODAY - 10), 'its link follows')
  })

  test('a later day says nothing more; a day yet to come is today', async () => {
    const row = await pickSince(WASPS.id, isoDay(TODAY - 1))
    await until('the day to be written', async () => await sinceOf(WASPS.id) === TODAY - 1)
    assert.equal(await row.$('[data-saved-list-note="backfill"]'), null)
    await pickSince(WASPS.id, isoDay(TODAY + 3))
    await until('today to be written', async () => await sinceOf(WASPS.id) === TODAY)
    await until('the field to say so', async () => await row.$eval('[data-saved-list-since]', el => el.value) === isoDay(TODAY))
  })

  test('a list that isn\'t tracked has no day to change', async () => {
    const row = await options.savedListDetails(ANTS.id)
    assert.equal(await row.$('[data-action="edit-since"]'), null)
    assert.equal(await row.$('[data-saved-list-since]'), null)
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})
