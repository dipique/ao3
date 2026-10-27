import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { figures } from '../facts.mjs'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { rerun, settled, viewDrawn } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const TAG_URL = 'https://archiveofourown.org/tags/marriage%20problems'

const SEED = {
  'option.searchTagWorks': true,
  'option.filterToolbar': true,
  'option.hideCrossovers': { enabled: true, maxFandoms: 1 },
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'tag', value: 'HideMe', matcher: 'exact', behavior: 'collapse' },
      { target: 'tag', value: 'Gone', matcher: 'exact', behavior: 'hide' },
    ],
  },
}

const PAGES = 2
const PER_PAGE = 3

function blurb(id, title, tags, fandoms = ['A Fandom']) {
  const tagList = ['marriage problems', ...tags]
    .map(t => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a> by <a rel="author" href="/users/s/pseuds/s">s</a></h4>
        <h5 class="fandoms heading">${fandoms.map(fandom => `<a class="tag" href="/tags/${encodeURIComponent(fandom)}/works">${fandom}</a>`).join(', ')}</h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
      <dl class="stats">
        <dt class="language">Language:</dt><dd class="language">English</dd>
        <dt class="words">Words:</dt><dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd>
      </dl>
    </li>`
}

/**
 * Page 1 hides nothing at all; page 2 carries the work a rule collapses, the
 * crossover the crossover filter collapses, and the one a *hide* rule matches. So when the page
 * first loads there is nothing to peek at — the state in which the pill used to
 * be left off the toolbar for good.
 *
 * Page 2 holds a fourth work on purpose: the hide rule drops it from the view's
 * results altogether, which is what leaves exactly `PAGES * PER_PAGE` of them for
 * the reader to count. A collapsed work would have kept its slot.
 */
const WORKS = {
  1: [
    blurb(1, 'Plain one', []),
    blurb(2, 'Another plain one', []),
    blurb(3, 'A third plain one', []),
  ],
  2: [
    blurb(4, 'A rule-hidden one', ['HideMe']),
    blurb(5, 'A crossover', [], ['A Fandom', 'Another Fandom']),
    blurb(6, 'Yet another plain one', []),
    blurb(7, 'A rule-gone one', ['Gone']),
  ],
}

function pagination(current) {
  const items = Array.from({ length: PAGES }, (_, i) => i + 1)
    .map(n => (n === current ? `<li><span class="current">${n}</span></li>` : `<li><a href="?page=${n}">${n}</a></li>`))
    .join('')
  return `<ol role="navigation" class="pagination actions">${items}</ol>`
}

function tagPage(page) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>marriage problems</title></head>
<body>
  <div id="header"></div>
  <div id="main" class="tags-show region">
    <div class="tag home profile">
      <div class="primary header module"><h2 class="heading">marriage problems</h2></div>
      <p>This tag belongs to the Additional Tags Category.</p>
      <p>This tag has not been marked common and can&#39;t be filtered on (yet).</p>
      <div class="work listbox group">
        <h3 class="heading">Works which have used it as a tag:</h3>
        ${pagination(page)}
        <ul class="index group">${WORKS[page].join('')}</ul>
      </div>
    </div>
  </div>
</body></html>`
}

/**
 * The controls a *hidden* work carries, inside a custom search view. A collapsed
 * work's reason line offers to take the value that hid it out of the results,
 * and the floating toolbar offers to peek at everything the filters hid — both
 * of which used to be tied to AO3's own filter sidebar, or to a count taken
 * before the view existed.
 */
describe('hidden works in the search view', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await launch(chromePath)
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (!req.url().startsWith('https://archiveofourown.org/'))
        return void req.abort()
      const n = Number(new URL(req.url()).searchParams.get('page') ?? 1)
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: tagPage(Number.isFinite(n) && n >= 1 && n <= PAGES ? n : 1),
      })
    })
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(TAG_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await settled(page)
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
   * The peek pill, or null when it isn't being offered: whether it is peeking,
   * and the count it gives. Read a frame on: the pill follows the view on the
   * next one.
   */
  const peekPill = async () => {
    const pill = await page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      const toolbar = document.querySelector('.AO3E--filter-toolbar')
      if (!toolbar || toolbar.hidden)
        return null
      const button = toolbar.querySelector('[data-ao3e-action="peek"]')
      return button && !button.hidden ? { peeking: button.getAttribute('aria-pressed') === 'true', text: button.textContent } : null
    })
    return pill && { peeking: pill.peeking, count: figures(pill.text) }
  }

  /** The exclude button on the collapsed work whose reason line names `value`. */
  const clickExclude = value => page.evaluate((want) => {
    for (const item of document.querySelectorAll('.AO3E--search-view--results .AO3E--hide-works--reason-value')) {
      if (item.textContent.trim() !== want)
        continue
      const button = item.nextElementSibling
      if (!button?.classList.contains('AO3E--hide-works--exclude'))
        return false
      button.click()
      return true
    }
    return false
  }, value)

  test('page one hides nothing, so no peek pill is offered yet', async () => {
    assert.equal(await peekPill(), null)
  })

  test('the pill appears once the view pulls in the pages that do', async () => {
    await page.click('.AO3E--search-tag-works--link')
    await viewDrawn(page)
    // Both hidden works are in the view now: the rule-hidden one and the
    // crossover.
    assert.deepEqual(await peekPill(), { peeking: false, count: [2] })
  })

  test('the native listing behind the view is not counted twice', async () => {
    const marked = await page.evaluate(() => ({
      everywhere: document.querySelectorAll('li[data-ao3e-hidden-by]').length,
      inView: document.querySelectorAll('.AO3E--search-view--results li[data-ao3e-hidden-by]').length,
    }))
    assert.equal(marked.inView, 2)
    // The native page's own blurbs are still in the DOM behind the view; the
    // count must ignore them (here they happen to add none, but the reader is
    // looking at the view either way).
    assert.ok(marked.everywhere >= marked.inView)
  })

  test('a work a hide rule matched never reaches the results at all', async () => {
    const state = await page.evaluate(() => {
      const lis = [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      return {
        mounted: lis.length,
        count: document.querySelector('.AO3E--search-view--count')?.textContent ?? '',
        marked: lis.filter(li => li.dataset.ao3eHiddenBy).map(li => li.querySelector('h4.heading a').textContent),
      }
    })
    // The view holds it — it was scraped like any other — but it is not a result:
    // it costs no slot, is not in the count, is never mounted, and so carries no
    // hidden marker for the peek pill to find. A collapsed work is the opposite
    // on all four.
    assert.equal(state.mounted, PAGES * PER_PAGE)
    assert.equal((await visibleTitles()).length, PAGES * PER_PAGE)
    assert.ok(!(await visibleTitles()).includes('A rule-gone one'))
    assert.ok(figures(state.count).includes(PAGES * PER_PAGE), `the count is of the results: ${state.count}`)
    assert.deepEqual(state.marked.sort(), ['A crossover', 'A rule-hidden one'])
  })

  test('peeking reveals the collapsed works and can be turned back off', async () => {
    const shown = () => page.evaluate(() => {
      const wrapper = document.querySelector('.AO3E--search-view--results .AO3E--hide-works--wrapper')
      return getComputedStyle(wrapper).display
    })
    assert.equal(await shown(), 'none')
    await page.evaluate(() => document.querySelector('.AO3E--filter-toolbar [data-ao3e-action="peek"]').click())
    assert.equal(await shown(), 'block')
    assert.deepEqual(await peekPill(), { peeking: true, count: [2] })
    await page.evaluate(() => document.querySelector('.AO3E--filter-toolbar [data-ao3e-action="peek"]').click())
    assert.equal(await shown(), 'none')
  })

  test('and a reopened view collapses each work once, not twice', async () => {
    await page.evaluate(() => {
      document.querySelector('.AO3E--search-view--results').dataset.stale = ''
    })
    // Any options change re-runs the units, which puts the view back from the
    // works it was already showing. HideWorks is the one decoration that
    // *rewrites* a blurb rather than adding to it, so a copy handed back without
    // being stripped first shows as a reason line inside a reason line.
    await rerun(page, () => page.evaluate(() => browser.storage.local.set({ 'option.showKudosHitsRatio': true })))
    await viewDrawn(page)
    assert.ok(
      await page.evaluate(() => document.querySelector('.AO3E--search-view--results')?.dataset.stale === undefined),
      'the view should have reopened',
    )
    const collapsed = await page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
        .filter(li => li.querySelector('.AO3E--hide-works--msg'))
        .map(li => ({
          title: li.querySelector('h4.heading a').textContent,
          reasons: li.querySelectorAll('.AO3E--hide-works--msg').length,
          wrappers: li.querySelectorAll('.AO3E--hide-works--wrapper').length,
        })))
    assert.deepEqual(collapsed, [
      { title: 'A rule-hidden one', reasons: 1, wrappers: 1 },
      { title: 'A crossover', reasons: 1, wrappers: 1 },
    ])
    assert.equal((await visibleTitles()).length, PAGES * PER_PAGE)
  })

  test('a rule-hidden work offers to exclude the tag that hid it', async () => {
    assert.deepEqual((await visibleTitles()).length, PAGES * PER_PAGE)
    assert.ok(await clickExclude('HideMe'), 'the reason line should carry an exclude button')
    const titles = await visibleTitles()
    assert.ok(!titles.includes('A rule-hidden one'), 'the collapsed work should leave the results')
    assert.equal(titles.length, PAGES * PER_PAGE - 1)
  })

  test('and the pill drops to what is still hidden', async () => {
    assert.deepEqual(await peekPill(), { peeking: false, count: [1] })
  })

  test('a crossover offers no exclude, its fandom count being no value to filter by', async () => {
    const crossover = await page.evaluateHandle(() => [...document.querySelectorAll('.AO3E--search-view--results > li.blurb')]
      .find(li => li.querySelector('h4.heading a').textContent === 'A crossover'))
    assert.ok(await crossover.evaluate(li => !!li.querySelector('.AO3E--hide-works--msg')), 'it is collapsed')
    assert.equal(await crossover.evaluate(li => li.querySelector('.AO3E--hide-works--exclude')), null)
    const titles = await visibleTitles()
    assert.ok(titles.includes('A crossover'))
    assert.equal(titles.length, PAGES * PER_PAGE - 1)
    assert.deepEqual(await peekPill(), { peeking: false, count: [1] })
  })
})
