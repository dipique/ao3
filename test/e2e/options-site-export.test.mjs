import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const ARCHIVE = 'https://archiveofourown.org'
const CACHE_KEY = 'marked-for-later:tester'
const LABEL = 'Marked for Later — tester'

/**
 * The site export's Advanced section, driven end to end: a stored list, the
 * caching job that fetches its works from a stubbed AO3, and the refresh that
 * re-scrapes the list itself (the plan's §1 and §6,
 * {@link file://../../../plans/site-export.md}).
 *
 * This is the only place the job runner is exercised at all — it needs a DOM,
 * `browser.storage` and a network, so it can't be reached from a `node --test`
 * unit test the way the staleness ladder underneath it can.
 */

/** A blurb with everything `parseWork` reads: id, title, byline, stats. */
function blurb(id, title, { words = 5000, chapters = '1/1' } = {}) {
  return `<li class="work blurb group" id="work_${id}" role="article">
    <!--updated_at=1770000000-->
    <div class="header module">
      <h4 class="heading"><a href="/works/${id}">${title}</a>
        by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4>
      <h5 class="fandoms heading"><a class="tag" href="/tags/F/works">A Fandom</a></h5>
    </div>
    <ul class="tags commas"><li class="freeforms"><a class="tag" href="/tags/T/works">Fluff</a></li></ul>
    <dl class="stats">
      <dt class="words">Words:</dt><dd class="words">${words.toLocaleString('en-US')}</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">${chapters}</dd>
    </dl>
  </li>`
}

/** The reader's Marked for Later listing, signed in and one page long. */
function listingPage(ids) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body class="logged-in">
  <div id="main" class="reading-index region">
    <ul class="navigation actions"></ul>
    <ol class="reading work index group">${ids.map(id => blurb(id, `Work number ${id}`)).join('')}</ol>
  </div>
</body></html>`
}

/** A work page as `view_full_work=true` returns it: meta block, work text, and chrome to drop. */
function workPage(id) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Work ${id}</title><script>window.evil = 1</script></head>
<body class="logged-in">
  <div id="header"><ul class="primary navigation actions"><li><a href="/">Home</a></li></ul></div>
  <div id="main" class="works-show region">
    <dl class="work meta group">
      <dt class="rating tags">Rating:</dt><dd class="rating tags"><ul class="commas"><li><a class="tag" href="/tags/General%20Audiences">General Audiences</a></li></ul></dd>
      <dt class="stats">Stats:</dt><dd class="stats"><dl class="stats"><dt class="words">Words:</dt><dd class="words">5,000</dd></dl></dd>
    </dl>
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">Work number ${id}</h2></div>
      <div id="chapters"><div class="userstuff"><p>The text of work ${id}.</p></div></div>
    </div>
    <form id="new_kudo"><button type="submit">Kudos</button></form>
  </div>
</body></html>`
}

const SEED = {
  'cache.searchSnapshots': {
    [CACHE_KEY]: {
      version: 2,
      // Old enough that "list refreshed …" reads as hours, not seconds.
      scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
      blurbsHtml: [blurb(11, 'Work number 11'), blurb(12, 'Work number 12')],
      descriptor: {
        sourceId: 'marked-for-later',
        label: LABEL,
        listUrl: `${ARCHIVE}/users/tester/readings?show=to-read`,
      },
    },
  },
}

