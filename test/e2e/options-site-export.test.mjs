import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDir, serveDist, sleep, storedListIds, storedLists } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const ARCHIVE = 'https://archiveofourown.org'
const CACHE_KEY = 'marked-for-later:tester'
const LABEL = 'Marked for Later — tester'
/** The one row that isn't about a list: the way changes made in a file get back. */
const CHANGES_ROW = 'Changes made in an export'
const CACHE_ROW = 'Cached work text'

/**
 * The site export's Advanced section, driven end to end: a stored list, the
 * caching job that fetches its works from a stubbed AO3, and the refresh that
 * re-scrapes the list itself.
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
  ...storedLists({
    // Written before descriptors existed: no address, no way to refresh it. Kept
    // here because it is the row the rebuilt-from-the-key link exists for.
    'marked-for-later:olduser': {
      version: 1,
      scrapedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
      blurbsHtml: [blurb(21, 'Work number 21')],
    },
    [CACHE_KEY]: {
      version: 2,
      // Old enough that "as of …" reads as hours, not seconds.
      scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
      blurbsHtml: [blurb(11, 'Work number 11'), blurb(12, 'Work number 12')],
      descriptor: {
        sourceId: 'marked-for-later',
        label: LABEL,
        listUrl: `${ARCHIVE}/users/tester/readings?show=to-read`,
      },
    },
  }),
  // Marks travel with the library, and are the whole of what an exported page
  // records: `boring` aliases `read`, so choosing it means "done with this" —
  // which on a Marked for Later list is also something AO3 has to be told.
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
      boring: { icon: 'boring', label: 'Boring', color: '#8a6d3b', triggerAlias: 'read', hideSearchResult: false, items: '' },
      continue: { icon: 'continue', label: 'Ongoing', color: '#0369a1', triggerAlias: 'read', tracksProgress: true, hideSearchResult: false, items: '' },
    },
  },
  // The export bakes the reader's find/replace rules into every work on the way
  // out, so there has to be one to bake.
  'option.textReplacements': {
    enabled: true,
    tools: false,
    rules: [
      { find: 'The text of', replace: 'The rewritten text of' },
      // Never fires: the title is the work's identity, not its prose, and the
      // export rewrites exactly the scope the on-page unit does.
      { find: 'Work number', replace: 'Story number' },
    ],
  },
}

/**
 * Works AO3 will refuse once with a 429 before serving them.
 *
 * Being asked to slow down says nothing about the work it interrupted — any
 * work asked for at that moment would have got the same answer — so the run has
 * to wait it out and carry on, with nothing recorded against this one.
 */
const rateLimitOnce = new Set(['12'])

/**
 * Catch what `saveAs` hands the browser, instead of letting it hand it to the
 * browser. A detached `<a download>` still starts a real download in headless
 * Chrome, which this test has nowhere to put and nothing to say about; what it
 * wants is the Blob itself.
 */
function captureDownloads() {
  window.__downloads = []
  const blobs = new Map()
  const createObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (object) => {
    const url = createObjectURL(object)
    blobs.set(url, object)
    return url
  }
  const click = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (!this.hasAttribute('download'))
      return click.call(this)
    window.__downloads.push({ name: this.download, url: this.href })
  }
  window.__downloadBytes = async (url) => {
    const bytes = new Uint8Array(await blobs.get(url).arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(binary)
  }
}

