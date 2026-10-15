import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { storedListIds } from './helpers.mjs'
import { skip, startOptions, until } from './optionsPage.mjs'
import { ARCHIVE, keptStore, listingPage, openTab, stored, visit } from './trackedPages.mjs'

/** A saved list of each kind the archive has a page for, none of them with a copy yet. */
const FILTERED = { id: 'b33s', kind: 'works-filter', url: '/tags/Bees/works', title: 'Bees', type: 'tag', entity: 'Bees' }
const SEARCH = { id: 't3a', kind: 'text-search', url: '/works/search?work_search[query]=tea', title: 'Search: tea', type: 'search', entity: 'tea' }
const TAG = { id: 'm4rr', kind: 'tag-works', url: '/tags/marriage%20problems', title: 'Tag: marriage problems', type: 'freeform', entity: 'marriage problems' }
const SERIES = { id: 's3r', kind: 'series-works', url: '/series/9991', title: 'Series: 9991' }
/** One at an address that isn't the archive's, which has no page to open there. */
const ELSEWHERE = { id: 'br0', kind: 'tag-works', url: 'https://example.com/tags/x', title: 'Elsewhere' }

/** Where the filtered listing's copy is kept: its address. */
const FILTERED_KEY = 'works-filter:/tags/Bees/works'

const savedLists = lists => ({ 'option.savedLists': { v: 1, lists: Object.fromEntries(lists.map(list => [list.id, list])) } })

/** Copy URL's clipboard, stood in for so a test can read what was put on it: `window.__copied`. */
function standInForClipboard() {
  window.__copied = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text) => {
        window.__copied.push(text)
        return Promise.resolve()
      },
    },
  })
}

/** What one part of a saved list's row says, a line each as it is laid out. */
// eslint-disable-next-line unicorn/prefer-dom-node-text-content
const part = (row, name) => row.$eval(`[data-saved-list-part="${name}"]`, el => el.innerText.split('\n').map(line => line.trim()).filter(Boolean))

/** The link a row's Not cached offers, which opens the list on AO3 and so keeps its copy. */
const HINT = list => `Open ${list.title} on AO3 to keep a copy`

/**
 * Every saved list with a page on AO3 has an open URL — that page, naming the
 * list by its id — and the options page hands it out wherever the list is
 * opened from: Copy URL, and *Not cached*, which says that opening the list
 * there keeps the copy it lacks. That holds for every kind of list, a filtered
 * listing's included, whatever its page button says.
 */
describe('options UI — saved lists on their open URLs', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: savedLists([FILTERED, SEARCH, TAG, SERIES, ELSEWHERE]),
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
      prepare: page => page.evaluateOnNewDocument(standInForClipboard),
    })
    await until('the stored lists to be read', async () => (await part(await options.savedList(SERIES.id), 'caching'))[0] === 'Not cached')
  }, { timeout: 180000 })

  after(() => session?.close())

  test('a list with no copy says Not cached, and links its open URL, which keeps one, for every kind', async () => {
    for (const list of [FILTERED, SEARCH, TAG, SERIES]) {
      const row = await options.savedList(list.id)
      assert.deepEqual(await part(row, 'caching'), ['Not cached', 'open it on AO3 to keep a copy'], list.kind)
      const link = await options.control(row, 'link', HINT(list))
      assert.equal(await link.evaluate(a => a.getAttribute('href')), `${ARCHIVE}${list.url}#ao3e-open=${list.id}`, list.kind)
      assert.equal(await link.evaluate(a => a.target), '_blank', 'a new tab: the copy shows here once it is kept')
    }
  })

  test('its details say the same, a filtered listing\'s as any other\'s', async () => {
    for (const list of [FILTERED, SERIES]) {
      const details = await options.savedListDetails(list.id)
      assert.match(await options.text(details), /None yet\. Open it on AO3 to keep a copy: from then on, it refreshes from here\./, list.kind)
    }
  })

  test('Copy URL copies the same open URL', async () => {
    const row = await options.savedList(FILTERED.id)
    await options.press(await options.control(row, 'button', `Copy the AO3 address of ${FILTERED.title}`))
    await until('the copy to be said', async () => (await options.controls(row, 'button', `Copied the AO3 address of ${FILTERED.title}`)).length === 1)
    const hint = await (await options.control(row, 'link', HINT(FILTERED))).evaluate(a => a.href)
    assert.deepEqual(await options.page.evaluate(() => window.__copied), [hint])
  })

  test('a list at no address on the archive has no open URL: no link and no Copy URL, and its own words', async () => {
    const row = await options.savedList(ELSEWHERE.id)
    assert.deepEqual(await part(row, 'caching'), ['Not cached', 'cache it from its page on AO3'])
    assert.deepEqual(await options.controls(await row.$('[data-saved-list-part="caching"]'), 'link'), [])
    assert.deepEqual(await options.controls(row, 'button', `Copy the AO3 address of ${ELSEWHERE.title}`), [])
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * A filtered listing's Not cached, followed: its listing on AO3 opens on the
 * list's search view, though *Search a filtered listing's works* is off, and
 * the walk keeps the copy at the list's address. The options page, left open
 * where the link was followed from, hears of the copy and shows the list
 * cached, offering Download.
 */
describe('options UI — a filtered listing kept from its open URL', { skip }, () => {
  const seed = savedLists([FILTERED])
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('the hint\'s link keeps the copy, and the open options page then shows it cached and offers Download', async () => {
    const options = await session.open({ seed, hash: '#saved-lists', viewport: { width: 1440, height: 900 } })
    try {
      const row = await options.savedList(FILTERED.id)
      await until('the stored lists to be read', async () => (await part(row, 'caching'))[0] === 'Not cached')
      assert.deepEqual(await options.controls(row, 'button', `Download ${FILTERED.title}`), [], 'nothing to download yet')
      const link = await (await options.control(row, 'link', HINT(FILTERED))).evaluate(a => a.href)

      const tab = await openTab(session.browser, {
        seed,
        route: url => (url.pathname === FILTERED.url ? listingPage(url, { tagId: 'Bees', subnav: true }) : null),
      })
      let kept
      try {
        await visit(tab, link)
        await until('the copy to be kept', async () => storedListIds((await stored(tab, 'cache.searchLists'))?.[FILTERED_KEY]).length === 2)
        kept = await keptStore(tab)
      }
      finally {
        await tab.close()
      }

      // The listing's tab wrote into the storage every extension page shares,
      // which tells each open page what changed.
      await options.page.evaluate(items => window.browser.storage.local.set(items), kept)
      await until('the copy to be read', async () => (await part(row, 'caching'))[0] === '0 of 2 cached · 0 B')
      const download = await options.control(row, 'button', `Download ${FILTERED.title}`)
      assert.equal(await download.evaluate(el => el.disabled), false)
      assert.deepEqual(await options.controls(row, 'link', HINT(FILTERED)), [], 'cached, so no hint')
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })
})
