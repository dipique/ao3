import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SEED = {
  'option.wordCountToolbar': {
    enabled: true,
    ranges: [
      { from: 1000, to: 3000 },
      { from: 5000, to: 100000 },
      { from: 50000, to: null },
    ],
  },
}

/**
 * A blurb's stats line plus the Sort & Filter sidebar's Word Count fields, in
 * AO3's own markup (see html/fandom-samples/sample-fandom.html). The form is
 * `action="#"` so a submit can be observed without navigating away.
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
 * the configured ranges, writes the pick into AO3's own Word Count filter, and
 * submits so the search re-runs.
 */
describe('word-count range menu', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
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
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Open the menu on the word count and read back its rows. */
  const openMenu = async () => {
    await page.click('#words')
    await sleep(150)
    return page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')].map(el => ({
        label: el.querySelector('.AO3E--menu--label').textContent,
        disabled: el.disabled,
      })))
  }

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
    const items = await openMenu()
    const labels = items.map(i => i.label)
    assert.equal(labels.length, 3, labels.join(' | '))
    assert.ok(labels[0].startsWith('1,000'), labels[0])
    assert.ok(labels[1].startsWith('5,000'), labels[1])
    // An open-ended range reads as "n+".
    assert.ok(labels[2].startsWith('50,000+'), labels[2])
    assert.ok(!labels.some(l => l.includes('Clear')), 'nothing to clear yet')
  })

  test('picking a range fills AO3\'s filter and re-runs the search', async () => {
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      rows.find(el => el.textContent.includes('5,000')).click()
    })
    await sleep(200)
    assert.deepEqual(await bounds(), { from: '5000', to: '100000', submits: 1 })
  })

  test('the applied range is shown as current, and a clear row appears', async () => {
    const items = await openMenu()
    const clear = items.find(i => i.label.startsWith('Clear'))
    assert.ok(clear, items.map(i => i.label).join(' | '))
    assert.ok(clear.label.includes('5,000'), clear.label)
    const applied = items.find(i => i.label.startsWith('5,000'))
    assert.equal(applied.disabled, true, 'the range already on should not be selectable again')
  })

  test('clearing empties both bounds and re-runs the search', async () => {
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      rows.find(el => el.textContent.startsWith('Clear')).click()
    })
    await sleep(200)
    assert.deepEqual(await bounds(), { from: '', to: '', submits: 2 })
  })

  test('Ctrl+Shift+right-click hands the gesture back to the browser', async () => {
    // No preventDefault means the browser's own menu opens instead of ours — all
    // we can observe here is that ours stayed shut and the event was left alone.
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
    await sleep(150)
    assert.equal(defaultPrevented, false, 'the native menu must not be suppressed')
    assert.equal(await page.$('.AO3E--menu'), null, 'our menu must stay shut')
  })

  test('a plain right-click still opens our menu', async () => {
    const defaultPrevented = await page.evaluate(() => new Promise((resolve) => {
      const target = document.getElementById('words')
      document.addEventListener('contextmenu', e => resolve(e.defaultPrevented), { once: true })
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    }))
    await sleep(200)
    assert.equal(defaultPrevented, true)
    assert.notEqual(await page.$('.AO3E--menu'), null)
    await page.keyboard.press('Escape')
    await sleep(150)
  })

  test('an open-ended range leaves the other bound empty', async () => {
    await openMenu()
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      rows.find(el => el.textContent.startsWith('50,000+')).click()
    })
    await sleep(200)
    assert.deepEqual(await bounds(), { from: '50000', to: '', submits: 3 })
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
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
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
      await sleep(1200)
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