describe('options UI — site export', { skip }, () => {
  let server
  let browser
  let page
  /** What the row was showing while it sat out the stub's 429. */
  let waitLine = ''
  const problems = []
  /** Works the stub was asked to take off Marked for Later, and what was posted. */
  const marked = []
  /** The change file the exported page handed back, once it has handed one back. */
  let changeFile = null

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

      // The two endpoints a change file's ingest uses: a CSRF token from AO3's
      // dispenser, and the PATCH-through-POST that takes a work off Marked for
      // Later. Both are reached from the options page, which — unlike a content
      // script — has no AO3 document to read a token out of.
      if (path === '/token_dispenser.json') {
        return void req.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ token: 'a-token' }),
        })
      }
      const markedRead = /^\/works\/(\d+)\/mark_as_read$/.exec(path)?.[1]
      if (markedRead) {
        marked.push({ workId: markedRead, method: req.method(), body: req.postData() ?? '' })
        return void req.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'access-control-allow-origin': '*' },
          body: '<!doctype html><html><head><meta charset="utf-8"><title>Marked</title></head><body></body></html>',
        })
      }

      const workId = /^\/works\/(\d+)$/.exec(path)?.[1]
      if (workId && rateLimitOnce.delete(workId)) {
        return void req.respond({
          status: 429,
          contentType: 'text/plain; charset=utf-8',
          // `Retry-After` is not a CORS-safelisted response header, so a page
          // reading a cross-origin response cannot see it without this. The real
          // options page never needs it — a host in `host_permissions` is
          // privileged rather than cross-site, and gets every header — but this
          // stub is plain localhost, and without the exposure the extension
          // would silently fall back to its own backoff and the test would be
          // measuring the wrong thing.
          headers: {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'Retry-After',
            'retry-after': '3',
          },
          body: 'slow down',
        })
      }
      void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        // The real options page needs no CORS header — a host in
        // `host_permissions` is privileged rather than cross-site — but this
        // page is served from plain localhost with no extension behind it, so
        // the stub has to grant what the browser would otherwise have skipped
        // asking for.
        headers: { 'access-control-allow-origin': '*' },
        // The refresh adds a third work, so the second run has something to fetch.
        body: workId ? workPage(workId) : listingPage([11, 12, 13]),
      })
    })
    // Chrome logs every non-2xx response as a console error of its own. The one
    // 429 the stub serves on purpose is the subject of a test, not a fault.
    const expected = /status of 429/
    page.on('console', m => m.type() === 'error' && !expected.test(m.text()) && problems.push(m.text()))
    page.on('pageerror', e => problems.push(e.message))
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.evaluateOnNewDocument(captureDownloads)
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
    const summary = await row.evaluate(el => el.querySelector('label > div > span')?.textContent?.trim() ?? '')
    assert.match(summary, /^2 works/)
    assert.match(summary, /as of 3 hours ago/)
    assert.match(summary, /0 cached/)
    assert.match(summary, /2 uncached/)
  })

  /**
   * Every row says where its list actually is, because "go and open it on AO3"
   * is a real instruction here — it is the only thing that makes a list
   * refreshable from this page.
   */
  test('each list links to itself on AO3, descriptor or not', async () => {
    const link = async (title) => {
      const row = await rowHandle(title)
      return row.evaluate(el => ({
        href: el.querySelector('label > span a')?.getAttribute('href') ?? null,
        text: el.querySelector('label > span a')?.textContent?.trim() ?? null,
        target: el.querySelector('label > span a')?.getAttribute('target') ?? null,
      }))
    }

    const stored = await link(LABEL)
    assert.equal(stored.href, `${ARCHIVE}/users/tester/readings?show=to-read`)
    assert.equal(stored.text, '(link)')
    // A new tab: the point is to come back here and press Refresh afterwards.
    assert.equal(stored.target, '_blank')

    // The v1 row has no descriptor to read an address out of, so it is rebuilt
    // from the cache key — and this is the row that most needs it, since opening
    // the list is the only way to make its buttons work again.
    const old = await link('marked-for-later:olduser')
    assert.equal(old.href, `${ARCHIVE}/users/olduser/readings?show=to-read`)
  })

  test('"Works" fetches and stores each work\'s sanitized text', async () => {
    await clickIn(LABEL, 'Works')

    // Work 12 is refused once with `Retry-After: 3` (see `rateLimitOnce`), so
    // there is a window in which the row has to be counting down rather than
    // sitting mute. Caught here because it only exists while the run is in it.
    await until('the row to say what it is waiting for', async () => {
      const row = await rowHandle(LABEL)
      waitLine = await row.evaluate(el => el.textContent ?? '')
      return /trying again in/.test(waitLine)
    })

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

  /**
   * Work 12 was refused once with a 429 and `Retry-After: 1` before it was
   * served (see {@link rateLimitOnce}). The run has to wait that out by itself —
   * a reader should not have to sit with the page and press Continue every time
   * AO3 paces us — and, crucially, must record nothing against the work. Any
   * work asked for at that moment would have been refused just the same, so it
   * is a fact about the minute, not about the story.
   */
  test('a 429 is waited out, and lands on nothing', async () => {
    assert.equal(rateLimitOnce.size, 0, 'the stub should have refused work 12 once')

    // A pause of minutes with every worker inside it is indistinguishable from
    // a hang, so the row says why it is quiet and how long for.
    assert.match(waitLine, /AO3 asked us to slow down — trying again in [0-9:]+/)

    const index = await lastWrite('workTextIndex')
    assert.ok(index['12'].size > 0, 'the work was fetched after the wait')
    assert.equal(index['12'].failure, undefined, 'and nothing was held against it')
    // No failure recorded means no backoff earned: the next run treats it as an
    // ordinary cached work rather than one to be retried.
    assert.equal(index['12'].failedAt, undefined)

    const job = await page.evaluate(async () => (await browser.storage.local.get('siteExportJob')).siteExportJob ?? null)
    assert.equal(job?.errorCount ?? 0, 0, 'a rate limit is not a work that could not be fetched')
    assert.equal(job?.blocked, undefined, 'and the run was not stopped by it')
  })

  test('the run finishes, clearing the job and updating the row', async () => {
    await until('the job record to be cleared', async () => {
      const job = await page.evaluate(async () => (await browser.storage.local.get('siteExportJob')).siteExportJob ?? null)
      return job === null
    })
    const row = await rowHandle(LABEL)
    const summary = await row.evaluate(el => el.querySelector('label > div > span')?.textContent?.trim() ?? '')
    assert.match(summary, /2 cached \(/)
    assert.doesNotMatch(summary, /uncached/)
  })

  test('"List" re-scrapes the listing and its saved-work index', async () => {
    await clickIn(LABEL, 'List')
    await until('the snapshot to be rewritten', async () => {
      const lists = await lastWrite('cache.searchLists')
      return storedListIds(lists?.[CACHE_KEY]).length === 3
    })
    // Marked for Later owns a side table, and a refresh has to carry it along.
    const marked = await lastWrite('cache.markedForLater')
    assert.equal(marked.userId, 'tester')
    assert.ok(marked.ids.length > 0)

    const row = await rowHandle(LABEL)
    const summary = await row.evaluate(el => el.querySelector('label > div > span')?.textContent?.trim() ?? '')
    assert.match(summary, /^3 works/)
    assert.match(summary, /1 uncached/)
  })

  /** The exported page behind the last download `saveAs` asked for. */
  const lastDownload = async () => {
    const record = await page.evaluate(() => window.__downloads.at(-1) ?? null)
    assert.ok(record, 'nothing was handed to the browser to save')
    const base64 = await page.evaluate(url => window.__downloadBytes(url), record.url)
    const html = Buffer.from(base64, 'base64').toString('utf-8')
    // The same block the exported page reads itself out of.
    const open = html.indexOf('<script type="application/json" id="ao3e-data">')
    const start = html.indexOf('>', open) + 1
    const data = JSON.parse(html.slice(start, html.indexOf('</script>', start)))
    return { name: record.name, html, data }
  }

  /** Unpack one compressed entry the way the exported page unpacks it. */
  const unpack = entry => page.evaluate(async (e) => {
    const binary = atob(e.b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'))
    return new TextDecoder().decode(await new Response(stream).arrayBuffer())
  }, entry)

  test('"Download" refreshes, caches and writes one HTML file', async () => {
    await clickIn(LABEL, 'Download')
    await until('the download to be handed over', () => page.evaluate(() => window.__downloads.length > 0), 40000)

    const { name, html, data } = await lastDownload()
    assert.match(name, /^AO3-Enhancements-site_marked-for-later-tester_\d{4}-\d{2}-\d{2}_[\d-]{8}\.html$/)
    assert.match(html, /^<!doctype html>/)
    assert.equal(data.v, 2)
    assert.equal(data.works.length, 3)
    // Everything the page needs is inside it — no fetch, no second file.
    assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/)

    // The app travels compressed, the way the works do; only its loader is
    // plain script. (That it unpacks and runs is the file:// test below.)
    const open = html.indexOf('<script type="application/json" id="ao3e-app">')
    assert.ok(open > 0, 'the app should travel in its own data block')
    const start = html.indexOf('>', open) + 1
    const app = JSON.parse(html.slice(start, html.indexOf('</script>', start)))
    assert.ok(app.size > app.b64.length && app.crc > 0, 'the app should be deflated, with what it unpacks to')
  })

  test('a page whose scripts never run says so', async () => {
    const { html } = await lastDownload()
    // The shell is static, so this is what a reader sees when the browser
    // refuses to run it — which is what Safari does with a local file.
    assert.match(html, /This page needs JavaScript, and none is running/)
    assert.match(html, /Microsoft Edge/)
  })

  test('the manifest accounts for every work in the list', async () => {
    const { data } = await lastDownload()
    const { manifest } = data
    assert.equal(manifest.v, 2)
    assert.equal(manifest.source.id, 'marked-for-later')
    assert.equal(manifest.source.label, LABEL)
    assert.equal(manifest.list.count, 3)
    // The full path refreshes first, so work 13 — added by the refresh — is
    // cached by the time the file is written.
    assert.deepEqual(manifest.counts, { total: 3, cached: 3, restricted: 0, notfound: 0, error: 0, uncached: 0 })
    assert.equal(manifest.textReplacementsBaked, true)
    assert.deepEqual(manifest.works.map(w => w.id), ['11', '12', '13'])
    assert.ok(manifest.works[0].size > 0)
  })

  test('each work is compressed on its own, with replacements baked in', async () => {
    const { data } = await lastDownload()
    // One entry per work is what lets the page unpack only the one being read.
    assert.deepEqual(data.works.map(w => w.id), ['11', '12', '13'])
    for (const work of data.works) {
      assert.ok(work.size > 0 && work.crc > 0, 'each entry records what it should come back as')
      assert.ok(!work.b64.includes('<'), 'base64 needs no script escaping')
    }

    const text = await unpack(data.works.find(w => w.id === '11'))
    assert.match(text, /^<div class="ao3e-work"/)
    assert.match(text, /The rewritten text of work 11\./)
    assert.doesNotMatch(text, /The text of work 11\./)
    // The title is the work's identity, not its prose — the second rule is
    // written to fire there and must not.
    assert.match(text, /<h2 class="title heading">Work number 11<\/h2>/)
    assert.doesNotMatch(text, /Story number/)
    // Same sanitizing the cache holds: no chrome, no controls, no scripts.
    assert.doesNotMatch(text, /new_kudo|primary navigation|window\.evil/)
  })

  test('the blurbs travel together, keeping AO3\'s words', async () => {
    const { html, data } = await lastDownload()
    const blurbs = JSON.parse(await unpack(data.blurbs))

    assert.equal(blurbs.length, 3)
    assert.ok(blurbs[0].includes('work_11'), 'blurb HTML travels as HTML, to be mounted as-is')
    // Replacements are for the work text alone.
    assert.ok(blurbs[0].includes('Work number 11'))
    // A literal `</script>` inside the data block would end the tag it sits in,
    // so the only one in that region must be the block's own closing tag.
    const open = html.indexOf('id="ao3e-data"')
    const close = html.indexOf('</script>', open)
    assert.ok(html.slice(open, close).endsWith('}'), 'the data block must run to its own closing tag')
  })

  test('the reader\'s settings travel, minus what belongs to this device', async () => {
    const { data } = await lastDownload()
    assert.equal(data.options.items['option.textReplacements'].enabled, true)
    assert.ok(!('option.user' in data.options.items))
    assert.ok(!('option.verbose' in data.options.items))
    assert.deepEqual(Object.keys(data.options.items['option.theme']), ['chosen'])
  })

  test('"Download without refreshing" packages what is already saved', async () => {
    const before = await page.evaluate(() => window.__downloads.length)
    const requests = []
    const watch = req => req.url().startsWith(ARCHIVE) && requests.push(req.url())
    page.on('request', watch)

    // The split button: the label of an `Icon` renders as screen-reader text
    // inside its button, which is what makes it findable by name at all.
    await clickIn(LABEL, 'More download options')
    await until('the menu to open', () => page.evaluate(
      () => [...document.querySelectorAll('[role="menuitem"]')]
        .some(el => el.textContent.includes('Download without refreshing')),
    ))
    const item = (await page.evaluateHandle(
      () => [...document.querySelectorAll('[role="menuitem"]')]
        .find(el => el.textContent.includes('Download without refreshing')) ?? null,
    )).asElement()
    await item.click()

    await until('the second download', () => page.evaluate(n => window.__downloads.length > n, before))
    page.off('request', watch)

    const { data } = await lastDownload()
    assert.equal(data.manifest.counts.cached, 3)
    assert.deepEqual(requests, [], 'nothing should have been asked of AO3')
  })

  /** A throwaway directory holding the export under each of `names`. */
  const writeExport = (html, ...names) => {
    const dir = mkdtempSync(join(tmpdir(), 'ao3e-site-'))
    for (const name of names)
      writeFileSync(join(dir, name), html)
    return dir
  }

  /** How a local file is addressed, once Windows' separators are out of the way. */
  const fileUrl = (dir, name) => `file://${join(dir, name).replace(/\\/g, '/')}`

  /**
   * The export, opened the way a reader opens it: one file, straight off disk,
   * with no server and nothing else beside it. This is the whole promise of the
   * single-file format, and a `file://` load is the only thing that proves it —
   * everything above only ever inspected the bytes.
   *
   * What it drives is the extension's own search view, running against a
   * `browser` the file brought with it: the facet sidebar, the results list, a
   * work opened from the copy inside the page.
   */
  test('the exported file works on its own, from file://', async () => {
    const { html } = await lastDownload()
    const dir = writeExport(html, 'library.html')

    const reader = await browser.newPage()
    const errors = []
    reader.on('console', m => m.type() === 'error' && errors.push(m.text()))
    reader.on('pageerror', e => errors.push(e.message))
    try {
      await reader.goto(fileUrl(dir, 'library.html'), { waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })

      // The inert shell was replaced, so the scripts ran.
      assert.doesNotMatch(await reader.content(), /This page needs JavaScript, and none is running/)
      assert.equal(await reader.$$eval('.AO3E--search-view--results > li', els => els.length), 3)
      assert.match(await reader.$eval('.AO3E--search-view--count', el => el.textContent), /of 3 works$/)

      // Storage was probed, not assumed — and a `file:` origin passes.
      assert.equal(await reader.$eval('.AO3E--site--status', el => el.dataset.ao3eWritable), 'true')

      // The whole point of shipping the real view: facets, built from the blurbs.
      assert.ok(
        await reader.$$eval('.AO3E--search-view--sidebar', els => els.length) > 0,
        'the filter sidebar should be there',
      )

      // A blurb's own link still names the archive — the view's work toolbars
      // find their target by that href — and a plain click routes in the page.
      assert.match(
        await reader.$eval('.AO3E--search-view--results > li h4 a', el => el.getAttribute('href')),
        /^https:\/\/archiveofourown\.org\/works\/11$/,
      )
      await reader.click('.AO3E--search-view--results > li h4 a')
      await reader.waitForFunction(() => location.hash === '#work/11')
      await reader.waitForFunction(() => document.querySelector('.AO3E--site--work .userstuff') !== null, { timeout: 10000 })
      const text = await reader.$eval('.AO3E--site--work', el => el.textContent)
      assert.match(text, /The rewritten text of work 11\./)
      assert.equal(await reader.$eval('.AO3E--site--list', el => el.hidden), true)

      // Back to the list, and the view's own search box narrows it.
      await reader.click('.AO3E--site--nav a')
      await reader.waitForFunction(() => !document.querySelector('.AO3E--site--list').hidden)
      await reader.type('.AO3E--search-view--input', 'Work number 12')
      await reader.waitForFunction(
        () => document.querySelectorAll('.AO3E--search-view--results > li:not(.AO3E--search-view--hidden)').length === 1,
      )

      assert.deepEqual(errors, [], 'the exported page should not need anything it does not carry')
    }
    finally {
      await reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The reader's marks, filters and layout are kept on the one origin every
   * local file shares — so a re-export, which lands under a new name, still
   * finds what the last one left.
   */
  test('a second export finds what the first one stored', async () => {
    const { html } = await lastDownload()
    const dir = writeExport(html, 'first.html', 'second.html')

    const reader = await browser.newPage()
    try {
      await reader.goto(fileUrl(dir, 'first.html'), { waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      await reader.evaluate(() => browser.storage.local.set({ 'ao3e.site.witness': 'left here' }))
      const first = await reader.evaluate(async () => (await browser.storage.local.get('ao3e.site.meta'))['ao3e.site.meta'])

      await reader.goto(fileUrl(dir, 'second.html'), { waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      const seen = await reader.evaluate(async () => (await browser.storage.local.get('ao3e.site.witness'))['ao3e.site.witness'] ?? null)
      assert.equal(seen, 'left here')

      // Every open is counted, and the generation stays the one that seeded the
      // settings — a second file of the same vintage must not write them again.
      const meta = await reader.evaluate(async () => (await browser.storage.local.get('ao3e.site.meta'))['ao3e.site.meta'])
      assert.equal(meta.opens, first.opens + 1)
      assert.equal(meta.seededGeneration, first.seededGeneration)
      assert.ok(meta.seededGeneration > 0)
    }
    finally {
      await reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * An export that lands on an origin where the name it wants is already taken.
   *
   * Measured on a real device: a `file://` origin is shared by every local file,
   * and an unrelated page had left an `ao3e-site`-shaped database sitting on the
   * name with none of the stores an export needs. A fixed `DB_VERSION` makes that
   * permanent — the open succeeds, no upgrade ever runs again, and every
   * transaction fails — so the page would tell the reader this browser keeps
   * nothing, forever, on a device where it keeps things perfectly well.
   */
  test('an export adds its stores to a database that arrived without them', async () => {
    const { html } = await lastDownload()
    const dir = writeExport(html, 'library.html')
    writeFileSync(join(dir, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>blank</title>')

    const reader = await browser.newPage()
    try {
      // Somebody else's database, on our name, at version 1. Set up from a page
      // that isn't the export, so nothing is holding a connection open.
      await reader.goto(fileUrl(dir, 'blank.html'), { waitUntil: 'load' })
      await reader.evaluate(async () => {
        await new Promise((resolve) => {
          const del = indexedDB.deleteDatabase('ao3e-site')
          del.onsuccess = del.onerror = del.onblocked = resolve
        })
        await new Promise((resolve) => {
          const req = indexedDB.open('ao3e-site', 1)
          req.onupgradeneeded = () => req.result.createObjectStore('visits')
          req.onsuccess = () => {
            req.result.close()
            resolve()
          }
          req.onerror = resolve
        })
      })

      await reader.goto(fileUrl(dir, 'library.html'), { waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.equal(
        await reader.$eval('.AO3E--site--status', el => el.dataset.ao3eWritable),
        'true',
        'the origin is writable, and saying otherwise would be the bug',
      )

      // Upgraded, not replaced: what was already there is still there.
      const found = await reader.evaluate(() => new Promise((resolve) => {
        const req = indexedDB.open('ao3e-site')
        req.onsuccess = () => {
          const db = req.result
          const seen = { version: db.version, stores: [...db.objectStoreNames].sort() }
          db.close()
          resolve(seen)
        }
      }))
      assert.deepEqual(found.stores, ['journal', 'storage', 'visits'])
      assert.ok(found.version >= 2, `expected an upgrade, got version ${found.version}`)

      // And the thing all of that is for: a write that survives the file closing.
      await reader.evaluate(() => browser.storage.local.set({ 'ao3e.site.repaired': 'kept' }))
      await reader.goto(fileUrl(dir, 'blank.html'), { waitUntil: 'load' })
      await reader.goto(fileUrl(dir, 'library.html'), { waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.equal(
        await reader.evaluate(async () => (await browser.storage.local.get('ao3e.site.repaired'))['ao3e.site.repaired']),
        'kept',
      )
    }
    finally {
      await reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * What the reader does in the file, kept so it can be given back.
   *
   * This is the whole of phase 2's first half: an export is read where the
   * extension isn't, so a mark made here has to survive as *something* — an
   * append-only op in the same `ao3e-site` database the settings live in. And
   * because a `file:` origin will not promise to keep that (`persist()` is
   * refused there, measured), the page has to say how much is riding on it,
   * which is the count this asserts as well.
   *
   * The store is cleared first: every local file shares one origin, so the ops
   * of an earlier test in this same browser would otherwise be counted here.
   */
  test('a mark made in the file is journalled, and counted where it can be seen', async () => {
    const { html } = await lastDownload()
    const dir = writeExport(html, 'journal.html')

    const reader = await browser.newPage()
    const errors = []
    reader.on('console', m => m.type() === 'error' && errors.push(m.text()))
    reader.on('pageerror', e => errors.push(e.message))
    // The page hands the change file over the same way the options page hands
    // over an export, so it is caught the same way.
    await reader.evaluateOnNewDocument(captureDownloads)

    /** Every op in the journal store, oldest first. */
    const ops = () => reader.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('ao3e-site')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const request = db.transaction('journal', 'readonly').objectStore('journal').index('at').getAll()
        request.onsuccess = () => {
          db.close()
          resolve(request.result)
        }
        request.onerror = () => reject(request.error)
      }
    }))

    const pending = () => reader.$eval('.AO3E--site--status', el => ({
      count: el.dataset.ao3ePending,
      writable: el.dataset.ao3eWritable,
      text: el.textContent,
    }))

    try {
      await reader.goto(fileUrl(dir, 'journal.html'), { waitUntil: 'load' })
      await reader.evaluate(() => new Promise((resolve) => {
        const del = indexedDB.deleteDatabase('ao3e-site')
        del.onsuccess = del.onerror = del.onblocked = () => resolve()
      }))
      await reader.reload({ waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })

      // Nothing done yet, so nothing is claimed — but the page still says what
      // it can and can't promise about the browser it is sitting in, and points
      // at the way out of it. Asserted on the panel's own state and its one
      // action rather than on its prose, which is copy and gets rewritten.
      const before = await pending()
      assert.equal(before.count, '0')
      assert.equal(before.writable, 'true', 'a `file:` origin keeps what is written to it')
      assert.doesNotMatch(before.text, /not yet exported/)
      assert.match(before.text, /export changes/i, 'the panel should name the way out')

      // Right-click a work and mark it — the extension's own work menu, running
      // in a file with no extension under it.
      await reader.evaluate(() => {
        const link = document.querySelector('.AO3E--search-view--results > li h4.heading a[href*="/works/"]')
        link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
      })
      await reader.waitForSelector('.AO3E--menu .AO3E--menu--item', { timeout: 5000 })
      assert.ok(await reader.evaluate(() => {
        const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
          .find(el => el.textContent.startsWith('Mark as boring'))
        row?.click()
        return !!row
      }), 'the work menu should offer the marks that travelled with the export')

      await until('the change to be counted', async () => (await pending()).count === '1')
      assert.match((await pending()).text, /1 change not yet exported/)

      // `boring` aliases `read`, and this list is one AO3 itself holds — so the
      // op is the one with a second half only the archive can do.
      const recorded = await ops()
      assert.equal(recorded.length, 1)
      assert.equal(recorded[0].workId, '11')
      assert.equal(recorded[0].op, 'markAsRead')
      assert.deepEqual(recorded[0].payload, { markId: 'boring', on: true })
      assert.ok(recorded[0].at > 0 && typeof recorded[0].id === 'string')

      // The mark itself landed in storage too — the journal records the write,
      // it doesn't replace it.
      const marked = await reader.evaluate(async () => {
        const stored = (await browser.storage.local.get('option.workMarks'))['option.workMarks']
        return stored.marks.boring.items
      })
      assert.notEqual(marked, '', 'the mark should be in the table as well as the journal')

      // Closed and reopened, the count is still what the reader left: it is read
      // back from the store rather than kept in the page.
      await reader.reload({ waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.equal((await pending()).count, '1')

      // And the way out of that count: the page writes what it recorded to a
      // file, names it, and stops claiming anything is riding on this browser.
      await reader.click('.AO3E--site--status-export')
      await until('the change file to be handed over', () => reader.evaluate(() => window.__downloads.length > 0))
      const handed = await reader.evaluate(() => window.__downloads.at(-1))
      assert.match(handed.name, /^ao3e-changes-marked-for-later-\d{4}-\d{2}-\d{2}_[\d-]{8}\.json$/)
      const text = Buffer.from(
        await reader.evaluate(url => window.__downloadBytes(url), handed.url),
        'base64',
      ).toString('utf-8')
      changeFile = { name: handed.name, text }

      const written = JSON.parse(text)
      assert.equal(written.v, 1)
      assert.equal(written.sourceId, 'marked-for-later')
      assert.ok(written.exportedAt > 0)
      assert.deepEqual(written.ops, recorded, 'the file is the journal, verbatim')

      await until('the count to be cleared', async () => (await pending()).count === '0')
      assert.match(await reader.$eval('.AO3E--site--status', el => el.textContent), /Saved 1 change as ao3e-changes-/)

      // Exported is exported: the mark left, so the next open has nothing to
      // warn about — which is only true if the file's own record of it survived.
      await reader.reload({ waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.equal((await pending()).count, '0')

      assert.deepEqual(errors, [], 'journalling should not need anything the file does not carry')
    }
    finally {
      await reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The same file over http — the path for a reader whose browser won't open a
   * local one at all, and the one no specification can take away.
   *
   * Two things only this half can show. That the page fetches **nothing**: over
   * `file:` a request would be blocked whether the app made one or not, while
   * here it would succeed, so an empty request log is the first real evidence
   * that everything travelled inside the document. And that what the reader
   * changes is kept on an origin that isn't the one every local file shares —
   * measured the only way a reader would notice, by reloading and looking.
   */
  test('the same file works served over http, on an origin of its own', async () => {
    const { html } = await lastDownload()
    const dir = writeExport(html, 'library.html')
    const site = await serveDir(dir)
    const url = `${site.url}/library.html`

    const reader = await browser.newPage()
    const errors = []
    const fetched = []
    reader.on('console', m => m.type() === 'error' && errors.push(m.text()))
    reader.on('pageerror', e => errors.push(e.message))
    // `data:` is the shim's answer for a packaged resource, and a favicon is the
    // browser asking for something the page never mentioned. Neither is the
    // page reaching for a file it should have carried.
    reader.on('request', req => /^https?:/.test(req.url()) && !req.url().endsWith('/favicon.ico') && fetched.push(req.url()))

    const groups = () => reader.$$eval('.AO3E--search-view--group', els => els.map(el => ({
      name: el.querySelector('.AO3E--search-view--group-label').textContent.trim(),
      open: el.open,
    })))

    try {
      await reader.goto(url, { waitUntil: 'networkidle2' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.equal(await reader.$$eval('.AO3E--search-view--results > li', els => els.length), 3)

      // Its own origin: the witness the `file://` copy left is not here, and
      // this copy seeded its settings itself rather than finding them waiting.
      assert.equal(await reader.$eval('.AO3E--site--status', el => el.dataset.ao3eWritable), 'true')
      const witness = await reader.evaluate(async () => (await browser.storage.local.get('ao3e.site.witness'))['ao3e.site.witness'] ?? null)
      assert.equal(witness, null)
      const meta = await reader.evaluate(async () => (await browser.storage.local.get('ao3e.site.meta'))['ao3e.site.meta'])
      assert.equal(meta.opens, 1)
      assert.ok(meta.seededGeneration > 0)

      // A work still opens from the copy inside the page, by hash.
      await reader.click('.AO3E--search-view--results > li h4 a')
      await reader.waitForFunction(() => document.querySelector('.AO3E--site--work .userstuff') !== null, { timeout: 10000 })
      assert.match(await reader.$eval('.AO3E--site--work', el => el.textContent), /The rewritten text of work 11\./)
      await reader.click('.AO3E--site--nav a')
      await reader.waitForFunction(() => !document.querySelector('.AO3E--site--list').hidden)

      // Collapse a facet group, which is the smallest thing the view persists.
      const before = await groups()
      assert.ok(before.length > 0 && before.every(g => g.open), 'groups open on a first visit')
      await reader.click('.AO3E--search-view--group-title .AO3E--search-view--group-label')
      await until('the layout to be saved', () => reader.evaluate(async () => {
        const prefs = (await browser.storage.local.get('cache.searchViewPrefs'))['cache.searchViewPrefs']
        return (prefs?.['marked-for-later']?.collapsed?.length ?? 0) > 0
      }))

      // Reload — a fresh document, a fresh shim, the same store — and it is as
      // the reader left it.
      await reader.reload({ waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.deepEqual(
        (await groups()).filter(g => !g.open).map(g => g.name),
        [before[0].name],
      )

      // Two loads, one address: everything the app needs was in the document.
      assert.deepEqual([...new Set(fetched)], [url], 'nothing was asked of the server but the file itself')
      assert.deepEqual(errors, [], 'a served export should ask for nothing it does not carry')
    }
    finally {
      await reader.close()
      await site.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The other end of the round trip: the file the exported page wrote, read
   * back into the extension.
   *
   * This is the whole of phase 2 in one test, and only an end-to-end one can be
   * it — the mark was made in another origin's storage, by a page with no
   * extension under it, and what has to happen here is that the reader's own
   * table and their Marked for Later list on AO3 both catch up with it.
   *
   * The second import is the point of the ledger: the same file, twice, must
   * cost nothing and must not ask AO3 for anything a second time.
   */
  test('the changes made inside the file come back into the extension', async () => {
    assert.ok(changeFile, 'the exported page should have handed a file over')

    /**
     * Hand the page the file, without the browser's own dialog.
     *
     * The third harness wrinkle, and the same trade as the download one above:
     * an `<input type="file">` opens a chooser that belongs to the browser
     * rather than to the page, so what is stubbed is the dialog — the click
     * fills the input with the file instead of asking for one. Everything under
     * test is on this side of it: what the page does with what it was handed.
     */
    const handOver = () => page.evaluate((name, text) => {
      const click = HTMLInputElement.prototype.click
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file')
          return click.call(this)
        const data = new DataTransfer()
        data.items.add(new File([text], name, { type: 'application/json' }))
        this.files = data.files
        this.dispatchEvent(new Event('change'))
      }
    }, changeFile.name, changeFile.text)

    /**
     * Pressed from inside the page rather than with the mouse: the toast the
     * first import raises sits over this row, and with the dialog stubbed there
     * is nothing left here that a real click buys.
     */
    const importFile = async (label = 'Import changes') => {
      await handOver()
      const row = await rowHandle(CHANGES_ROW)
      const pressed = await row.evaluate((el, text) => {
        const button = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === text)
        button?.click()
        return !!button
      }, label)
      assert.ok(pressed, `button "${label}" not found in the changes row`)
    }

    const marks = () => page.evaluate(
      async () => (await browser.storage.local.get('option.workMarks'))['option.workMarks'],
    )
    const reportLine = async () => (await rowHandle(CHANGES_ROW)).evaluate(el => el.textContent ?? '')

    // Nothing here knows about work 11 yet: the mark was made in a file, on
    // another origin, with no extension under it.
    assert.equal((await marks()).marks.boring.items, '')

    await importFile()
    await until('the mark to arrive', async () => (await marks()).marks.boring.items !== '')

    // Both halves. The mark is in this device's table…
    const table = await marks()
    assert.notEqual(table.marks.boring.items, '')
    assert.equal(table.marks.read.items, '', 'a specific verdict is not also plain read')

    // …and AO3 has been asked to take the work off Marked for Later, with the
    // token this page had to go and fetch, having no AO3 document to read one
    // out of.
    assert.deepEqual(marked.map(entry => entry.workId), ['11'])
    assert.equal(marked[0].method, 'POST')
    assert.match(marked[0].body, /_method=patch/)
    assert.match(marked[0].body, /authenticity_token=a-token/)

    assert.match(await reportLine(), /applied 1 · 1 marked read on AO3/)

    // What the second import reads, and the only thing that makes it free.
    const ledger = await page.evaluate(
      async () => (await browser.storage.local.get('cache.appliedChangeOps'))['cache.appliedChangeOps'],
    )
    assert.equal(ledger.length, 1)

    await importFile()
    await until('the second import to report', async () => /already applied/.test(await reportLine()))
    assert.match(await reportLine(), /applied 0 · 1 already applied/)
    assert.deepEqual(marked.map(entry => entry.workId), ['11'], 'AO3 is not asked twice')
  })

  /**
   * Removing a list asks first, and takes only the list.
   *
   * The work text is the expensive half — hours of requests against AO3, and
   * keyed by work rather than by list, so another list may be reading the same
   * copies. Deleting a row must leave every one of them alone.
   */
  test('the trash asks before it removes the list, and keeps the work text', async () => {
    /** The row's last button is the trash; its name is the only one that varies. */
    const trash = async () => {
      const row = await rowHandle(LABEL)
      const handle = (await row.evaluateHandle(
        el => [...el.querySelectorAll('button')].find(b => b.textContent.includes('Remove ')) ?? null,
      )).asElement()
      assert.ok(handle, 'the row should offer to remove itself')
      return handle
    }

    const dialogText = () => page.evaluate(
      () => document.querySelector('[role="dialog"]')?.textContent ?? '',
    )
    const clickDialog = label => page.evaluate((text) => {
      const button = [...document.querySelectorAll('[role="dialog"] button')]
        .find(b => b.textContent.trim() === text)
      button?.click()
      return !!button
    }, label)

    // Cancelling leaves it exactly as it was.
    await (await trash()).click()
    await until('the confirmation', async () => (await dialogText()).includes('Remove this list?'))
    assert.match(await dialogText(), /Marked for Later — tester/)
    // It says what it will not touch, which is the part that costs.
    assert.match(await dialogText(), /cached work|Work text is held per work/i)
    assert.ok(await clickDialog('Cancel'))
    await until('the dialog to close', async () => !(await dialogText()))
    assert.ok(await page.evaluate(async () => {
      const lists = (await browser.storage.local.get('cache.searchLists'))['cache.searchLists']
      return 'marked-for-later:tester' in lists
    }), 'cancelling must not remove anything')

    // Confirming removes the list, and only the list.
    const textBefore = await page.evaluate(async () => (await browser.storage.local.get('workTextIndex')).workTextIndex)
    await (await trash()).click()
    await until('the confirmation again', async () => (await dialogText()).includes('Remove this list?'))
    assert.ok(await clickDialog('Remove list'))

    await until('the row to go', async () => {
      const titles = await page.evaluate(
        () => [...document.querySelectorAll('label span')].map(el => el.textContent.trim()),
      )
      return !titles.includes(LABEL)
    })
    const snapshots = await page.evaluate(
      async () => (await browser.storage.local.get('cache.searchLists'))['cache.searchLists'],
    )
    assert.deepEqual(Object.keys(snapshots), ['marked-for-later:olduser'], 'only the row asked for goes')

    const textAfter = await page.evaluate(async () => (await browser.storage.local.get('workTextIndex')).workTextIndex)
    assert.deepEqual(Object.keys(textAfter).sort(), Object.keys(textBefore).sort())
    assert.equal(Object.keys(textAfter).length, 3)
  })

  /**
   * The other half of that promise, and the only way back from it.
   *
   * Keeping a list's work text when the list goes is right — it is hours of
   * requests, and another list may want it — but it means a deleted list leaves
   * works behind that nothing points at, and until this row there was no way to
   * reclaim them short of deleting every cached work. The test that runs before
   * this one is what strands them: the list that held 11, 12 and 13 is gone, and
   * the only snapshot left holds work 21, which was never cached.
   */
  test('what the deleted list stranded can be discarded on its own', async () => {
    const cacheRow = () => rowHandle(CACHE_ROW).then(el => el.evaluate(node => node.textContent ?? ''))

    /**
     * The row's first button is the discard, and everything about it that this
     * test needs is on the button itself: whether it is offered at all, and what
     * pressing it does to storage. The wording around it — how the subtitle
     * counts the orphans, what the confirmation says — is copy, and pinning a
     * test to copy makes every rewrite a failing build.
     */
    const discard = async () => {
      const row = await rowHandle(CACHE_ROW)
      const label = await row.evaluate((el) => {
        const button = el.querySelector('button')
        if (!button || button.disabled)
          return null
        button.click()
        return button.textContent.trim()
      })
      assert.ok(label, 'the cache row should be offering an enabled discard button')
      return label
    }

    const offered = () => rowHandle(CACHE_ROW).then(el => el.evaluate(node => !node.querySelector('button')?.disabled))

    // Enabled only once the row has counted what the deleted list stranded.
    await until('the row to offer the discard', offered)
    assert.match(await cacheRow(), /orphan/i, 'and to say what it is offering to remove')

    /**
     * Twice, like its neighbour — the first press turns the label into a
     * confirmation. Pressed from inside the page for the reason the change
     * import is: the toast the list removal raised sits over this row, and a
     * real click lands on the toast instead of the button.
     */
    const asked = await discard()
    await until('the confirmation', async () => (await cacheRow()).includes('3'))
    const confirmed = await discard()
    assert.notEqual(confirmed, asked, 'the second press should be a different offer from the first')

    await until('the cache to empty', async () => {
      const store = await page.evaluate(async () => (await browser.storage.local.get('workTextIndex')).workTextIndex)
      return !store || !Object.keys(store).length
    })
    const left = await page.evaluate(async () => {
      const store = await browser.storage.local.get(null)
      return {
        index: store.workTextIndex,
        texts: Object.keys(store).filter(key => key.startsWith('workText.')),
        lists: Object.keys(store['cache.searchLists']),
      }
    })
    assert.deepEqual(left.index, {})
    assert.deepEqual(left.texts, [], 'the text goes with the index entry')
    assert.deepEqual(left.lists, ['marked-for-later:olduser'], 'the list that is left is untouched')

    // Nothing to offer any more, which is the other half of the button's state.
    await until('the discard to switch itself off', async () => !(await offered()))
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(problems, [])
  })
})
