import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep, storedLists } from './helpers.mjs'
import { advanceClock, archiveRoutes, blurbHtml, CLOCK_BASE, installClock, listing, resetWorkIds, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/** Just past the blurb store's ten-minute grace period. */
const PAST_GRACE_MS = 11 * 60_000

/**
 * A reviewed window tidies up after itself.
 *
 * Every window write hands the works the window before it held — and this one
 * doesn't — to the blurb store as candidates for discarding. A reviewed range is
 * disposable by construction: the reader has been through it, and no list will
 * name it again. Left alone it would be forty-odd blurbs a review, for ever,
 * with no quota to bump into and nothing to notice it.
 *
 * Three things are kept even so, and each has a work of its own here: one another
 * stored list still holds, one carrying a mark, and one the reader saved for
 * later during the review. The fourth is plain, and is the one that goes.
 *
 * Four works on the first day and three on each of the next two, against a
 * target of two, so every window is one day and two clicks walk three of them.
 */
describe('tracked review: retiring a reviewed window’s blurbs', { skip }, () => {
  let browser
  let css
  let js
  let tab

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
  }, { timeout: 180000 })

  after(async () => {
    await tab?.close()
    await browser?.close()
  })

  resetWorkIds(8000)
  const since = TODAY - 3
  const first = works([[since, 4]])
  const second = works([[since + 1, 3]])
  const third = works([[since + 2, 3]])
  const solo = listing('solo', [...first, ...second, ...third], { entry: { alias: 'Solo', since } })

  const [marked, saved, elsewhere, plain] = first

  const SEED = {
    'option.searchReadWorks': false,
    'option.markForLaterToolbar': true,
    'option.trackedLists': trackedOption([solo], { target: 2, reviewedThrough: since - 1 }),
    'option.workMarks': {
      enabled: true,
      marks: { favorite: { icon: 'favorite', label: 'Favorite', color: '#b8860b', triggerAlias: 'read', hideSearchResult: false, items: '', order: 0 } },
    },
    // Read, and empty: so the saved-work index is known to this browser, and
    // saving a work during the review is the only thing that puts one in it.
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
    // One work of the first window is also in a list the reader keeps, which is
    // the store's own reason never to discard a blurb.
    ...storedLists({
      'text-search:other': { scrapedAt: CLOCK_BASE, blurbsHtml: [blurbHtml(elsewhere)] },
    }),
  }

  const shortId = id => Number(id).toString(36)

  /** Which of these works still have a stored blurb. */
  const stored = ids => tab.evaluate(async (keys) => {
    const got = await browser.storage.local.get(keys)
    return keys.filter(key => key in got)
  }, ids.map(id => `blurb.${shortId(id)}`))

  const shownIds = () => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => li.id.replace('work_', '')))

  const markReviewed = async () => {
    await tab.click('.AO3E--tracked-review--bar--mark')
    await sleep(4000)
  }

  test('the first window is the first day', async () => {
    tab = await browser.newPage()
    await tab.setViewport({ width: 1280, height: 900 })
    await tab.setRequestInterception(true)
    tab.on('request', archiveRoutes({ fixtures: [solo] }))
    await tab.evaluateOnNewDocument(installClock, CLOCK_BASE)
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(3200)

    assert.deepEqual((await shownIds()).sort(), first.map(work => work.id).sort())
  })

  test('the reader marks one work and saves another', async () => {
    await tab.evaluate(id => browser.storage.local.set({
      'option.workMarks': {
        enabled: true,
        marks: { favorite: { icon: 'favorite', label: 'Favorite', color: '#b8860b', triggerAlias: 'read', hideSearchResult: false, items: Number(id).toString(36), order: 0 } },
      },
    }), marked.id)
    await sleep(2500)

    // Through the blurb's own menu, so the saved-work index learns about it the
    // way it does on any listing.
    await tab.evaluate((id) => {
      document.querySelector(`#work_${id} h4.heading a`).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    }, saved.id)
    await sleep(400)
    const clicked = await tab.evaluate(() => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => el.textContent.trim().startsWith('Mark for later'))
      row?.click()
      return !!row
    })
    assert.equal(clicked, true, 'the work menu should offer to save it')
    await sleep(2500)

    const index = await tab.evaluate(async () =>
      (await browser.storage.local.get('cache.markedForLater'))['cache.markedForLater'])
    assert.equal(index.ids, Number(saved.id).toString(36), 'the saved-work index learned about it')
    assert.equal((await shownIds()).length, 4, 'neither takes a work off the range it is in')
  })

  test('the first Mark reviewed discards nothing — the blurbs are minutes old', async () => {
    await markReviewed()
    assert.deepEqual((await shownIds()).sort(), second.map(work => work.id).sort())
    assert.deepEqual(
      (await stored(first.map(work => work.id))).length,
      4,
      'the grace period spares a blurb fetched moments ago',
    )
  })

  test('the next one discards the work nothing is keeping, and only that one', async () => {
    await advanceClock(tab, PAST_GRACE_MS)
    await markReviewed()
    assert.deepEqual((await shownIds()).sort(), third.map(work => work.id).sort())

    assert.deepEqual(await stored([plain.id]), [], 'nothing holds it, and it is past its grace')
    assert.deepEqual(await stored([marked.id]), [`blurb.${shortId(marked.id)}`], 'it carries a mark')
    assert.deepEqual(await stored([saved.id]), [`blurb.${shortId(saved.id)}`], 'the reader saved it for later')
    assert.deepEqual(await stored([elsewhere.id]), [`blurb.${shortId(elsewhere.id)}`], 'another stored list holds it')
    // The wound-on clock ages every stored blurb, so the window just cleared is
    // past its grace as well and goes in the same pass.
    assert.deepEqual(await stored(second.map(work => work.id)), [])
  })
})
