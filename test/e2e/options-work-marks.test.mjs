import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * A mark table with one non-default entry — `gross` opting out of hiding — so
 * the row's switch has to be reading the stored value rather than assuming the
 * default, and `favorite` inheriting `read`'s.
 */
const SEED = {
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: true, items: 'pico,4mm7y' },
      favorite: { icon: 'favorite', label: 'Favorite', color: '#c2185b', triggerAlias: 'read', items: 'aoehq,6jan1' },
      good: { icon: 'good', label: 'Good', color: '#2f8f4e', triggerAlias: 'read', items: '' },
      gross: { icon: 'gross', label: 'Gross', color: '#4d7c0f', triggerAlias: 'read', hideSearchResult: false, items: '' },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
    },
  },
}

/**
 * The work-marks row is built entirely from the stored mark table — one row per
 * mark that holds ids, its icon and colour from the table, and its "hide in
 * listings" switch reading through the trigger alias. Nothing about `favorite`
 * or `gross` is written into the component, so a table with different marks in
 * it renders different rows.
 */
describe('options UI — work marks', { skip }, () => {
  let server
  let browser
  let page
  const consoleMsgs = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    page.on('console', m => consoleMsgs.push({ type: m.type(), text: m.text() }))
    page.on('pageerror', e => consoleMsgs.push({ type: 'pageerror', text: e.message }))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** The rendered rows: label, count line, and whether the hide switch is on. */
  const rows = () => page.evaluate(() => {
    const switches = [...document.querySelectorAll('[role="switch"]')]
    return switches
      .map(s => ({ s, label: s.getAttribute('aria-label') ?? '' }))
      .filter(({ label }) => label.startsWith('Hide works marked '))
      .map(({ s, label }) => ({
        mark: label.slice('Hide works marked '.length).replace(' in listings', ''),
        on: s.getAttribute('aria-checked') === 'true' || s.dataset.state === 'checked',
        // The count line sits in the row's first grid cell, two siblings back.
        text: s.previousElementSibling?.textContent ?? '',
      }))
  })

  test('renders one row per mark that holds ids, in table order', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.mark), ['Read', 'Favorite', 'Good', 'Gross'])
  })

  test('shows each mark\'s count, and what it counts as', async () => {
    const got = await rows()
    assert.match(got[0].text, /2 works/)
    assert.match(got[1].text, /2 works/)
    assert.match(got[1].text, /counts as Read/, 'an aliased mark says what it behaves as')
    assert.match(got[2].text, /0 works/)
    assert.doesNotMatch(got[0].text, /counts as/, 'the root mark aliases nothing')
  })

  test('the hide switch reads through the trigger alias', async () => {
    const got = await rows()
    assert.equal(got[0].on, true, 'read hides')
    assert.equal(got[1].on, true, 'favorite inherits read')
    assert.equal(got[2].on, true, 'good inherits read')
    assert.equal(got[3].on, false, 'gross set its own value')
  })

  test('toggling a mark that follows its root stores an override', async () => {
    const before = await rows()
    assert.equal(before[1].on, true)
    await page.evaluate(() => {
      const s = [...document.querySelectorAll('[role="switch"]')]
        .find(el => el.getAttribute('aria-label') === 'Hide works marked Favorite in listings')
      s.click()
    })
    await sleep(1000)
    const stored = await page.evaluate(() => {
      const w = window.__writes.filter(x => 'option.workMarks' in x).map(x => x['option.workMarks'])
      return w.at(-1) ?? null
    })
    assert.equal(stored?.marks?.favorite?.hideSearchResult, false, 'diverging from the root is stored')
    assert.equal(stored?.marks?.read?.hideSearchResult, true, 'the root is untouched')
  })

  test('renders without console errors', () => {
    const errors = consoleMsgs.filter(m => m.type === 'pageerror' || m.type === 'error')
    assert.deepEqual(errors, [])
  })
})
