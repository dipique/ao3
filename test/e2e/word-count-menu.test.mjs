import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { serializeWordCountQuery } from '../../src/common/wordCount.ts'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { menuClosed, menuGuardOver, menuRows, openMenu, pickRow, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const RANGES = [
  { from: 1000, to: 3000 },
  { from: 5000, to: 100000 },
  { from: 50000, to: null },
]

const SEED = {
  'option.wordCountToolbar': { enabled: true, ranges: RANGES },
}

/** How each range's row names the range it applies. */
const RANGE = RANGES.map(serializeWordCountQuery)

/**
 * A blurb's stats line plus the Sort & Filter sidebar's Word Count fields, in
 * AO3's own markup. The form is `action="#"` so a submit can be observed
 * without navigating away.
 */
const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="blurb work" id="blurb">
      <h4 class="heading"><a href="/works/1">A work</a></h4>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words" id="words">7,150</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">1/1</dd>
        <dt class="kudos">Kudos:</dt>
        <dd class="kudos">12</dd>
        <dt class="hits">Hits:</dt>
        <dd class="hits">400</dd>
      </dl>
    </li>
  </ol>

  <form id="work-filters" method="get" action="#">
    <dt id="toggle_work_words" class="filter-toggle words">Word Count</dt>
    <dd id="work_words" class="expandable">
      <dl class="range">
        <dt><label for="work_search_words_from">From</label></dt>
        <dd><input type="text" name="work_search[words_from]" id="work_search_words_from"></dd>
        <dt><label for="work_search_words_to">To</label></dt>
        <dd><input type="text" name="work_search[words_to]" id="work_search_words_to"></dd>
      </dl>
    </dd>
  </form>
</div>
`

/**
 * The word-count menu on a native listing: clicking a work's word count offers
 * the configured ranges and writes the pick into AO3's own Word Count filter —
 * without submitting it, so the reader runs the search when they're ready.
 */
describe('word-count range menu', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await launch(chromePath)
    page = await browser.newPage()
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)
    await page.evaluate((html) => {
      document.body.innerHTML = html
      // Record submits instead of letting them navigate this about:blank page.
      window.__submits = 0
      document.getElementById('work-filters').addEventListener('submit', (e) => {
        e.preventDefault()
        window.__submits++
      })
    }, PAGE)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await settled(page)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Open the menu on the word count and read back its rows. */
  const openWordCountMenu = async () => {
    // The menu is drawn at the click point, so it can cover the word count that
    // opened it — dismiss whatever is up before aiming at it again.
    await page.keyboard.press('Escape')
    await menuClosed(page)
    await openMenu(page, () => page.click('#words'))
    return menuRows(page)
  }

  /** Click the row that does `action` — to `value`, when given — and wait for the menu to close behind it. */
  const pick = async (action, value) => {
    assert.ok(await pickRow(page, action, value), `no ${action} row ${value ?? ''}`)
    await menuClosed(page)
  }

  /** The values of the rows that do `action`, in order. */
  const valuesOf = (items, action) => items.filter(i => i.action === action).map(i => i.value)

  const bounds = () => page.evaluate(() => ({
    from: document.getElementById('work_search_words_from').value,
    to: document.getElementById('work_search_words_to').value,
    submits: window.__submits,
  }))

  test('marks the word count as clickable', async () => {
    // Both the "Words:" label and the number are wired — and nothing else: the
    // wrapper Stats puts around each stat must not inherit the marker.
    const marked = await page.evaluate(() =>
      [...document.querySelectorAll('#blurb .AO3E--word-count')].map(el => el.tagName))
    assert.deepEqual(marked, ['DT', 'DD'])
  })

  test('offers every configured range, and no clear row while none is set', async () => {
    const items = await openWordCountMenu()
    assert.deepEqual(valuesOf(items, 'range'), RANGE)
    assert.ok(!items.some(i => i.action === 'clear'), 'nothing to clear yet')
  })

  test('picking a range fills AO3\'s filter without re-running the search', async () => {
    await pick('range', RANGE[1])
    assert.deepEqual(await bounds(), { from: '5000', to: '100000', submits: 0 })
  })

  test('the applied range is shown as current, and a clear row appears', async () => {
    const items = await openWordCountMenu()
    assert.ok(items.some(i => i.action === 'clear'), items.map(i => i.action).join(' | '))
    const applied = items.find(i => i.action === 'range' && i.value === RANGE[1])
    assert.equal(applied.active, true, 'the range already on is shown as current')
    assert.equal(applied.disabled, true, 'the range already on should not be selectable again')
  })

  test('clearing empties both bounds without re-running the search', async () => {
    await pick('clear')
    assert.deepEqual(await bounds(), { from: '', to: '', submits: 0 })
  })

  test('Ctrl+Shift+right-click hands the gesture back to the browser', async () => {
    // No preventDefault means the browser's own menu opens instead of ours — all
    // we can observe here is that ours stayed shut and the event was left alone.
    await menuGuardOver(page)
    const defaultPrevented = await page.evaluate(() => new Promise((resolve) => {
      const target = document.getElementById('words')
      document.addEventListener('contextmenu', e => resolve(e.defaultPrevented), { once: true })
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        shiftKey: true,
      }))
    }))
    assert.equal(defaultPrevented, false, 'the native menu must not be suppressed')
    assert.equal(await page.$('.AO3E--menu'), null, 'our menu must stay shut')
  })

  test('a plain right-click still opens our menu', async () => {
    const defaultPrevented = await openMenu(page, () => page.evaluate(() => new Promise((resolve) => {
      const target = document.getElementById('words')
      document.addEventListener('contextmenu', e => resolve(e.defaultPrevented), { once: true })
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })))
    assert.equal(defaultPrevented, true)
    assert.notEqual(await page.$('.AO3E--menu'), null)
    await page.keyboard.press('Escape')
    await menuClosed(page)
  })

  test('an open-ended range leaves the other bound empty', async () => {
    await openWordCountMenu()
    await pick('range', RANGE[2])
    assert.deepEqual(await bounds(), { from: '50000', to: '', submits: 0 })
  })

  test('the bound sections list the configured bounds, the one applied marked current, and a pick writes its bound alone', async () => {
    // Which bounds the sections offer, how each row is labelled and which bound
    // a pick keeps is `uniqueBounds`', `formatBoundPick`'s and `withBound`'s
    // business, tested case by case in `test/wordCount/ranges.test.mjs`; here,
    // that the menu draws their result and a pick reaches AO3's filter.
    const items = await openWordCountMenu()
    assert.deepEqual(valuesOf(items, 'from'), ['1000', '5000', '50000'])
    assert.deepEqual(valuesOf(items, 'to'), ['3000', '100000'])
    // 50,000+ is the range currently applied, so its lower bound is the one on.
    const applied = items.find(i => i.action === 'from' && i.value === '50000')
    assert.equal(applied.disabled, true, 'the bound already on should not be selectable again')

    await pick('to', '100000')
    assert.deepEqual(await bounds(), { from: '50000', to: '100000', submits: 0 })
  })
})

/**
 * The default-range setting, the word-count twin of the default search language:
 * it fills the same Sort & Filter fields on page load, and only when nothing is
 * set yet.
 */
describe('default word count range', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Load PAGE with the given seed and the given pre-filled bounds; read them back. */
  async function run(seed, prefill = {}) {
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    const page = await browser.newPage()
    try {
      await page.goto('about:blank')
      await page.evaluate(installMock, seed)
      await page.evaluate((html, values) => {
        document.body.innerHTML = html
        document.getElementById('work-filters').addEventListener('submit', e => e.preventDefault())
        if (values.from)
          document.getElementById('work_search_words_from').value = values.from
        if (values.to)
          document.getElementById('work_search_words_to').value = values.to
      }, PAGE, prefill)
      await page.addScriptTag({ content: js })
      await settled(page)
      return await page.evaluate(() => ({
        from: document.getElementById('work_search_words_from').value,
        to: document.getElementById('work_search_words_to').value,
      }))
    }
    finally {
      await page.close()
    }
  }

  test('fills both bounds when the filter is empty', async () => {
    const result = await run({ 'option.searchWordCount': { enabled: true, from: 2000, to: 40000 } })
    assert.deepEqual(result, { from: '2000', to: '40000' })
  }, { timeout: 60000 })

  test('leaves a range the page already carries alone', async () => {
    const result = await run(
      { 'option.searchWordCount': { enabled: true, from: 2000, to: 40000 } },
      { from: '500' },
    )
    assert.deepEqual(result, { from: '500', to: '' })
  }, { timeout: 60000 })

  test('does nothing while the setting is off', async () => {
    const result = await run({ 'option.searchWordCount': { enabled: false, from: 2000, to: 40000 } })
    assert.deepEqual(result, { from: '', to: '' })
  }, { timeout: 60000 })

  test('a one-sided default leaves the other bound empty', async () => {
    const result = await run({ 'option.searchWordCount': { enabled: true, from: null, to: 5000 } })
    assert.deepEqual(result, { from: '', to: '5000' })
  }, { timeout: 60000 })

  test('an upside-down range is ignored rather than applied', async () => {
    const result = await run({ 'option.searchWordCount': { enabled: true, from: 9000, to: 100 } })
    assert.deepEqual(result, { from: '', to: '' })
  }, { timeout: 60000 })
})
