import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
        // `host_permissions` is privileged rather than cross-site — but this
        // page is served from plain localhost with no extension behind it, so
        // the stub has to grant what the browser would otherwise have skipped
        // asking for.
        headers: { 'access-control-allow-origin': '*' },
        // The refresh adds a third work, so the second run has something to fetch.
        body: workId ? workPage(workId) : listingPage([11, 12, 13]),
      })
    })
    page.on('console', m => m.type() === 'error' && problems.push(m.text()))
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

  test('"Download site" refreshes, caches and writes one HTML file', async () => {
    await clickIn(LABEL, 'Download site')
    await until('the download to be handed over', () => page.evaluate(() => window.__downloads.length > 0), 40000)

    const { name, html, data } = await lastDownload()
    assert.match(name, /^AO3-Enhancements-site_marked-for-later-tester_\d{4}-\d{2}-\d{2}_[\d-]{8}\.html$/)
    assert.match(html, /^<!doctype html>/)
    assert.equal(data.v, 2)
    assert.equal(data.works.length, 3)
    // Everything the page needs is inside it — no fetch, no second file.
    assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/)
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

  /**
   * The export, opened the way a reader opens it: one file, straight off disk,
   * with no server and nothing else beside it. This is the whole promise of the
   * single-file format, and a `file://` load is the only thing that proves it —
   * everything above only ever inspected the bytes.
   */
  test('the exported file works on its own, from file://', async () => {
    const { html } = await lastDownload()
    const dir = mkdtempSync(join(tmpdir(), 'ao3e-site-'))
    const path = join(dir, 'library.html')
    writeFileSync(path, html)

    const reader = await browser.newPage()
    const errors = []
    reader.on('console', m => m.type() === 'error' && errors.push(m.text()))
    reader.on('pageerror', e => errors.push(e.message))
    try {
      await reader.goto(`file://${path.replace(/\\/g, '/')}`, { waitUntil: 'load' })
      await reader.waitForSelector('#ao3e-works li', { timeout: 15000 })

      // The inert shell was replaced, so the scripts ran.
      assert.doesNotMatch(await reader.content(), /This page needs JavaScript, and none is running/)
      assert.equal(await reader.$$eval('#ao3e-works > li', els => els.length), 3)
      assert.match(await reader.$eval('#ao3e-shown', el => el.textContent), /^3 works/)

      // A work this file carries opens in the page; the tag beside it still
      // points at the archive.
      assert.equal(
        await reader.$eval('#ao3e-works > li h4 a', el => el.getAttribute('href')),
        '#work/11',
      )
      assert.match(
        await reader.$eval('#ao3e-works > li .tags a', el => el.getAttribute('href')),
        /^https:\/\/archiveofourown\.org\//,
      )

      // Hash routing, and the work unpacked on demand.
      await reader.click('#ao3e-works > li h4 a')
      await reader.waitForFunction(() => document.querySelector('#ao3e-body .ao3e-work') !== null, { timeout: 10000 })
      const text = await reader.$eval('#ao3e-body', el => el.textContent)
      assert.match(text, /The rewritten text of work 11\./)
      assert.equal(await reader.$eval('#ao3e-list', el => el.hidden), true)

      // Back to the list, and the filter narrows it.
      await reader.click('#ao3e-reader .ao3e-site-nav a')
      await reader.waitForFunction(() => !document.getElementById('ao3e-list').hidden)
      await reader.type('#ao3e-filter', 'Work number 12')
      await reader.waitForFunction(() => document.querySelectorAll('#ao3e-works > li').length === 1)

      assert.deepEqual(errors, [], 'the exported page should not need anything it does not carry')
    }
    finally {
      await reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(problems, [])
  })
})
