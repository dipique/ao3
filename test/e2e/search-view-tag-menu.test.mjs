import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const READINGS_URL = 'https://archiveofourown.org/users/me/readings?show=to-read'

const SEED = {
  'option.searchMarkedForLater': true,
  'option.tagToolbar': true,
  'option.fandomToolbar': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [{ target: 'tag', value: 'HideMe', matcher: 'exact', behavior: 'hide' }],
  },
}

function blurb(id, title, fandom, tags) {
  const tagList = tags
    .map(t => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
        <h5 class="fandoms heading"><a class="tag" href="/tags/${encodeURIComponent(fandom)}/works">${fandom}</a></h5>
        <ul class="required-tags"><li><a class="help symbol question modal" href="/help/symbols-key.html"><span class="rating rating-general-audiences" title="General Audiences"><span class="text">General Audiences</span></span></a></li></ul>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats">
        <dt class="words">Words:</dt><dd class="words">7,150</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

/** A "Marked for Later" page — a listing AO3 gives no sort-and-filter sidebar. */
const READINGS_HTML = `<!doctype html>
<html><head><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main">
    <ul class="navigation actions"><li><span class="current">Marked for Later</span></li></ul>
    <ol class="reading work index group">
      ${blurb(1, 'Fluffy one', 'A Fandom', ['Fluff'])}
      ${blurb(2, 'Angsty one', 'A Fandom', ['Angst'])}
      ${blurb(3, 'Both at once', 'Other Fandom', ['Fluff', 'Angst'])}
      ${blurb(4, 'A hidden one', 'Other Fandom', ['HideMe'])}
    </ol>
  </div>
</body></html>`

/**
 * The tag / fandom context menus inside a custom search page. These listings have
 * no filter sidebar for AO3's own include/exclude to act on, so the menus'
 * "Include / Exclude / Require in filter" rows drive the view's in-memory facets
 * instead — the parity the search view used to be missing.
 */
describe('tag and fandom menus in the search view', { skip }, () => {
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
    // Every archiveofourown.org request is served from the fixture: the page
    // itself and the page-1 fetch the view's scrape makes.
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: READINGS_HTML })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(READINGS_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1200)

    await page.click('.AO3E--search-marked-for-later--button')
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Titles of the works currently showing in the view. */
  const visibleTitles = () => page.evaluate(() =>
    [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .filter(li => li.style.display !== 'none' && !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('h4.heading a').textContent))

  /**
   * Right-click the first link in the view matching `selector` whose text is
   * `text`, and return the menu's row labels. A synthetic `contextmenu` is what
   * a real right-click delivers to the delegated listener.
   */
  const openMenuOn = async (selector, text) => {
    await page.evaluate(([sel, want]) => {
      const link = [...document.querySelectorAll(`.AO3E--search-view--results ${sel}`)]
        .find(a => a.textContent.trim() === want)
      if (!link)
        throw new Error(`no ${sel} reading "${want}"`)
      link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
    }, [selector, text])
    await sleep(250)
    return page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .map(el => el.querySelector('.AO3E--menu--label').textContent))
  }

  /** Click the open menu's row starting with `prefix`. */
  const pick = async (prefix) => {
    await page.evaluate((p) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => el.textContent.startsWith(p))
      if (!row)
        throw new Error(`no menu row starting "${p}"`)
      row.click()
    }, prefix)
    // Long enough for the re-render and for the REOPEN_GUARD to lapse.
    await sleep(400)
  }

  /** The indicator suffixes shown next to a tag/fandom link with this text. */
  const indicatorsOn = (selector, text) => page.evaluate(([sel, want]) => {
    const link = [...document.querySelectorAll(`.AO3E--search-view--results ${sel}`)]
      .find(a => a.textContent.trim() === want)
    const span = link?.nextElementSibling
    if (!span?.classList.contains('AO3E--indicators'))
      return []
    return [...span.querySelectorAll('.AO3E--indicator')]
      .flatMap(el => [...el.classList])
      .filter(c => c.startsWith('AO3E--indicator--') && c !== 'AO3E--indicator--mark')
      .map(c => c.replace('AO3E--indicator--', ''))
  }, [selector, text])

  test('the view opened with every work', async () => {
    assert.deepEqual(
      (await visibleTitles()).sort(),
      ['A hidden one', 'Angsty one', 'Both at once', 'Fluffy one'],
    )
  })

  test('a tag menu offers include, exclude and require', async () => {
    const labels = await openMenuOn('ul.tags a.tag', 'Fluff')
    assert.ok(labels.includes('Include in filter'), labels.join(' | '))
    assert.ok(labels.includes('Exclude from filter'), labels.join(' | '))
    // "Require" is the view's own third direction; AO3's sidebar has no such filter.
    assert.ok(labels.includes('Require in filter'), labels.join(' | '))
  })

  test('excluding a tag filters the view, not AO3', async () => {
    await pick('Exclude from filter')
    assert.deepEqual((await visibleTitles()).sort(), ['A hidden one', 'Angsty one'])
    assert.equal(page.url(), READINGS_URL, 'nothing should have been submitted')
  })

  test('the excluded tag shows its indicator, and the facet row agrees', async () => {
    assert.deepEqual(await indicatorsOn('ul.tags a.tag', 'Fluff'), ['exclude'])
    const rowActive = await page.evaluate(() =>
      !!document.querySelector('.AO3E--search-view--toggle-exclude.AO3E--search-view--active'))
    assert.ok(rowActive, 'the sidebar facet row should show the same exclusion')
  })

  test('choosing it again clears the exclusion', async () => {
    await openMenuOn('ul.tags a.tag', 'Fluff')
    await pick('Exclude from filter')
    assert.deepEqual((await visibleTitles()).length, 4)
    assert.deepEqual(await indicatorsOn('ul.tags a.tag', 'Fluff'), [])
  })

  test('requiring a tag keeps only the works that carry it', async () => {
    await openMenuOn('ul.tags a.tag', 'Fluff')
    await pick('Require in filter')
    assert.deepEqual((await visibleTitles()).sort(), ['Both at once', 'Fluffy one'])
    assert.deepEqual(await indicatorsOn('ul.tags a.tag', 'Fluff'), ['require'])
    await openMenuOn('ul.tags a.tag', 'Fluff')
    await pick('Require in filter')
    assert.equal((await visibleTitles()).length, 4)
  })

  test('a fandom menu drives the view too — by name, with no id to resolve', async () => {
    const labels = await openMenuOn('h5.fandoms a.tag', 'Other Fandom')
    assert.ok(labels.includes('Exclude from filter'), labels.join(' | '))
    await pick('Exclude from filter')
    assert.deepEqual((await visibleTitles()).sort(), ['Angsty one', 'Fluffy one'])
    assert.deepEqual(await indicatorsOn('h5.fandoms a.tag', 'Other Fandom'), ['exclude'])
    await openMenuOn('h5.fandoms a.tag', 'Other Fandom')
    await pick('Exclude from filter')
    assert.equal((await visibleTitles()).length, 4)
  })

  test('the rating symbol offers the same three rows', async () => {
    const labels = await openMenuOn('ul.required-tags li a', 'General Audiences')
    assert.ok(labels.includes('Include in filter'), labels.join(' | '))
    assert.ok(labels.includes('Exclude from filter'), labels.join(' | '))
    assert.ok(labels.includes('Require in filter'), labels.join(' | '))
    await page.keyboard.press('Escape')
    await sleep(300)
  })

  test('a hidden work\'s reason line carries a working exclude button', async () => {
    const excluded = await page.evaluate(() => {
      const button = document.querySelector('.AO3E--search-view--results .AO3E--hide-works--exclude')
      if (!button)
        return null
      button.click()
      return true
    })
    assert.ok(excluded, 'the collapsed work should offer an inline exclude button')
    await sleep(400)
    // Excluding "HideMe" takes the work out of the view entirely, rather than
    // leaving it collapsed in place.
    assert.deepEqual((await visibleTitles()).sort(), ['Angsty one', 'Both at once', 'Fluffy one'])
  })
})
