import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { unpackIds } from '../../src/common/workMarks.ts'
import { COMMENTS_CLASS } from '../../src/content_script/siteExport/workText.ts'
import { comment, pagination } from '../siteExport/workPages.mjs'
import { storedLists } from './helpers.mjs'
import { captureDownloads, skip, startOptions, until } from './optionsPage.mjs'
import { openMenu } from './trackedPages.mjs'

/**
 * Reading a long work in an exported file: the comments the caching saved with
 * it, the way to a chapter, and the floating controls a work page gets there.
 *
 * Driven from the start, so the setting is what decides: Save comments with
 * cached works is on, the reader downloads their Marked for Later's offline copy,
 * the job fetches every page of a work's comments from a stand-in AO3, and the
 * file it writes is opened from disk.
 */

const ARCHIVE = 'https://archiveofourown.org'
const CACHE_KEY = 'marked-for-later:tester'
const TILE = 'marked-for-later'
/** Three chapters and two pages of comments. */
const LONG = '31'
/** One chapter and no comments. */
const SHORT = '32'
const CHAPTERS = ['Chapter 1: The Start', 'Chapter 2: The Middle', 'Chapter 3: The End']

function blurb(id, chapters) {
  return `<li class="work blurb group" id="work_${id}" role="article">
    <!--updated_at=1770000000-->
    <div class="header module">
      <h4 class="heading"><a href="/works/${id}">Work number ${id}</a>
        by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
      <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
    </div>
    <dl class="stats">
      <dt class="words">Words:</dt><dd class="words">5,000</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">${chapters}</dd>
    </dl>
  </li>`
}

const LISTING = `<!doctype html>
<html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="main" class="reading-index region">
    <ul class="navigation actions"></ul>
    <ol class="reading work index group">${blurb(LONG, '3/3')}${blurb(SHORT, '1/1')}</ol>
  </div>
</body></html>`

/** Enough text that a chapter can be scrolled to the top of the window. */
const FILLER = '<p>And so it went on, at some length, as long works do.</p>'.repeat(60)

