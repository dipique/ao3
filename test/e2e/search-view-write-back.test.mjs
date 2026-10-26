import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createDefaultMarks, packIds } from '../../src/common/workMarks.ts'
import { isFresh, refreshIntervalMs } from '../../src/content_script/searchView/freshness.ts'
import { ensureBuilt, findChrome, storedListIds, storedLists } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { ARCHIVE, blurb, keptStore, launch, openMenu, openTab, rerun, stored, visit } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TO_READ = `${ARCHIVE}/users/me/readings?show=to-read`
const KEY = 'marked-for-later:me'
const RESULTS = '.AO3E--search-view--results > li.blurb'

const HOURS = 1
const INTERVAL = refreshIntervalMs(HOURS)
const WITHIN = INTERVAL / 2

/** What AO3 lists now, two to a page, and what the kept copy holds: never the same works. */
const LIVE = ['101', '102', '103', '104']
const PER_PAGE = 2
const KEPT = ['901', '902']
/** The kept work the reader takes off the list. */
const TAKEN = '901'

/** The reader's own Marked for Later, signed in as `me`, with the token a mark is sent with. */
function toReadPage(url) {
  const page = Number(url.searchParams.get('page') ?? 1)
  const pages = Array.from({ length: LIVE.length / PER_PAGE }, (_, i) => i + 1)
    .map(n => (n === page ? `<li><span class="current">${n}</span></li>` : `<li><a href="?show=to-read&amp;page=${n}">${n}</a></li>`))
    .join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="csrf-token" content="token"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${LIVE.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(id => blurb(id)).join('')}</ol>
    <ol class="pagination actions" role="navigation">${pages}</ol>
  </div>
</body></html>`
}

/** The requests that read the list: every one that names a page of it. */
const walks = requests => requests.filter(url => url.startsWith(TO_READ) && new URL(url).searchParams.has('page'))

/** The works the view is showing, by id, in the order shown. */
const shownIds = tab => tab.$$eval(`${RESULTS}:not(.AO3E--search-view--hidden)`, els => els.map(li => li.id.replace('work_', '')))

/** A kept copy of {@link KEPT}'s works, `WITHIN` the interval old, read from `listUrl`. */
function keptCopy(listUrl) {
  const descriptor = { sourceId: 'marked-for-later', label: 'Marked for Later — me', listUrl }
  return storedLists({ [KEY]: { scrapedAt: Date.now() - WITHIN, blurbsHtml: KEPT.map(id => blurb(id)), descriptor } })
}

/** {@link keptCopy} of this page's own read, also naming a work whose blurb has gone from the store. */
function copyMissingABlurb() {
  const items = keptCopy(TO_READ)
  items['cache.searchLists'][KEY].ids += `,${Number(903).toString(36)}`
  return items
}

/**
 * The stored copy, and what it claims as {@link isFresh} reads it: the works it
 * names whose blurbs the store has lost counted as a page would count them.
 */
async function storedClaim(tab) {
  const store = await keptStore(tab)
  const copy = store['cache.searchLists'][KEY]
  const missing = copy.ids.split(',').filter(sid => !store[`blurb.${sid}`]).length
  return {
    ids: storedListIds(copy),
    claim: { scrapedAt: copy.scrapedAt, missing, listUrl: copy.descriptor?.listUrl, dateFilter: copy.descriptor?.dateFilter },
  }
}

/**
 * A kept copy the open doesn't trust, so it reads the list again behind it, and
 * the reader takes a work off the list before that read is in, then leaves.
 * The copy is written back without the work, and must still claim only the
 * read it came from: trusted no more than before, the next open within the
 * interval reads the list again.
 */
describe('a kept copy written back while the read behind it is unfinished', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const untrusted = [
    { name: 'a copy read at another address of the list', seed: () => keptCopy('https://www.archiveofourown.org/users/me/readings?show=to-read') },
    { name: 'a copy naming a work whose blurb has gone', seed: copyMissingABlurb },
  ]

  const takings = [
    {
      name: 'the work marked read from its menu',
      marks: { enabled: false, marks: createDefaultMarks() },
      take: async (tab) => {
        await openMenu(tab, () => tab.evaluate((id) => {
          document.querySelector(`#work_${id} h4.heading .AO3E--indicator--mark-saved`).click()
        }, TAKEN))
        await until('the menu to offer to mark it read', () => tab.evaluate(() => {
          const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
            .find(el => !el.disabled && el.textContent.trim().startsWith('Mark as read'))
          row?.click()
          return !!row
        }))
      },
    },
    {
      name: 'the work marked read elsewhere',
      marks: { enabled: true, marks: createDefaultMarks() },
      take: async (tab) => {
        const marks = createDefaultMarks()
        marks.read.items = packIds([TAKEN])
        await rerun(tab, () => tab.evaluate(value => window.browser.storage.local.set({ 'option.workMarks': value }), { enabled: true, marks }))
        // Put back with the read behind it still held, and still going.
        await tab.waitForSelector(RESULTS)
      },
    },
  ]

  for (const copy of untrusted) {
    for (const taking of takings) {
      test(`${copy.name}, and ${taking.name}`, async () => {
        const requests = []
        const held = Promise.withResolvers()
        const tab = await openTab(browser, {
          seed: {
            'option.searchMarkedForLater': true,
            'option.searchProfileListsRefreshHours': HOURS,
            'option.workMarks': taking.marks,
            ...copy.seed(),
          },
          route: async (url) => {
            if (url.pathname === '/users/me/readings') {
              if (url.searchParams.has('page'))
                await held.promise
              return toReadPage(url)
            }
            if (url.pathname === `/works/${TAKEN}/mark_as_read` || url.pathname === '/')
              return '<!doctype html><title>Archive</title>'
            return null
          },
          requests,
        })
        try {
          await visit(tab, TO_READ)
          await tab.waitForSelector(RESULTS)
          assert.deepEqual(await shownIds(tab), KEPT, 'the view opens on the copy')
          await until('the list to be read again behind it', () => walks(requests).length > 0)

          await taking.take(tab)
          await until('the work to come off the copy', async () => !storedListIds((await stored(tab, 'cache.searchLists'))?.[KEY]).includes(TAKEN))
          await tab.goto(`${ARCHIVE}/`, { waitUntil: 'domcontentloaded' })
          held.resolve()

          const { ids, claim } = await storedClaim(tab)
          assert.ok(!ids.includes(TAKEN))
          assert.equal(isFresh(claim, { intervalMs: INTERVAL, listUrl: TO_READ, now: Date.now() }), false, 'the copy claims no read it did not have')

          const before = walks(requests).length
          await visit(tab, TO_READ)
          await until('the list to be read again', async () => (await shownIds(tab)).join() === LIVE.join())
          assert.ok(walks(requests).length > before, 'the next open reads the list again')
        }
        finally {
          held.resolve()
          await tab.close()
        }
      })
    }
  }
})
