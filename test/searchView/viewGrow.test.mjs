import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * Runs in the page: a search view over works 1 … `count`, two to a page, the
 * first six in fandom "Alpha" and the rest in "Beta". `window.__make(ids)` makes
 * the works with those ids, each made once and then handed out again, as a load
 * hands the same works to every report.
 */
function mountView(count) {
  const made = new Map()
  window.__make = ids => ids.map((id) => {
    if (!made.has(id)) {
      const li = document.createElement('li')
      li.className = 'work blurb group'
      li.id = `work_${id}`
      li.innerHTML = `<div class="header module"><h4 class="heading"><a href="https://archiveofourown.org/works/${id}">Work ${id}</a>
          by <a rel="author" href="https://archiveofourown.org/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="https://archiveofourown.org/tags/x/works">${id <= 6 ? 'Alpha' : 'Beta'}</a></h5></div>
        <dl class="stats"><dt class="words">Words:</dt><dd class="words">100</dd></dl>`
      made.set(id, globalThis.View.parseWork(li, id - 1))
    }
    return made.get(id)
  })
  const ids = Array.from({ length: count }, (_, i) => i + 1)
  window.__view = globalThis.View.createSearchView(window.__make(ids), {}, { perPage: 2, defaultStatus: [] })
  document.body.replaceChildren(window.__view.el)
}

/** Runs in the page: what the view shows, as a reader reads it. */
function shown() {
  const root = document.querySelector('.AO3E--search-view')
  const blurbs = [...root.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
  const alpha = [...root.querySelectorAll('.AO3E--search-view--row')]
    .find(row => row.querySelector('.AO3E--search-view--row-name')?.textContent.trim() === 'Alpha')
  return {
    page: root.querySelector('.AO3E--search-view--page[aria-current="page"]')?.textContent ?? null,
    titles: blurbs.map(li => li.querySelector('h4 a').textContent),
    alphaIncluded: alpha?.querySelector('.AO3E--search-view--toggle-include').getAttribute('aria-pressed') ?? null,
    count: root.querySelector('.AO3E--search-view--count').textContent,
  }
}

/**
 * The view's grow mode: a load that is still coming in hands the view the
 * works it has so far, again and again, and the reader goes on working in it.
 */
describe('SearchView.grow', { skip: skipWithoutChrome }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage('test/searchView/viewEntry.ts', 'View', { stubBrowser: true }))
  }, { timeout: 120000 })

  after(async () => {
    await close?.()
  })

  /** Click the toggle or page button `selector` names, the `text` one among them if given. */
  const press = (selector, text) => page.evaluate((sel, label) => {
    const buttons = [...document.querySelectorAll(sel)]
    const button = label === undefined ? buttons[0] : buttons.find(b => b.textContent.trim() === label)
    button.click()
  }, selector, text)

  const includeAlpha = () => page.evaluate(() => [...document.querySelectorAll('.AO3E--search-view--row')]
    .find(row => row.querySelector('.AO3E--search-view--row-name')?.textContent.trim() === 'Alpha')
    .querySelector('.AO3E--search-view--toggle-include')
    .click())

  test('keeps the page, the selection and the blurbs on screen as works arrive', async () => {
    await page.evaluate(mountView, 4)
    await includeAlpha()
    await press('.AO3E--search-view--page', '2')
    assert.deepEqual(await page.evaluate(shown), { page: '2', titles: ['Work 3', 'Work 4'], alphaIncluded: 'true', count: 'Showing 3–4 of 4 works' })
    await page.evaluate(() => {
      window.__before = [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
    })

    await page.evaluate(() => window.__view.grow(window.__make(Array.from({ length: 10 }, (_, i) => i + 1))))

    assert.deepEqual(await page.evaluate(shown), { page: '2', titles: ['Work 3', 'Work 4'], alphaIncluded: 'true', count: 'Showing 3–4 of 6 (10) works' })
    assert.ok(await page.evaluate(() => {
      const now = [...document.querySelectorAll('.AO3E--search-view--results > li.blurb:not(.AO3E--search-view--hidden)')]
      return now.length === window.__before.length && now.every((li, i) => li === window.__before[i])
    }), 'the same blurbs, not drawn again')
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.AO3E--search-view--page')].some(b => b.textContent === '3')), 'the pager has the new page')
  })

  test('a grow that takes works away clamps the page', async () => {
    await page.evaluate(mountView, 10)
    await includeAlpha()
    await press('.AO3E--search-view--page', '3')
    assert.equal((await page.evaluate(shown)).page, '3')

    await page.evaluate(() => window.__view.grow(window.__make([1, 2, 3, 7, 8])))

    assert.deepEqual(await page.evaluate(shown), { page: '2', titles: ['Work 3'], alphaIncluded: 'true', count: 'Showing 3–3 of 3 (5) works' })
    assert.deepEqual(await page.evaluate(() => window.__view.getWorks().map(w => w.workId)), ['1', '2', '3', '7', '8'])
  })

  test('keeps a selection the works no longer carry, for the works still to come', async () => {
    await page.evaluate(mountView, 10)
    await includeAlpha()

    await page.evaluate(() => window.__view.grow(window.__make([7, 8])))
    assert.equal((await page.evaluate(shown)).count, 'No works match')
    assert.deepEqual(await page.evaluate(() => [...window.__view.getState().filter.facets.fandoms.include]), ['Alpha'])

    await page.evaluate(() => window.__view.grow(window.__make([7, 8, 1, 2])))
    assert.deepEqual((await page.evaluate(shown)).titles, ['Work 1', 'Work 2'])
  })
})