/** A work page as `view_full_work=true` returns it, with `comments` (markup) under it when asked for. */
function workPage(id, { chapters, comments = '' }) {
  const text = chapters.length === 1
    ? `<div class="userstuff"><p>The only chapter.</p>${FILLER}</div>`
    : chapters.map((heading, i) => {
        const [label, title] = heading.split(': ')
        const skip = i === 0 ? '<p><a href="#chapter-3">Skip to the end</a></p>' : ''
        return `<div class="chapter" id="chapter-${i + 1}">
          <div class="chapter preface group"><h3 class="title"><a href="/works/${id}/chapters/${100 + i}">${label}</a>: ${title}</h3></div>
          <div class="userstuff module"><p>Chapter ${i + 1} text.</p>${skip}${FILLER}</div>
        </div>`
      }).join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Work ${id}</title></head>
<body class="logged-in">
  <div id="main" class="works-show region">
    <dl class="work meta group">
      <dt class="rating tags">Rating:</dt><dd class="rating tags"><ul class="commas"><li><a class="tag" href="/tags/General%20Audiences">General Audiences</a></li></ul></dd>
      <dt class="stats">Stats:</dt><dd class="stats"><dl class="stats"><dt class="words">Words:</dt><dd class="words">5,000</dd><dt class="chapters">Chapters:</dt><dd class="chapters">${chapters.length}/${chapters.length}</dd>${comments ? `<dt class="comments">Comments:</dt><dd class="comments"><a href="/works/${id}?show_comments=true#comments">3</a></dd>` : ''}</dl></dd>
    </dl>
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">Work number ${id}</h2></div>
      <div id="chapters">${text}</div>
    </div>
    <div id="feedback" class="feedback">${comments}</div>
  </div>
</body></html>`
}

/** Page `n` of the long work's two pages of comments. */
function commentsPage(n) {
  const threads = n === 1
    ? `${comment(1, 'First on page one.')}<li><ol class="thread">${comment(2, 'A reply on page one.')}</ol></li>`
    : comment(3, 'Only on page two.')
  return `<div id="comments_placeholder">${pagination(n, 2)}<ol class="thread">${threads}</ol></div>`
}

const SEED = {
  ...storedLists({
    [CACHE_KEY]: {
      version: 2,
      scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
      blurbsHtml: [blurb(LONG, '3/3'), blurb(SHORT, '1/1')],
      descriptor: {
        sourceId: 'marked-for-later',
        label: 'Marked for Later — tester',
        listUrl: `${ARCHIVE}/users/tester/readings?show=to-read`,
      },
    },
  }),
  'option.cacheComments': true,
  'option.readerMode': true,
  'option.markGrid': true,
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
      good: { icon: 'mdi/thumb-up', label: 'Good', color: '#2f8f4e', triggerAlias: 'read', items: '' },
      hot: { icon: 'mdi/chili-hot', label: 'Hot', color: '#d0342c', triggerAlias: 'read', items: '' },
    },
  },
}

describe('site export — reading a long work', { skip }, () => {
  let session
  let options
  let page
  /** Every work page the stand-in was asked for. */
  const asked = []
  let dir

  const stubArchive = async (tab) => {
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      const url = new URL(req.url())
      if (url.origin !== ARCHIVE)
        return void req.continue()
      const id = /^\/works\/(\d+)$/.exec(url.pathname)?.[1]
      if (id)
        asked.push(url.search)
      const withComments = url.searchParams.get('show_comments') === 'true'
      const body = id === LONG
        ? workPage(id, { chapters: CHAPTERS, comments: withComments ? commentsPage(Number(url.searchParams.get('page') ?? 1)) : '' })
        : id === SHORT
          ? workPage(id, { chapters: ['Chapter 1'] })
          : LISTING
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body })
    })
  }

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: SEED,
      hash: '#saved-lists',
      prepare: async (tab) => {
        await stubArchive(tab)
        await tab.evaluateOnNewDocument(captureDownloads)
      },
    })
    page = options.page
    await options.press(await options.action(await options.tile(TILE), 'download'))
    await until('the download to be handed over', () => page.evaluate(() => window.__downloads.length > 0), 60000)
    const record = await page.evaluate(() => window.__downloads.at(-1))
    const html = Buffer.from(await page.evaluate(url => window.__downloadBytes(url), record.url), 'base64').toString('utf-8')
    dir = mkdtempSync(join(tmpdir(), 'ao3e-reader-'))
    writeFileSync(join(dir, 'library.html'), html)
  }, { timeout: 240000 })

  after(async () => {
    await session?.close()
    if (dir)
      rmSync(dir, { recursive: true, force: true })
  })

  test('the caching asked for every page of the comments, and the copy says it holds them', async () => {
    const pages = asked.filter(search => search.includes('show_comments=true'))
    assert.ok(pages.some(search => !search.includes('page=')), 'the first page comes with the work')
    assert.ok(pages.some(search => search.includes('page=2')), 'the second is asked for after it')
    assert.ok(!pages.some(search => search.includes('page=3')), 'and no page AO3 did not list')
    const index = await options.lastWrite('workTextIndex')
    assert.equal(index[LONG].comments, true)
    assert.equal(index[SHORT].comments, true, 'a work with no comments has every one of them')
  })

  /** A tab on the file, opened at `hash`, with nothing kept from an earlier one. */
  async function openReader(hash) {
    const reader = await session.browser.newPage()
    const errors = []
    reader.on('pageerror', e => errors.push(e.message))
    await reader.setViewport({ width: 1280, height: 800 })
    const url = `file://${join(dir, 'library.html').replace(/\\/g, '/')}`
    await reader.goto(url, { waitUntil: 'load' })
    await reader.evaluate(() => new Promise((resolve) => {
      const del = indexedDB.deleteDatabase('ao3e-site')
      del.onsuccess = del.onerror = del.onblocked = () => resolve()
    }))
    await reader.goto(`${url}${hash}`, { waitUntil: 'load' })
    await reader.reload({ waitUntil: 'load' })
    await reader.waitForFunction(() => document.querySelector('.AO3E--site--work .userstuff') !== null, { timeout: 15000 })
    return { reader, errors }
  }

  /** Where `selector` sits against the top of the window, and whether the window moved to get it there. */
  const placeOf = (reader, selector) => reader.$eval(selector, el => ({ top: el.getBoundingClientRect().top, scrolled: window.scrollY, height: window.innerHeight }))

  const action = name => `[data-ao3e-action="${name}"]`

  test('a long work: chapters to jump to, comments to read, and the controls in the corner', async () => {
    const { reader, errors } = await openReader(`#work/${LONG}`)
    try {
      assert.equal(await reader.$eval('.AO3E--site--status', el => el.hidden), true, 'the export panel stays with the list')

      // The comments from both pages, in order, under the work.
      const comments = await reader.$eval(`.${COMMENTS_CLASS}`, el => el.textContent)
      const at = text => comments.indexOf(text)
      assert.ok(at('First on page one.') >= 0 && at('First on page one.') < at('A reply on page one.') && at('A reply on page one.') < at('Only on page two.'))

      // Jump to chapter lists every chapter by its heading, and goes to the one picked.
      assert.equal(await reader.$eval('.AO3E--site--chapters', el => el.open), false)
      await reader.click(action('jump-chapter'))
      assert.equal(await reader.$eval('.AO3E--site--chapters', el => el.open), true)
      assert.deepEqual(await reader.$$eval('[data-ao3e-chapter]', els => els.map(el => el.textContent)), CHAPTERS)
      await reader.click('[data-ao3e-chapter="1"]')
      const second = await placeOf(reader, '#chapter-2')
      assert.ok(Math.abs(second.top) < 2 && second.scrolled > 0, `chapter 2 should be at the top of the window (${JSON.stringify(second)})`)
      assert.equal(await reader.$eval('.AO3E--site--chapters', el => el.open), false, 'the list closes once a chapter is picked')
      assert.equal(await reader.evaluate(() => location.hash), `#work/${LONG}`, 'and the work stays open')

      // The work's own link to a place in it goes there rather than to the list.
      await reader.evaluate(() => window.scrollTo(0, 0))
      await reader.$eval('a[href="#chapter-3"]', el => el.click())
      assert.equal(await reader.evaluate(() => location.hash), `#work/${LONG}`)
      assert.ok(Math.abs((await placeOf(reader, '#chapter-3')).top) < 2, 'the link should land on chapter 3')

      // The comment count leads to the comments.
      await reader.evaluate(() => window.scrollTo(0, 0))
      await reader.click(`dd.comments ${action('jump-comments')}`)
      const section = await placeOf(reader, `.${COMMENTS_CLASS}`)
      assert.ok(section.scrolled > 0 && section.top >= -1 && section.top < section.height, `the comments should be on screen (${JSON.stringify(section)})`)

      // The floating controls: back to the top, down to the comments, the menu of marks.
      await reader.click('.AO3E--filter-toolbar--fab')
      const pills = await reader.$$eval('.AO3E--filter-toolbar--panel button', els => els.map(el => el.dataset.ao3eAction))
      assert.deepEqual(pills, ['jump-top', 'jump-comments', 'update-marks'])
      await reader.$eval(`.AO3E--filter-toolbar ${action('jump-top')}`, el => el.click())
      assert.equal(await reader.evaluate(() => window.scrollY), 0)
      await reader.$eval(`.AO3E--filter-toolbar ${action('jump-comments')}`, el => el.click())
      assert.ok((await placeOf(reader, `.${COMMENTS_CLASS}`)).scrolled > 0)

      await reader.waitForSelector('#workskin > .preface h2.title.heading.AO3E--menu-trigger', { timeout: 5000 })
      await openMenu(reader, () => reader.$eval(`.AO3E--filter-toolbar ${action('update-marks')}`, el => el.click()))
      assert.ok(await reader.$('.AO3E--menu [role="menuitem"]'), 'the pill opens the title\'s menu')
      assert.deepEqual(errors, [])
    }
    finally {
      await reader.close()
    }
  })

  test('a one-chapter work with no comments offers neither', async () => {
    const { reader, errors } = await openReader(`#work/${SHORT}`)
    try {
      assert.equal(await reader.$(action('jump-chapter')), null)
      assert.equal(await reader.$(`.${COMMENTS_CLASS}`), null)
      const pills = await reader.$$eval('.AO3E--filter-toolbar--panel button', els => els.map(el => el.dataset.ao3eAction))
      assert.deepEqual(pills, ['jump-top', 'update-marks'])

      // Back on the list, the export panel is back, and the controls are gone with the work.
      await reader.click('.AO3E--site--nav a')
      await reader.waitForFunction(() => !document.querySelector('.AO3E--site--list').hidden)
      assert.equal(await reader.$eval('.AO3E--site--status', el => el.hidden), false)
      assert.equal(await reader.$('.AO3E--filter-toolbar'), null)
      assert.deepEqual(errors, [])
    }
    finally {
      await reader.close()
    }
  })

  test('the rating grid marks a work in the copy, several marks from one opening', async () => {
    const { reader, errors } = await openReader(`#work/${SHORT}`)
    const grid = '[data-ao3e-mark-grid]'
    const selected = () => reader.$$eval(`${grid} [data-ao3e-row="selected"] [data-ao3e-value]`, els => els.map(el => el.dataset.ao3eValue))
    const carries = async markId => unpackIds(await reader.evaluate(async (id) => {
      const { 'option.workMarks': table } = await window.browser.storage.local.get('option.workMarks')
      return table?.marks?.[id]?.items ?? ''
    }, markId)).has(SHORT)
    try {
      await reader.waitForSelector('#workskin > .preface h2.title.heading.AO3E--menu-trigger', { timeout: 5000 })
      await reader.keyboard.press('r')
      await reader.waitForSelector(grid)
      await reader.click(`${grid} [data-ao3e-value="good"]`)
      await until('Good to be kept', () => carries('good'))
      await reader.click(`${grid} [data-ao3e-value="hot"]`)
      await until('Hot to be kept', () => carries('hot'))
      assert.ok(await reader.$(grid), 'the grid stays open')
      assert.deepEqual(await selected(), ['good', 'hot'])

      // Back on the list there is no work to rate.
      await reader.keyboard.press('Escape')
      await reader.click('.AO3E--site--nav a')
      await reader.waitForFunction(() => !document.querySelector('.AO3E--site--list').hidden)
      await reader.keyboard.press('r')
      assert.equal(await reader.$(grid), null)
      assert.deepEqual(errors, [])
    }
    finally {
      await reader.close()
    }
  })
})
