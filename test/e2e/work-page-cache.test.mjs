import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { COMMENT_LOAD_RETRY_MS } from '../../src/common/constants.ts'
import { ensureBuilt, findChrome, sleep, storedLists, until } from './helpers.mjs'
import { ARCHIVE, inject, launch, openTab, visit } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_ID = '4815162'
const SID = Number(WORK_ID).toString(36)
const WORK_URL = `${ARCHIVE}/works/${WORK_ID}`
const FULL_URL = `${WORK_URL}?view_full_work=true`
const TAG_LIST = `${ARCHIVE}/tags/Bees/works`

/** AO3's `button_to` mark form, as it renders it. */
function markForm(action, label) {
  return `<form class="button_to" method="post" action="/works/${WORK_ID}/${action}"><input type="hidden" name="_method" value="patch"><button type="submit">${label}</button></form>`
}

function comment(n) {
  return `<li class="comment group odd" role="article" id="comment_${n}">
    <h4 class="heading byline"><a href="/users/fan${n}/pseuds/fan${n}">fan${n}</a></h4>
    <blockquote class="userstuff"><p>Comment number ${n}.</p></blockquote>
    <ul class="actions"><li><a href="/comments/${n}/reply">Reply</a></li></ul>
  </li>`
}

/**
 * A work page in AO3's shape, signed in as `me`: on Marked for Later or not,
 * with `chapters` of `written` on the page (one chapter is shown without a
 * chapter wrapper, as AO3 shows a one-chapter work), and `comments` the stats
 * count. `shownComments` are on the page as it loads.
 */