describe('options UI — site export', { skip }, () => {
  let server
  let browser
  let page
  const problems = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const url = req.url()
      if (!url.startsWith(ARCHIVE))
        return void req.continue()
      const path = new URL(url).pathname
      const workId = /^\/works\/(\d+)$/.exec(path)?.[1]
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        // The real options page needs no CORS header — a host in
        // `host_permissions` is privileged rather than cross-site (the plan's
        // §7) — but this page is served from plain localhost with no extension
        // behind it, so the stub has to grant what the browser would otherwise
        // have skipped asking for.
        headers: { 'access-control-allow-origin': '*' },
        // The refresh adds a third work, so the second run has something to fetch.
        body: workId ? workPage(workId) : listingPage([11, 12, 13]),
      })
    })
    page.on('console', m => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', e => problems.push(e.message))
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** The whole OptionRow for a title — its label and whatever sits under it. */
  const rowHandle = async (title) => {
    const handle = await page.evaluateHandle((t) => {
      const span = [...document.querySelectorAll('label span')].find(el => el.textContent.trim() === t)
      return span?.closest('label')?.parentElement ?? null
    }, title)
    const el = handle.asElement()
    assert.ok(el, `option row "${title}" not found`)
    return el
  }

  /** Click the button with this exact label inside the named row. */
  const clickIn = async (title, label) => {
    const row = await rowHandle(title)
    const handle = (await row.evaluateHandle(
      (el, text) => [...el.querySelectorAll('button')].find(b => b.textContent.trim() === text) ?? null,
      label,
    )).asElement()
    assert.ok(handle, `button "${label}" not found in row "${title}"`)
    await handle.click()
  }

  /** The last value written to a storage key, or null. */
  const lastWrite = key => page.evaluate(
    k => window.__writes.filter(w => k in w).map(w => w[k]).at(-1) ?? null,
    key,
  )

  /** Wait until `check` reads true, or fail after `ms`. */
  const until = async (what, check, ms = 20000) => {
    const deadline = Date.now() + ms
    for (;;) {
      if (await check())
        return
      if (Date.now() > deadline)
        assert.fail(`timed out waiting for ${what}`)
      await sleep(200)
    }
  }

  test('a stored list gets a row, read out from the snapshot and the cache', async () => {
    const row = await rowHandle(LABEL)
    const summary = await row.evaluate(el => el.querySelector('label span + span')?.textContent?.trim() ?? '')
    assert.match(summary, /^2 works/)
    assert.match(summary, /list refreshed 3 hours ago/)
    assert.match(summary, /nothing cached yet/)
    assert.match(summary, /2 not cached/)
  })

  test('"Cache works" fetches and stores each work\'s sanitized text', async () => {
    await clickIn(LABEL, 'Cache works')
    await until('the work-text index to be written', async () => {
      const index = await lastWrite('workTextIndex')
      return index && Object.keys(index).length === 2
    })

    const index = await lastWrite('workTextIndex')
    assert.deepEqual(Object.keys(index).sort(), ['11', '12'])
    for (const meta of Object.values(index)) {
      assert.ok(meta.size > 0, 'each entry should record the size of its text')
      assert.equal(meta.failure, undefined)
      assert.equal(meta.words, 5000)
    }

    const stored = await lastWrite('workText.11')
    assert.match(stored.html, /The text of work 11\./)
    assert.match(stored.html, /class="work meta group"/)
    // The sanitizer's job, checked through the runner: no chrome, no controls.
    assert.doesNotMatch(stored.html, /new_kudo|primary navigation|window\.evil/)
  })

  test('the run finishes, clearing the job and updating the row', async () => {
    await until('the job record to be cleared', async () => {
      const job = await page.evaluate(async () => (await browser.storage.local.get('siteExportJob')).siteExportJob ?? null)
      return job === null
    })
    const row = await rowHandle(LABEL)
    const summary = await row.evaluate(el => el.querySelector('label span + span')?.textContent?.trim() ?? '')
    assert.match(summary, /2 cached \(/)
    assert.doesNotMatch(summary, /not cached/)
  })

  test('"Refresh list" re-scrapes the listing and its saved-work index', async () => {
    await clickIn(LABEL, 'Refresh list')
    await until('the snapshot to be rewritten', async () => {
      const snapshots = await lastWrite('cache.searchSnapshots')
      return snapshots?.[CACHE_KEY]?.blurbsHtml?.length === 3
    })
    // Marked for Later owns a side table, and a refresh has to carry it along.
    const marked = await lastWrite('cache.markedForLater')
    assert.equal(marked.userId, 'tester')
    assert.ok(marked.ids.length > 0)

    const row = await rowHandle(LABEL)
    const summary = await row.evaluate(el => el.querySelector('label span + span')?.textContent?.trim() ?? '')
    assert.match(summary, /^3 works/)
    assert.match(summary, /1 not cached/)
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(problems, [])
  })
})
