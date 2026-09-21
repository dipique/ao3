import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'
import { archiveRoutes, CLOCK_BASE, installClock, listing, resetWorkIds, TODAY, trackedOption, works } from './trackedReview.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const REVIEW_URL = 'https://archiveofourown.org/users/me/readings#ao3e-tracked'

/**
 * A review holds its pages still.
 *
 * The reader walks a review in order, and every mark they make re-runs the page
 * and rebuilds the view from scratch. If the rebuild simply re-applied the hide
 * pass and the facet filters, anything that dropped out would shorten the list
 * and pull every later work back a slot — the last work of page 2 onto page 1,
 * which they have already been through. So the view keeps the page layout it had
 * and draws a work that would now drop out collapsed in its slot instead.
 *
 * Fifteen works on one day, five to a page: the reader stands on page 2 and
 * everything done here is done to works on pages 2 and 3.
 */
describe('tracked review: the pages hold still', { skip }, () => {
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

  resetWorkIds(9000)
  const since = TODAY - 1
  const all = works([[since, 15]])
  // One on page 2 and one on page 3, so a rule added part-way through has
  // something to take out of the slot the reader is looking at and something to
  // take out of a page they have not reached.
  all[6].tags = ['Nope']
  all[11].tags = ['Nope']
  const solo = listing('solo', all, { entry: { alias: 'Solo', since } })

  const SEED = {
    'option.searchReadWorks': false,
    'option.searchPerPage': 5,
    // Hiding takes a work out of the listing rather than squeezing it down, which
    // is the setting under which a slot would otherwise be lost.
    'option.hideShowReason': false,
    'option.trackedLists': trackedOption([solo], { target: 40, reviewedThrough: since - 1 }),
    'cache.markedForLater': { userId: 'me', updatedAt: CLOCK_BASE, ids: '' },
  }

  const page2 = all.slice(5, 10).map(work => work.id)

  /** The ids in the results list, in page order, and which of them are collapsed. */
  const slots = () => tab.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      .map(li => ({ id: li.id.replace('work_', ''), collapsed: !!li.querySelector('.AO3E--hide-works--msg') })))

  /** Which page the pager says the reader is on. */
  const currentPage = () => tab.evaluate(() =>
    document.querySelector('.AO3E--search-view--pager .AO3E--search-view--page-current')?.textContent?.trim()
    ?? document.querySelector('.AO3E--search-view--pager [aria-current="page"]')?.textContent?.trim()
    ?? null)

  const goToPage = async (number) => {
    await tab.evaluate((want) => {
      const buttons = [...document.querySelectorAll('.AO3E--search-view--pager button, .AO3E--search-view--pager a')]
      buttons.find(el => el.textContent.trim() === String(want)).click()
    }, number)
    await sleep(600)
  }

  const setOption = async (key, value) => {
    await tab.evaluate((k, v) => browser.storage.local.set({ [k]: v }), key, value)
    await sleep(2500)
  }

  test('fifteen works over three pages, and the reader walks to page 2', async () => {
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

    assert.deepEqual((await slots()).map(slot => slot.id), all.slice(0, 5).map(work => work.id))
    await goToPage(2)
    assert.deepEqual((await slots()).map(slot => slot.id), page2)
  })

  test('a hide rule added part-way through collapses a slot instead of closing it', async () => {
    await setOption('option.rules', {
      enabled: true,
      filters: [{ target: 'tag', value: 'Nope', matcher: 'exact', behavior: 'hide' }],
      colors: {},
    })

    const after2 = await slots()
    assert.deepEqual(after2.map(slot => slot.id), page2, 'the same five works, in the same slots')
    assert.deepEqual(after2.filter(slot => slot.collapsed).map(slot => slot.id), [all[6].id])
    assert.equal(await currentPage(), '2', 'and the reader has not been moved')
  })

  test('so does a mark that hides works from listings', async () => {
    await setOption('option.workMarks', {
      enabled: true,
      marks: {
        boring: {
          icon: 'boring',
          label: 'Boring',
          color: '#6b7280',
          hideSearchResult: true,
          items: Number(all[7].id).toString(36),
          order: 0,
        },
      },
    })

    const marked = await slots()
    assert.deepEqual(marked.map(slot => slot.id), page2, 'still the same five works')
    assert.deepEqual(marked.filter(slot => slot.collapsed).map(slot => slot.id).sort(), [all[6].id, all[7].id].sort())
    assert.equal(await currentPage(), '2')
  })

  test('and a work on a page the reader has not reached keeps its own slot too', async () => {
    await goToPage(3)
    const page3 = await slots()
    assert.deepEqual(page3.map(slot => slot.id), all.slice(10, 15).map(work => work.id))
    assert.deepEqual(page3.filter(slot => slot.collapsed).map(slot => slot.id), [all[11].id])
  })

  test('a filter the reader changes themselves does re-lay the pages', async () => {
    // Every work carries this fandom, so the filter changes nothing about which
    // works match — only that the reader asked, which is what re-lays the pages.
    await tab.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.AO3E--search-view--row'))
        .find(el => el.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === 'Fandom')
      row.querySelector('.AO3E--search-view--toggle-include').click()
    })
    await sleep(800)
    assert.equal(await currentPage(), '1', 'a reshuffle is always something the reader started')
    const shown = await slots()
    assert.equal(shown.length, 5)
    assert.deepEqual(shown.filter(slot => slot.collapsed), [], 'and nothing is holding a slot it no longer earns')
  })
})