function workPage({ saved = false, written = 1, shown = written, comments = 0, shownComments = 0 } = {}) {
  const chapter = n => `<div class="chapter" id="chapter-${n}"><h3 class="title">Chapter ${n}</h3><div class="userstuff module"><p>Chapter ${n} buzzes.</p></div></div>`
  const body = written === 1
    ? '<div class="userstuff"><p>The only chapter buzzes.</p></div>'
    : Array.from({ length: shown }, (_, i) => chapter(i + 1)).join('')
  const thread = shownComments ? `<ol class="thread">${Array.from({ length: shownComments }, (_, i) => comment(i + 1)).join('')}</ol>` : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"><a href="/users/me/preferences">Preferences</a></li></ul></div>
  <div id="main" class="works-show">
    <ul class="work navigation actions">
      <li class="mark">${saved ? markForm('mark_as_read', 'Mark as Read') : markForm('mark_for_later', 'Mark for Later')}</li>
    </ul>
    <div class="wrapper">
      <dl class="work meta group">
        <dt class="rating tags">Rating:</dt>
        <dd class="rating tags"><ul class="commas"><li><a class="tag" href="/tags/Teen%20And%20Up%20Audiences/works">Teen And Up Audiences</a></li></ul></dd>
        <dt class="fandom tags">Fandom:</dt>
        <dd class="fandom tags"><ul class="commas"><li><a class="tag" href="/tags/Bees/works">Bees</a></li></ul></dd>
        <dt class="language">Language:</dt><dd class="language">English</dd>
        <dt class="stats">Stats:</dt>
        <dd class="stats"><dl class="stats">
          <dt class="published">Published:</dt><dd class="published">2026-02-12</dd>
          <dt class="words">Words:</dt><dd class="words">4,200</dd>
          <dt class="chapters">Chapters:</dt><dd class="chapters">${written}/${written}</dd>
          ${comments ? `<dt class="comments">Comments:</dt><dd class="comments">${comments}</dd>` : ''}
        </dl></dd>
      </dl>
    </div>
    <div id="workskin">
      <div class="preface group">
        <h2 class="title heading">The visited work</h2>
        <h3 class="byline heading"><a rel="author" href="/users/writer/pseuds/writer">writer</a></h3>
        <div class="summary module"><h3 class="heading">Summary:</h3><blockquote class="userstuff"><p>Buzzing.</p></blockquote></div>
      </div>
      <div id="chapters" role="article">${body}</div>
    </div>
    <div id="feedback" class="feedback">
      <h3 class="landmark heading"><a id="comments">Comments</a></h3>
      <div id="comments_placeholder">${thread}</div>
    </div>
  </div>
</body></html>`
}

/** A listing blurb for a stored list, saying less than the work page does. */
function listingBlurb(id) {
  return `<li class="work blurb group" id="work_${id}" role="article">
    <div class="header module"><!-- updated_at=1770858000 --><h4 class="heading"><a href="/works/${id}">Stored work ${id}</a>
      by <a rel="author" href="/users/writer/pseuds/writer">writer</a></h4></div>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

/** A tracked list of the Bees tag, its copy holding `ids`. */
function trackedBees(ids) {
  return {
    'option.trackedLists': {
      enabled: true,
      target: 40,
      reviewedThrough: 0,
      lists: [{ id: 'b33s', kind: 'tag-works', url: '/tags/Bees/works', alias: 'Bees', tracked: true, since: 20_000 }],
    },
    ...storedLists({
      'tag-works:Bees': { scrapedAt: Date.now(), blurbsHtml: ids.map(listingBlurb), descriptor: { sourceId: 'tag-works', label: 'Bees', listUrl: TAG_LIST } },
    }),
  }
}

/**
 * A visit to a work's own page keeps its text when the reader asked for that
 * work's group, and the page holds the whole work (with its comments, when
 * those are saved too); and keeps its stored blurb up to date.
 */
describe('work text and blurbs kept from the work page', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /**
   * Open `url` on a tab answering every archive request with `page`, the
   * wait for a work page's comments cut to a second.
   */
  const open = async (url, { page, seed = {} }) => {
    const tab = await openTab(browser, {
      seed,
      route: () => page,
      hurry: { [COMMENT_LOAD_RETRY_MS]: 1000 },
    })
    await visit(tab, url)
    return tab
  }

  const read = (tab, key) => tab.evaluate(async k => (await browser.storage.local.get(k))[k] ?? null, key)
  const cached = tab => read(tab, `workText.${WORK_ID}`)
  const indexEntry = async tab => (await read(tab, 'workTextIndex'))?.[WORK_ID] ?? null

  test('a work on Marked for Later is cached from its page, as the author wrote it', async () => {
    const tab = await open(WORK_URL, {
      page: workPage({ saved: true }),
      seed: {
        'option.opportunisticCache': 'markedForLater',
        'option.textReplacements': { enabled: true, rules: [{ find: 'buzzes', replace: 'hums', caseSensitive: false, matchCasing: false, wholeWord: false }] },
      },
    })
    try {
      await until('the work text is cached', async () => !!await cached(tab))
      assert.match(await tab.$eval('#chapters', el => el.textContent), /hums/)
      const { html } = await cached(tab)
      assert.match(html, /The only chapter buzzes/)
      assert.doesNotMatch(html, /hums|AO3E|Mark as Read/)
      const meta = await indexEntry(tab)
      assert.deepEqual({ chapters: meta.chapters, words: meta.words, updatedAt: meta.updatedAt }, { chapters: 1, words: 4200, updatedAt: Date.UTC(2026, 1, 12) / 1000 })
    }
    finally {
      await tab.close()
    }
  })

  test('a work outside the chosen group is left alone', async () => {
    const tab = await open(WORK_URL, { page: workPage({ saved: false }), seed: { 'option.opportunisticCache': 'markedForLater' } })
    try {
      await sleep(500)
      assert.equal(await cached(tab), null)
    }
    finally {
      await tab.close()
    }
  })

  test('a work in a tracked list\'s copy is cached from its page as its entire work, and not one chapter of it', async () => {
    const seed = { 'option.opportunisticCache': 'tracked', ...trackedBees(['1', WORK_ID]) }
    const chapterTab = await open(WORK_URL, { page: workPage({ written: 3, shown: 1 }), seed })
    try {
      await sleep(500)
      assert.equal(await cached(chapterTab), null)
    }
    finally {
      await chapterTab.close()
    }

    const tab = await open(FULL_URL, { page: workPage({ written: 3 }), seed })
    try {
      await until('the work text is cached', async () => !!await cached(tab))
      assert.match((await cached(tab)).html, /Chapter 1 buzzes[\s\S]*Chapter 3 buzzes/)
      // The stored blurb was of the same day, and lends the copy its time.
      assert.equal((await indexEntry(tab)).updatedAt, 1770858000)
    }
    finally {
      await tab.close()
    }
  })

  test('with comments saved, comments asked for are waited for, and cached with the work', async () => {
    let tab
    const page = workPage({ saved: true, comments: 2 })
    try {
      tab = await open(`${WORK_URL}#comments`, { page, seed: { 'option.opportunisticCache': 'markedForLater', 'option.cacheComments': true } })
      assert.equal(await cached(tab), null, 'not without its comments')
      await tab.evaluate((html) => {
        document.querySelector('#comments_placeholder').innerHTML = html
      }, `<ol class="thread">${comment(1)}${comment(2)}</ol>`)
      await until('the work text is cached', async () => !!await cached(tab))
      const { html } = await cached(tab)
      assert.match(html, /Comment number 1[\s\S]*Comment number 2/)
      assert.doesNotMatch(html, /\/reply/)
      assert.equal((await indexEntry(tab)).comments, true)
    }
    finally {
      await tab?.close()
    }
  })

  test('with comments saved, comments the page didn\'t ask for leave it uncached', async () => {
    const tab = await open(WORK_URL, { page: workPage({ saved: true, comments: 2 }), seed: { 'option.opportunisticCache': 'markedForLater', 'option.cacheComments': true } })
    try {
      await sleep(500)
      assert.equal(await cached(tab), null)
    }
    finally {
      await tab.close()
    }
  })

  test('a stored blurb is rewritten from the work page, and none is stored where there was none', async () => {
    const tab = await open(WORK_URL, {
      page: workPage(),
      seed: { 'option.opportunisticBlurbs': true, ...storedLists({ 'tag-works:Bees': { scrapedAt: Date.now(), blurbsHtml: [listingBlurb(WORK_ID)] } }) },
    })
    try {
      await until('the blurb is rewritten', async () => (await read(tab, `blurbData.${SID}`))?.work?.words === 4200)
      assert.equal((await read(tab, `blurbData.${SID}`)).src, 'workPage')
      assert.match((await read(tab, `blurb.${SID}`)).html, /The visited work/)
    }
    finally {
      await tab.close()
    }

    const bare = await open(WORK_URL, { page: workPage(), seed: { 'option.opportunisticBlurbs': true } })
    try {
      await sleep(500)
      assert.equal(await read(bare, `blurb.${SID}`), null)
      assert.equal(await read(bare, `blurbData.${SID}`), null)
    }
    finally {
      await bare.close()
    }
  })
})

