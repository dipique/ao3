import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, launch, openWindow } from './helpers.mjs'
import { linkWrites, persistentMock, relayWrites, rerun, settled, stored } from './trackedPages.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, MS_PER_DAY, resetWorkIds, reviewDrawn, reviewStatus, statusIs, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * The review drawn from the tracked lists' read records, and the reading that
 * keeps them up to date in the background.
 *
 * What is pinned down is what is asked of the archive, and when: nothing at all
 * for a review whose records are whole; the stored window at once, with the
 * works a page brings merged in as it lands, when they are behind; nothing for
 * the next window when the reading has run ahead; nothing from a second tab,
 * which merges what the first one reads. And that Mark reviewed on a window
 * still being read asks the reader nothing.
 */
describe('tracked review: from the records', { skip }, () => {
  let browser
  let css
  let js

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => browser?.close())

  resetWorkIds(11000)
  const since = TODAY - 8
  // Three works a day over eight days, a target of six: a window is two days.
  const solo = listing('solo', Array.from({ length: 8 }, (_, i) => [since + i, 3]), { entry: { alias: 'Solo', since } })
  const fixtures = [solo]
  const seed = {
    'option.searchReadWorks': false,
    'option.trackedLists': trackedOption(fixtures, { target: 6, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  /**
   * A tab on the stand-in archive whose storage outlives a load, the review
   * opened in it. `hold(url)` keeps a list request's answer back until
   * `release()`. `days` winds the page's clock on.
   */
  async function open({ store = seed, lists = fixtures, fetched = [], hold = () => false, days = 0, window = false, link } = {}) {
    const tab = window ? await openWindow(browser) : await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    const route = archiveRoutes({ fixtures: lists, fetched })
    const held = []
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/') && hold(new URL(req.url())))
        held.push(() => route(req))
      else
        route(req)
    })
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE + days * MS_PER_DAY)
    await tab.evaluateOnNewDocument(persistentMock(store))
    if (link)
      await tab.evaluateOnNewDocument(relayWrites)
    const release = () => {
      for (const answer of held.splice(0))
        answer()
    }
    return { tab, fetched, held, release }
  }

  /** Load the review (or another page) in `tab`, and put the content script in. */
  async function load(tab, url = REVIEW_URL) {
    await tab.goto(url, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
  }

  const listRequests = fetched => fetched.filter(path => path.includes('/tags/'))

  const shownIds = tab => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => li.id.replace('work_', '')))

  /** Where the status line stands: its kind, and where a pending window is being read. */
  const status = async (tab) => {
    const { kind, reading } = await reviewStatus(tab)
    return { kind, reading }
  }
  const UP_TO_DATE = { kind: 'current', reading: null }
  const READING_HERE = { kind: 'pending', reading: 'here' }

  const ids = (from, to) => solo.works.filter(work => work.filed >= from && work.filed <= to).map(work => work.id)

  test('a first open reads the lists in the background; opened again with the records whole, it asks the archive for nothing', async () => {
    const { tab, fetched } = await open()
    try {
      await load(tab)
      await reviewDrawn(tab)
      assert.ok(listRequests(fetched).length > 0, 'the first open read the list')
      assert.deepEqual(await shownIds(tab), ids(since, since + 1))
      assert.deepEqual(await status(tab), UP_TO_DATE)

      const before = listRequests(fetched).length
      await load(tab)
      await reviewDrawn(tab)
      assert.deepEqual(await shownIds(tab), ids(since, since + 1))
      assert.equal(listRequests(fetched).length, before, 'nothing asked of AO3')
    }
    finally {
      await tab.close()
    }
  })

  test('behind by a day, it draws the stored window at once, then merges what the reading brings', async () => {
    // A first visit leaves its records and window in the store, all read.
    const first = await open()
    let store
    try {
      await load(first.tab)
      await reviewDrawn(first.tab)
      store = await first.tab.evaluate(() => JSON.parse(localStorage.getItem('__ao3eMockStore')).store)
    }
    finally {
      await first.tab.close()
    }

    // The next day, with a target that takes in every day, and one more work
    // filed on the day before.
    const late = works([[TODAY, 1]])
    solo.works.push(...late)
    try {
      const lifted = { ...store, 'option.trackedLists': { ...store['option.trackedLists'], target: 100 } }
      const second = await open({ store: lifted, days: 1, hold: url => url.pathname.includes('/tags/') })
      try {
        await load(second.tab)
        await second.tab.waitForFunction(() => !!document.querySelector('.AO3E--tracked-review--bar--status'))
        assert.ok(second.held.length > 0, 'the reading is waiting on the archive')
        assert.deepEqual(await shownIds(second.tab), ids(since, TODAY - 1), 'the stored works, drawn before the archive answers')
        assert.deepEqual(await status(second.tab), READING_HERE)

        second.release()
        await reviewDrawn(second.tab)
        await second.tab.waitForFunction(id => !!document.querySelector(`#work_${id}`), {}, late[0].id)
        assert.deepEqual((await shownIds(second.tab)).slice(0, 3), ids(since, since).slice(0, 3), 'nothing before it moved')
        assert.deepEqual(await status(second.tab), UP_TO_DATE)
      }
      finally {
        await second.tab.close()
      }
    }
    finally {
      solo.works.splice(solo.works.indexOf(late[0]), 1)
    }
  })

  test('Mark reviewed shows the next window without asking the archive, when the reading has run ahead', async () => {
    const { tab, fetched } = await open()
    try {
      await load(tab)
      await reviewDrawn(tab)
      const before = listRequests(fetched).length
      await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--mark'))
      await reviewDrawn(tab)
      assert.deepEqual(await shownIds(tab), ids(since + 2, since + 3))
      assert.equal(listRequests(fetched).length, before, 'nothing asked of AO3')
      assert.equal((await stored(tab, 'option.trackedLists')).reviewedThrough, since + 1)
      const record = await tab.evaluate(async () => (await browser.storage.local.get('trackedRead.solo'))['trackedRead.solo'])
      assert.equal(record.from, since + 2, 'the reviewed days are off the record')
    }
    finally {
      await tab.close()
    }
  })

  test('Mark reviewed on a window still being read stores the watermark, asking nothing; the reading then keeps the reviewed days off', async () => {
    // A target that takes in every day, and the list's second page held back:
    // the window runs to yesterday, and is still being read.
    const store = { ...seed, 'option.trackedLists': trackedOption(fixtures, { target: 100, reviewedThrough: since - 1 }) }
    const { tab, release, held } = await open({ store, hold: url => url.pathname.includes('/tags/') && url.searchParams.get('page') === '2' })
    try {
      await load(tab)
      await statusIs(tab, 'pending', 'here')
      assert.ok(held.length > 0)
      const end = await tab.evaluate(async () => (await browser.storage.local.get('cache.trackedReview'))['cache.trackedReview'].end)
      await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--mark'))
      assert.equal(await tab.$('.AO3E--tracked-review--bar--prompt .AO3E--tracked-review--bar--confirm'), null, 'no confirmation asked')
      assert.equal((await stored(tab, 'option.trackedLists')).reviewedThrough, end)

      release()
      await tab.waitForFunction(async after => (await browser.storage.local.get('trackedRead.solo'))['trackedRead.solo']?.through >= after, {}, TODAY - 1)
      const record = await tab.evaluate(async () => (await browser.storage.local.get('trackedRead.solo'))['trackedRead.solo'])
      assert.equal(record.from, end + 1, 'the page that landed after was added to the record as pruned')
      assert.equal(record.rows, '')
    }
    finally {
      await tab.close()
    }
  })

  test('a second tab merges what the first one reads, asking the archive nothing itself', async () => {
    const store = { ...seed, 'option.trackedLists': trackedOption(fixtures, { target: 100, reviewedThrough: since - 1 }) }
    let holding = true
    const reader = await open({ store, hold: url => holding && url.pathname.includes('/tags/'), window: true, link: true })
    const follower = await open({ store, window: true, link: true })
    try {
      // Both on the archive, linked, before either writes: the second waits on
      // History, where the review isn't open, until the first is reading.
      await linkWrites([reader.tab, follower.tab])
      await load(follower.tab, REVIEW_URL.replace('#ao3e-tracked', ''))
      await load(reader.tab)
      await statusIs(reader.tab, 'pending', 'here')
      await follower.tab.click('.AO3E--tracked-review--button')
      await statusIs(follower.tab, 'pending', 'elsewhere')

      holding = false
      reader.release()
      await reviewDrawn(reader.tab)
      await follower.tab.waitForFunction(count => document.querySelectorAll('.AO3E--search-view--results > li.blurb').length === count, {}, solo.works.length)
      assert.equal(listRequests(follower.fetched).length, 0, 'the second tab asked AO3 for nothing')
      assert.deepEqual(await status(follower.tab), UP_TO_DATE)
    }
    finally {
      await reader.tab.close()
      await follower.tab.close()
    }
  })

  test('a list read later that ends the window earlier collapses the works past its end, and Mark reviewed brings them back', async () => {
    resetWorkIds(12000)
    const start = TODAY - 6
    // Alpha, read first, puts two works on each day; Beta, read after, puts
    // thirty on the first, which ends the window there. Beta's second page is
    // held back, so the window is still being read when Beta's first lands.
    const alpha = listing('alpha', Array.from({ length: 6 }, (_, i) => [start + i, 2]), { entry: { alias: 'Alpha', since: start } })
    const beta = listing('beta', [[start, 30]], { entry: { alias: 'Beta', since: start } })
    const lists = [alpha, beta]
    const store = { ...seed, 'option.trackedLists': trackedOption(lists, { target: 10, reviewedThrough: start - 1 }) }
    const { tab, release } = await open({ store, lists, hold: url => url.pathname.includes('/beta/') && url.searchParams.get('page') === '2' })
    // No rule hides anything here, so a work drawn collapsed is one holding its slot.
    const collapsed = () => tab.evaluate(() => [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .filter(li => li.querySelector('.AO3E--hide-works--msg'))
      .map(li => li.id.replace('work_', '')))
    try {
      await load(tab)
      const later = alpha.works.filter(work => work.filed > start).slice(0, 8).map(work => work.id)
      await tab.waitForFunction(count => [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
        .filter(li => li.querySelector('.AO3E--hide-works--msg'))
        .length === count, {}, later.length)
      assert.deepEqual((await collapsed()).sort(), later.sort(), 'Alpha’s works past the new end hold their slots')
      assert.deepEqual(await status(tab), READING_HERE)
      assert.equal((await reviewStatus(tab)).lists, 'Beta', 'Beta is still being read')

      release()
      await reviewDrawn(tab)
      await rerun(tab, () => tab.click('.AO3E--tracked-review--bar--mark'))
      await reviewDrawn(tab)
      const shown = await shownIds(tab)
      assert.ok(later.slice(0, 2).every(id => shown.includes(id)), 'the next window holds them')
      assert.deepEqual(await collapsed(), [])
    }
    finally {
      await tab.close()
    }
  })

  test('a window with nothing in it stays open while it is read, and closes with the empty range’s offer once it is', async () => {
    resetWorkIds(12500)
    const quiet = listing('quiet', [[TODAY, 3]], { entry: { alias: 'Quiet', since: TODAY - 3 } })
    const lists = [quiet]
    const store = { ...seed, 'option.trackedLists': trackedOption(lists, { target: 10, reviewedThrough: TODAY - 4 }) }
    const { tab, release } = await open({ store, lists, hold: url => url.pathname.includes('/quiet/') })
    try {
      await load(tab)
      await statusIs(tab, 'pending', 'here')
      assert.ok(await tab.$('.AO3E--search-host.AO3E--tracked-review'), 'the view is up, empty, while the list is read')

      release()
      await tab.waitForFunction(() => !document.querySelector('.AO3E--search-host'))
      await tab.waitForFunction(() => [...document.querySelectorAll('body > div')]
        .some(el => !!el.shadowRoot?.querySelector('.toast[data-ao3e-toast="nothing-to-review"] button.action')))
    }
    finally {
      await tab.close()
    }
  })
})
