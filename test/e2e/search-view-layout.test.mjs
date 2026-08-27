import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'
const SEED = { 'option.searchMarkedForLater': true }

const TAG = 'Alternate Universe - Coffee Shop Owners Who Are Also Secretly Vampires'

function blurb(id) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work number ${id} with a reasonably long title</a>
          by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas"><li class="freeforms"><a class="tag" href="/tags/x">${TAG}</a></li></ul>
      <dl class="stats">
        <dt class="words">Words:</dt><dd class="words">7,150</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

/**
 * `mainCss` stands in for an AO3 skin that constrains `#main` to a fixed column.
 * Plenty do, and it is the case the default skin never exercises: the window
 * stays wide while the space the view actually gets is a few hundred pixels.
 */
function readings(mainCss) {
  // Enough works to run past one page, so the pager is actually rendered.
  const blurbs = Array.from({ length: 120 }, (_, i) => blurb(i + 1)).join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Marked for Later</title>
<style>body { font-family: Verdana, sans-serif; margin: 0 } #main { ${mainCss} }</style></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">${blurbs}</ol>
  </div>
</body></html>`
}

/**
 * How the in-memory view lays itself out in the space it is given. The sidebar
 * and results are a two-column grid that has to collapse when there isn't room —
 * and "room" is the view's own box, not the window, because a skin can pin the
 * window wide open while leaving the view a sliver.
 */
describe('the search view layout', { skip }, () => {
  let browser
  let css
  let js

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
    await browser?.close()
  })

  /** Open the view at `width` with `#main` styled by `mainCss`. */
  const openView = async (width, mainCss, seed = SEED) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width, height: 900 })
    const body = readings(mainCss)
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1200)
    await tab.click('.AO3E--search-marked-for-later--button')
    await sleep(1800)
    return tab
  }

  /** Width of the filter column as actually laid out. */
  const sidebarWidth = tab => tab.evaluate(() =>
    Math.round(document.querySelector('.AO3E--search-view--sidebar').getBoundingClientRect().width))

  /** Drag the handle by `dx` pixels. */
  const dragBy = async (tab, dx) => {
    const box = await tab.$eval('.AO3E--search-view--resizer', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + 40 }
    })
    await tab.mouse.move(box.x, box.y)
    await tab.mouse.down()
    await tab.mouse.move(box.x + dx, box.y, { steps: 8 })
    await tab.mouse.up()
    await sleep(250)
  }

  /** The sidebarWidth the view last wrote to its stored prefs. */
  const storedWidth = tab => tab.evaluate(() => {
    const writes = window.__writes ?? []
    for (let i = writes.length - 1; i >= 0; i--) {
      const prefs = writes[i]['cache.searchViewPrefs']
      const entry = prefs && Object.values(prefs)[0]
      if (entry && entry.sidebarWidth !== undefined)
        return entry.sidebarWidth
    }
    return null
  })

  /** Open the view at `width` with `#main` styled by `mainCss`, and measure it. */
  const measure = async (width, mainCss) => {
    const tab = await browser.newPage()
    await tab.setViewport({ width, height: 900 })
    const body = readings(mainCss)
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, SEED)
    await tab.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1200)
    await tab.click('.AO3E--search-marked-for-later--button')
    await sleep(1800)

    // Scroll well past the sidebar. A sticky element sits exactly where it was
    // laid out until you scroll, so measuring at the top would find nothing.
    await tab.evaluate(() => window.scrollTo(0, 2000))
    await sleep(300)

    const result = await tab.evaluate(() => {
      const root = document.querySelector('.AO3E--search-view')
      const main = document.querySelector('.AO3E--search-view--main')
      const pager = document.querySelector('.AO3E--search-view--pager')
      if (!root || !main || !pager)
        return null
      const p = pager.getBoundingClientRect()
      let overlaps = 0
      for (const li of document.querySelectorAll('.AO3E--search-view--results > li.blurb')) {
        if (li.style.display === 'none')
          continue
        const b = li.getBoundingClientRect()
        if (p.left < b.right && p.right > b.left && p.top < b.bottom && p.bottom > b.top)
          overlaps++
      }
      const side = document.querySelector('.AO3E--search-view--sidebar')
      const s = side.getBoundingClientRect()
      const m = main.getBoundingClientRect()
      const ow = Math.min(s.right, m.right) - Math.max(s.left, m.left)
      const oh = Math.min(s.bottom, m.bottom) - Math.max(s.top, m.top)
      return {
        rootW: Math.round(root.getBoundingClientRect().width),
        mainW: Math.round(m.width),
        pagerH: Math.round(p.height),
        pagerPosition: getComputedStyle(pager).position,
        pagerTop: Math.round(p.top),
        columns: getComputedStyle(document.querySelector('.AO3E--search-view--layout')).gridTemplateColumns,
        sidebarPosition: getComputedStyle(side).position,
        sidebarOverMain: ow > 1 && oh > 1 ? { w: Math.round(ow), h: Math.round(oh) } : null,
        overlaps,
      }
    })
    await tab.close()
    return result
  }

  test('a wide window keeps the sidebar beside the results', async () => {
    const r = await measure(1400, '')
    // Three tracks side by side: filters, the drag handle, results.
    assert.equal(r.columns.split(' ').length, 3, `expected side-by-side columns, got ${r.columns}`)
    assert.ok(r.mainW > 800, `results should have room, got ${r.mainW}`)
    assert.equal(r.overlaps, 0)
  })

  test('a narrow window collapses to one column', async () => {
    const r = await measure(700, '')
    assert.equal(r.columns.split(' ').length, 1, `expected one column, got ${r.columns}`)
    assert.equal(r.overlaps, 0)
  })

  test('a skin that pins #main narrow collapses too, however wide the window is', async () => {
    // The regression: this is a *container* that is narrow, not a viewport, so a
    // media query never fires. Left two-column, the results track was squeezed
    // to a sliver and the pager wrapped into a stack beside them.
    const r = await measure(1400, 'width: 26em; margin: 0 auto')
    assert.equal(r.columns.split(' ').length, 1, `expected one column, got ${r.columns}`)
    // Single column means the results get the whole container, not 13em less.
    assert.ok(r.mainW > r.rootW * 0.9, `results should fill the container, got ${r.mainW} of ${r.rootW}`)
    assert.equal(r.overlaps, 0, 'and nothing overlaps the pager')
  })

  test('the pager floats down beside the results as you scroll', async () => {
    // Same reasoning as the filter column: it sits next to the works, so the
    // page turns should still be to hand however far down the list you are.
    // `measure` has scrolled 2000px by this point, so a pager still near the top
    // of the viewport is one that travelled.
    const r = await measure(1400, '')
    assert.equal(r.pagerPosition, 'sticky', 'page turns should stay reachable')
    assert.ok(r.pagerTop >= 0 && r.pagerTop < 120, `pager should be pinned near the top, got ${r.pagerTop}px`)
    assert.equal(r.overlaps, 0, 'and never over the works it sits beside')
  })

  test('beside the results, the filters stay stuck as you scroll', async () => {
    const r = await measure(1400, '')
    assert.equal(r.sidebarPosition, 'sticky', 'filters should stay reachable')
    assert.equal(r.sidebarOverMain, null, 'and beside the results, never over them')
  })

  test('above the results, the filters scroll away instead of covering them', async () => {
    // The regression: sticky is right beside the results and wrong above them.
    // Left sticky in one column, the whole filter panel pinned itself over
    // whatever you had scrolled to, and the works read straight through it.
    for (const mainCss of ['width: 26em; margin: 0 auto', '']) {
      const r = await measure(mainCss ? 1400 : 700, mainCss)
      assert.equal(r.columns.split(' ').length, 1, `expected one column, got ${r.columns}`)
      assert.equal(r.sidebarPosition, 'static', 'not sticky when it is above the results')
      assert.equal(r.sidebarOverMain, null, `filters must not cover the works (${mainCss || 'narrow window'})`)
    }
  })
  test('dragging the handle widens the filter column', async () => {
    const tab = await openView(1400, '')
    const before = await sidebarWidth(tab)
    await dragBy(tab, 120)
    const after = await sidebarWidth(tab)
    await tab.close()
    assert.ok(after > before + 80, `expected a wider column, went ${before} -> ${after}`)
  })

  test('and dragging it back narrows it again', async () => {
    const tab = await openView(1400, '')
    await dragBy(tab, 150)
    const wide = await sidebarWidth(tab)
    await dragBy(tab, -100)
    const narrow = await sidebarWidth(tab)
    await tab.close()
    assert.ok(narrow < wide - 60, `expected a narrower column, went ${wide} -> ${narrow}`)
  })

  test('the width is persisted, and restored on the next open', async () => {
    const tab = await openView(1400, '')
    await dragBy(tab, 120)
    const shown = await sidebarWidth(tab)
    const stored = await storedWidth(tab)
    await tab.close()
    assert.ok(stored, 'a width was written to prefs')
    assert.equal(stored, shown, 'what was stored is what was shown')

    // Reopen with that pref seeded, the way a later visit would.
    const again = await openView(1400, '', {
      ...SEED,
      'cache.searchViewPrefs': { 'marked-for-later': { sidebarWidth: stored } },
    })
    const restored = await sidebarWidth(again)
    await again.close()
    assert.equal(restored, shown, 'the column came back the width it was left')
  })

  test('dragging cannot squeeze the results away', async () => {
    // Far past the right edge: the clamp has to keep the results at least as
    // wide as the filters, or a stray drag could hide the works entirely.
    const tab = await openView(1400, '')
    await dragBy(tab, 4000)
    const r = await tab.evaluate(() => ({
      side: Math.round(document.querySelector('.AO3E--search-view--sidebar').getBoundingClientRect().width),
      main: Math.round(document.querySelector('.AO3E--search-view--main').getBoundingClientRect().width),
    }))
    await tab.close()
    assert.ok(r.main >= r.side, `results must keep room, got ${r.main} vs ${r.side}`)
  })

  test('the arrow keys move the divider too', async () => {
    const tab = await openView(1400, '')
    const before = await sidebarWidth(tab)
    await tab.focus('.AO3E--search-view--resizer')
    for (let i = 0; i < 4; i++)
      await tab.keyboard.press('ArrowRight')
    await sleep(200)
    const after = await sidebarWidth(tab)
    await tab.close()
    assert.ok(after > before, `expected wider, went ${before} -> ${after}`)
  })

  test('there is no handle to drag while the columns are stacked', async () => {
    const tab = await openView(700, '')
    const shown = await tab.$eval('.AO3E--search-view--resizer', el =>
      getComputedStyle(el).display !== 'none')
    await tab.close()
    assert.equal(shown, false, 'stacked, there is no column edge to drag')
  })
})