/** A work's page opens as its entire work, with its comments shown, when the reader asked for that. */
describe('work page defaults', { skip }, () => {
  let browser

  before(async () => {
    ensureBuilt()
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('a work opens as its entire work, with its comments shown', async () => {
    const requests = []
    const tab = await openTab(browser, {
      seed: { 'option.showFullWork': true, 'option.showComments': true },
      route: () => workPage(),
      requests,
    })
    try {
      await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
      await Promise.all([tab.waitForNavigation({ waitUntil: 'domcontentloaded' }), inject(tab).catch(() => {})])
      const shown = `${FULL_URL}&show_comments=true`
      assert.equal(tab.url(), shown)
      assert.deepEqual(requests.filter(url => url.includes('/works/')), [WORK_URL, shown])
    }
    finally {
      await tab.close()
    }
  })

  test('with only comments asked for, AO3 is asked for the comments', async () => {
    const requests = []
    const tab = await openTab(browser, { seed: { 'option.showComments': true }, route: () => workPage(), requests })
    try {
      await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
      await Promise.all([tab.waitForNavigation({ waitUntil: 'domcontentloaded' }), inject(tab).catch(() => {})])
      const shown = `${WORK_URL}?show_comments=true`
      assert.equal(tab.url(), shown)
      assert.deepEqual(requests.filter(url => url.includes('/works/')), [WORK_URL, shown])
    }
    finally {
      await tab.close()
    }
  })
})
