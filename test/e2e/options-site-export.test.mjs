import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'
import { describeTextSearch } from '../../src/content_script/searchView/textSearch.ts'
import { SITE_SHELL_ID } from '../../src/content_script/siteExport/payload.ts'
import { formatBytes } from '../../src/options_ui/model/buckets.ts'
import { CONFIRM_MS } from '../../src/options_ui/model/confirmInPlace.ts'
import { jobVerb } from '../../src/options_ui/model/jobView.ts'
import { PROFILE_LISTS } from '../../src/options_ui/model/profileLists.ts'
import { blurbsOnRemove, COPY_REMOVAL, NEEDS_VISIT_NOTE, OFFLINE_OFF } from '../../src/options_ui/model/savedListRows.ts'
import { serveDir, storedListIds, storedLists } from './helpers.mjs'
import { captureDownloads, figures, mentions, skip, stubArchive as standInForArchive, startOptions, until } from './optionsPage.mjs'

const ARCHIVE = 'https://archiveofourown.org'
const CACHE_KEY = 'marked-for-later:tester'
const OLD_KEY = 'marked-for-later:olduser'
const LABEL = 'Marked for Later — tester'
/** The row under Saved lists of a stored list no saved list is at. */
const copyRow = key => `copy:${key}`
/** The reader's own Marked for Later, a tile of its own under User profile lists. */
const TILE = 'marked-for-later'
/** The one row that isn't about a list: the way changes made in a file get back. */
const CHANGES_ROW = 'offline-reading-changes-made-in-an-export'
const CACHE_ROW = 'offline-reading-cached-work-text'
const PRUNE_ROW = 'offline-reading-discard-unneeded-blurbs-automatically'
/** What a caching job is said to be doing. */
const CACHING = jobVerb({ phase: 'caching' })

/**
 * The control is off, and says why in its tooltip and in what describes it:
 * `reason`, or a reason that names it.
 */
async function saysOff(options, control, reason) {
  assert.equal(await control.evaluate(el => el.disabled), true, `${await control.evaluate(el => el.dataset.action)} should be off`)
  assert.ok(mentions(await control.evaluate(el => el.title), reason), `the tooltip should give ${reason}`)
  assert.ok(mentions(await options.description(control), reason), `the description should give ${reason}`)
}

/** The control is on, with no reason to give. */
async function saysOn(control) {
  assert.equal(await control.evaluate(el => el.disabled), false, `${await control.evaluate(el => el.dataset.action)} should be on`)
  assert.equal(await control.evaluate(el => el.getAttribute('aria-describedby')), null)
}

/** Whether a control that asks a second time is asking now. */
const armed = control => control.evaluate(el => el.hasAttribute('data-armed'))

/**
 * The site export, driven end to end from Lists: the reader's Marked for
 * Later, the caching job that fetches its works from a stubbed AO3, the
 * refresh that re-scrapes the list itself, and the file a download writes.
 *
 * The job runner needs a DOM, `browser.storage` and a network, so it can't be
 * reached from a `node --test` unit test the way the staleness ladder
 * underneath it can.
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
    [OLD_KEY]: {
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

describe('options UI — site export', { skip }, () => {
  let session
  let browser
  let options
  let page
  /** What the row was showing while it sat out the stub's 429, and the state its job line was in. */
  let waitLine = ''
  let waitState = null
  /** Works the stub was asked to take off Marked for Later, and what was posted. */
  const marked = []
  /** The change file the exported page handed back, once it has handed one back. */
  let changeFile = null

  /** AO3, as far as the options page can see it. */
  const stubArchive = async (page) => {
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
  }

  before(async () => {
    session = await startOptions()
    browser = session.browser
    options = await session.open({
      seed: SEED,
      hash: '#saved-lists',
      prepare: async (page) => {
        await stubArchive(page)
        await page.evaluateOnNewDocument(captureDownloads)
      },
    })
    page = options.page
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The reader's Marked for Later's tile. */
  const tile = () => options.tile(TILE)

  /** Press the control on the tile that does `action`. */
  const pressInTile = async (action) => {
    await options.press(await options.action(await tile(), action))
  }

  const lastWrite = key => options.lastWrite(key)

  /** Everything the tile says: its name, its figures and whatever sits under it. */
  const tileText = async () => options.text(await tile())
  /** A figure the tile shows. */
  const figure = part => options.tileFigure(TILE, part)

  /** Open the tile's More menu from the keyboard, and press the item that does `action`. */
  async function pressInMore(action) {
    const more = await options.action(await tile(), 'more')
    await more.focus()
    await page.keyboard.press('Enter')
    await until('the menu to open', async () => (await options.controls(page, 'menuitem')).length > 0)
    await options.press(await options.menuItem(action))
  }

  test('the reader\'s Marked for Later is a tile, read out from the snapshot and the cache, and a list stored before descriptors a row', async () => {
    await until('the tile to read its copy', async () => await figure('count') === '2')
    assert.equal(await figure('cached'), '0')
    assert.equal(await figure('size'), formatBytes(0))
    assert.equal(await figure('uncached'), '2')
    assert.deepEqual(await options.savedListIds(), [copyRow(OLD_KEY)])
  })

  /**
   * Every list says where it actually is, because "go and open it on AO3" is a
   * real instruction here — it is the only thing that makes a list refreshable
   * from this page.
   */
  test('each list links to itself on AO3, descriptor or not', async () => {
    const link = handle => handle.evaluate(el => ({
      href: el.getAttribute('href'),
      target: el.getAttribute('target'),
    }))

    const stored = await link(await options.control(await tile(), 'link'))
    assert.equal(stored.href, `${ARCHIVE}/users/tester/readings?show=to-read#ao3e-open=marked-for-later`)
    // A new tab: the point is to come back here and press Refresh afterwards.
    assert.equal(stored.target, '_blank')

    // The v1 row has no descriptor to read an address out of, so it is rebuilt
    // from the cache key — and this is the row that most needs it, since opening
    // the list is the only way to make its buttons work again.
    const old = await link(await options.action(await options.savedList(copyRow(OLD_KEY)), 'open'))
    assert.equal(old.href, `${ARCHIVE}/users/olduser/readings?show=to-read`)
    assert.equal(old.target, '_blank')
  })

  test('"Cache works" fetches and stores each work\'s sanitized text', async () => {
    // Work 12 is refused once with `Retry-After: 3` (see `rateLimitOnce`), so
    // there is a window in which the tile has to be counting down rather than
    // sitting mute. It only exists while the run is in it, so the page itself
    // watches the tile from before the press, and keeps what it first says
    // of the wait.
    await page.evaluate((id) => {
      const look = () => {
        const line = document.querySelector(`[data-tile="${id}"] [data-job-state="waiting"]`)
        if (!line)
          return false
        window.__waitSeen = { text: line.textContent.replace(/\s+/g, ' ').trim(), state: { state: line.dataset.jobState, wait: line.dataset.jobWait ?? null } }
        return true
      }
      const watch = new MutationObserver(() => look() && watch.disconnect())
      watch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    }, TILE)
    await pressInTile('cache')

    await page.waitForFunction(() => window.__waitSeen)
    ;({ text: waitLine, state: waitState } = await page.evaluate(() => window.__waitSeen))

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
    // a hang, so the tile says why it is quiet and how long for — and that it
    // is AO3 refusing us, not the extension pacing itself.
    assert.ok(mentions(waitLine, WAIT_WORDS.refused), waitLine)
    assert.match(waitLine, /\b\d+s|\b\d+:\d\d/, 'and how long for')
    assert.deepEqual(waitState, { state: 'waiting', wait: 'refused' })

    const index = await lastWrite('workTextIndex')
    assert.ok(index['12'].size > 0, 'the work was fetched after the wait')
    assert.equal(index['12'].failure, undefined, 'and nothing was held against it')
    // No failure recorded means no backoff earned: the next run treats it as an
    // ordinary cached work rather than one to be retried. Checked on every index
    // the run wrote, since a success afterwards would wipe the count from the
    // last one.
    const attempts = await page.evaluate(() => window.__writes
      .filter(w => 'workTextIndex' in w)
      .map(w => w.workTextIndex['12']?.attempts)
      .filter(n => n !== undefined))
    assert.deepEqual(attempts, [], 'the wait never counted as a failed attempt')

    const job = await options.stored('siteExportJob')
    assert.equal(job?.errorCount ?? 0, 0, 'a rate limit is not a work that could not be fetched')
    assert.equal(job?.blocked, undefined, 'and the run was not stopped by it')
  })

  test('the run finishes, clearing the job and updating the tile', async () => {
    await until('the job record to be cleared', async () => await options.stored('siteExportJob') === null)
    await until('the tile to count what was cached', async () => await figure('cached') === '2')
    assert.equal(await figure('uncached'), null)
  })

  test('"Refresh list" re-scrapes the listing and its saved-work index', async () => {
    await pressInTile('refresh')
    await until('the snapshot to be rewritten', async () => {
      const lists = await lastWrite('cache.searchLists')
      return storedListIds(lists?.[CACHE_KEY]).length === 3
    })
    // Marked for Later owns a side table, and a refresh has to carry it along.
    const marked = await lastWrite('cache.markedForLater')
    assert.equal(marked.userId, 'tester')
    assert.ok(marked.ids.length > 0)

    await until('the tile to count the refreshed list', async () => await figure('count') === '3')
    assert.equal(await figure('uncached'), '1')
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

  test('"Download Offline Copy" refreshes, caches and writes one HTML file', async () => {
    await pressInTile('download')
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
    const shell = new RegExp(`<div id="${SITE_SHELL_ID}" class="ao3e-site-inert">([\\s\\S]*?)</div>`).exec(html)
    assert.ok(shell, 'the file starts inert')
    assert.ok(shell[1].replace(/<[^>]+>/g, '').trim(), 'and says so')
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

    await pressInMore('download-cached')

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
      assert.equal(await reader.$eval(`#${SITE_SHELL_ID}`, el => el.classList.contains('ao3e-site-inert')), false)
      assert.equal(await reader.$$eval('.AO3E--search-view--results > li', els => els.length), 3)
      assert.match(await reader.$eval('.AO3E--search-view--count', el => el.textContent), /\b3\b/)

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
   * The copies a file carries are searchable from it, as text: a phrase that is
   * in one work's body and in no blurb, so the view's own search box could never
   * have found it.
   */
  test('the saved works\' text can be searched from the file', async () => {
    const { html } = await lastDownload()
    const dir = writeExport(html, 'library.html')

    const reader = await browser.newPage()
    const errors = []
    reader.on('console', m => m.type() === 'error' && errors.push(m.text()))
    reader.on('pageerror', e => errors.push(e.message))
    const VISIBLE = '.AO3E--search-view--results > li:not(.AO3E--search-view--hidden)'
    const visibleIds = () => reader.$$eval(VISIBLE, els => els.map(el => el.id))
    const statusLine = () => reader.$eval('.AO3E--search-view--text-status', el => el.textContent)
    /** What the line under the box says before a search, and once one has found `hits` of the three works. */
    const IDLE = describeTextSearch({ kind: 'idle', searchable: 3, total: 3 })
    const found = hits => describeTextSearch({ kind: 'done', hits, searched: 3, unavailable: 0 })
    try {
      await reader.goto(fileUrl(dir, 'library.html'), { waitUntil: 'load' })
      await reader.waitForSelector('.AO3E--search-view--results > li', { timeout: 15000 })
      assert.equal(await statusLine(), IDLE)

      await reader.type('.AO3E--search-view--text-input', '"of work 12"')
      await reader.keyboard.press('Enter')
      await reader.waitForFunction(
        sel => document.querySelectorAll(sel).length === 1,
        { timeout: 10000 },
        VISIBLE,
      )
      assert.deepEqual(await visibleIds(), ['work_12'])
      assert.equal(await statusLine(), found(1))

      // Why it matched, cut from the work's own text with the match marked.
      await reader.waitForSelector('#work_12 .AO3E--search-view--snippet mark', { timeout: 10000 })
      assert.equal(await reader.$eval('#work_12 .AO3E--search-view--snippet mark', el => el.textContent), 'of work 12')
      assert.match(await reader.$eval('#work_12 .AO3E--search-view--snippet', el => el.textContent), /The rewritten text of work 12\./)

      // Any settings change rebuilds the view — a mark does it too — and the
      // search has to come through that with the box still saying what it found.
      await reader.evaluate(() => {
        document.querySelector('.AO3E--search-view').dataset.testOld = ''
        return browser.storage.local.set({ 'option.searchPerPage': 20 })
      })
      await reader.waitForFunction(
        () => {
          const view = document.querySelector('.AO3E--search-view')
          return view && !('testOld' in view.dataset)
        },
        { timeout: 10000 },
      )
      assert.equal(await reader.$eval('.AO3E--search-view--text-input', el => el.value), '"of work 12"')
      assert.deepEqual(await visibleIds(), ['work_12'])
      await reader.waitForSelector('#work_12 .AO3E--search-view--snippet mark', { timeout: 10000 })

      // Every work's body has the word; no blurb does.
      await reader.click('.AO3E--search-view--text-input', { count: 3 })
      await reader.type('.AO3E--search-view--text-input', 'rewritten')
      await reader.waitForFunction(sel => document.querySelectorAll(sel).length === 3, { timeout: 10000 }, VISIBLE)
      await reader.waitForFunction(text => document.querySelector('.AO3E--search-view--text-status').textContent === text, {}, found(3))
      assert.equal(await reader.$$eval('.AO3E--search-view--snippet mark', els => els.length), 3)

      // Emptying the box takes the search away, and its excerpts with it.
      await reader.click('.AO3E--search-view--text-input', { count: 3 })
      await reader.keyboard.press('Backspace')
      await reader.waitForFunction(() => document.querySelectorAll('.AO3E--search-view--snippet').length === 0, { timeout: 10000 })
      assert.equal(await statusLine(), IDLE)

      // Something no work's text holds leaves nothing showing.
      await reader.type('.AO3E--search-view--text-input', 'dragon')
      await reader.waitForFunction(sel => document.querySelectorAll(sel).length === 0, { timeout: 10000 }, VISIBLE)
      assert.equal(await statusLine(), found(0))

      assert.deepEqual(errors, [])
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
      shown: !el.querySelector('.AO3E--site--status-pending').hidden,
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
      assert.equal(before.shown, false, 'nothing is said to be waiting')
      assert.ok(await reader.$('.AO3E--site--status-export'), 'the panel should offer the way out')

      // Right-click a work and mark it — the extension's own work menu, running
      // in a file with no extension under it.
      await reader.evaluate(() => {
        const link = document.querySelector('.AO3E--search-view--results > li h4.heading a[href*="/works/"]')
        link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
      })
      await reader.waitForSelector('.AO3E--menu .AO3E--menu--item', { timeout: 5000 })
      assert.ok(await reader.evaluate((label) => {
        const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
          .find(el => el.textContent.toLowerCase().includes(label.toLowerCase()))
        row?.click()
        return !!row
      }, SEED['option.workMarks'].marks.boring.label), 'the work menu should offer the marks that travelled with the export')

      await until('the change to be counted', async () => (await pending()).count === '1')
      assert.equal((await pending()).shown, true, 'and said to be waiting')

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
      assert.ok(mentions(await reader.$eval('.AO3E--site--status', el => el.textContent), handed.name), 'the panel names the file it saved')

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
    const importFile = async () => {
      await handOver()
      await options.press(await options.action(await options.row(CHANGES_ROW), 'import'))
    }

    const marks = () => options.stored('option.workMarks')
    /** The figures the row reports the last import by, smallest first. */
    const reported = async () => {
      const summary = await (await options.row(CHANGES_ROW)).$('[data-change-summary]')
      return summary ? figures(await options.text(summary)) : []
    }

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

    await until('the import to report', async () => (await reported()).length > 0)
    assert.deepEqual(await reported(), [1, 1], 'one applied, and one marked read on AO3')

    // What the second import reads, and the only thing that makes it free.
    const ledger = await options.stored('cache.appliedChangeOps')
    assert.equal(ledger.length, 1)

    await importFile()
    await until('the second import to report', async () => (await reported()).join() === '0,1')
    assert.deepEqual(marked.map(entry => entry.workId), ['11'], 'AO3 is not asked twice')
  })

  /**
   * Removing an offline copy asks first, in its own place, and takes only the
   * copy.
   *
   * The work text is the expensive half — hours of requests against AO3, and
   * keyed by work rather than by list, so another list may be reading the same
   * copies. Removing a copy must leave every one of them alone. Its blurbs go
   * at once only while *Discard unneeded blurbs automatically* is on, and the
   * row says which beside its Remove, and the tile in its menu.
   */
  test('removing asks first, says what becomes of the blurbs, and keeps the work text', async () => {
    const old = await options.savedListDetails(copyRow(OLD_KEY))
    const removeOld = await options.action(old, 'remove-copy')
    const says = async () => options.text(old)
    assert.ok(mentions(await says(), blurbsOnRemove(false)), 'the blurbs wait for Discard orphans')

    // An armed Remove that isn't pressed again goes back to asking nothing.
    await options.press(removeOld)
    await until('it to ask', () => armed(removeOld))
    await until('it to stop asking', async () => !(await armed(removeOld)), CONFIRM_MS * 4)
    assert.ok(OLD_KEY in await options.stored('cache.searchLists'), 'asking must not remove anything')

    // With Discard unneeded blurbs automatically on, it says they go now.
    const prune = async () => options.control(await options.row(PRUNE_ROW), 'switch')
    await options.press(await prune())
    await until('blurbs to be discarded automatically', async () => await lastWrite('option.pruneOrphanedBlurbs') === true)
    await until('the row to say the blurbs go now', async () => mentions(await says(), blurbsOnRemove(true)))
    await options.press(await prune())
    await until('blurbs to wait for Discard orphans again', async () => await lastWrite('option.pruneOrphanedBlurbs') === false)

    // The tile's first press arms Remove, which says what it keeps, and
    // removes nothing; the second removes the copy, and only the copy.
    await pressInMore('remove')
    const remove = await options.menuItem('remove')
    await until('the first press to arm it', () => armed(remove))
    assert.ok(mentions(await options.name(remove), blurbsOnRemove(false)), 'the blurbs wait for Discard orphans')
    assert.ok(CACHE_KEY in await options.stored('cache.searchLists'), 'arming must not remove anything')

    const textBefore = await options.stored('workTextIndex')
    await options.press(remove)
    await until('the copy to go', async () => !(CACHE_KEY in await options.stored('cache.searchLists')))
    const snapshots = await options.stored('cache.searchLists')
    assert.deepEqual(Object.keys(snapshots), [OLD_KEY], 'only the copy asked for goes')
    await until('the tile to say how a copy is kept', async () => mentions(await tileText(), PROFILE_LISTS.find(list => list.id === TILE).empty))

    const textAfter = await options.stored('workTextIndex')
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
    /**
     * The row's first button is the discard, and everything about it that this
     * test needs is on the button itself: whether it is offered at all, and what
     * pressing it does to storage. The wording around it — how the subtitle
     * counts the orphans, what the confirmation says — is copy, and pinning a
     * test to copy makes every rewrite a failing build.
     */
    const discardButton = async () => options.action(await options.row(CACHE_ROW), 'discard-orphans')

    const offered = async () => !(await (await discardButton()).evaluate(button => button.disabled))

    /** Press the discard. */
    const discard = async () => {
      const button = await discardButton()
      assert.ok(await offered(), 'the cache row should be offering an enabled discard button')
      await options.press(button)
    }

    // Enabled only once the row has counted what the deleted list stranded.
    await until('the row to offer the discard', offered)

    /**
     * Twice, like its neighbour — the first press turns the label into a
     * confirmation. Pressed from inside the page for the reason the change
     * import is: the toast the list removal raised sits over this row, and a
     * real click lands on the toast instead of the button.
     */
    await discard()
    await until('the confirmation', async () => armed(await discardButton()))
    await discard()

    await until('the cache to empty', async () => {
      const store = await options.stored('workTextIndex')
      return !store || !Object.keys(store).length
    })
    const left = await page.evaluate(async () => {
      const store = await window.browser.storage.local.get(null)
      return {
        index: store.workTextIndex,
        texts: Object.keys(store).filter(key => key.startsWith('workText.')),
        lists: Object.keys(store['cache.searchLists']),
      }
    })
    assert.deepEqual(left.index, {})
    assert.deepEqual(left.texts, [], 'the text goes with the index entry')
    assert.deepEqual(left.lists, [OLD_KEY], 'the list that is left is untouched')

    // Nothing to offer any more, which is the other half of the button's state.
    await until('the discard to switch itself off', async () => !(await offered()))
  })

  test('nothing threw along the way', () => {
    // Chrome logs every non-2xx response as a console error of its own. The one
    // 429 the stub serves on purpose is the subject of a test, not a fault.
    assert.deepEqual(options.problems(/status of 429/), [])
  })
})

/**
 * One job at a time, for the whole extension, and every control the job turns
 * off says why: the other lists' refresh, cache and download, removing the
 * job's own list's copy, and the cache's two deletions. A list saved before it
 * could be fetched again says why its controls are off too. The job shows in
 * its row, its Download becomes Pause and Cancel; in the saved lists' header; and on the
 * rail.
 *
 * The stand-in for AO3 holds every work page until the last test lets them go,
 * so the job is caught running for as long as a test needs it to be, and its
 * Pause, Continue and Discard are each seen in the stored job.
 */
describe('options UI — site export, one job at a time', { skip }, () => {
  const MINE = 'marked-for-later:reader'
  const OTHER = 'tag-works:Coffee%20Shop%20AU'
  /** Stored before descriptors existed: nothing here can fetch it again. */
  const UNDESCRIBED = 'tag-works:Old%20Tag'
  /** What the list the job is on is called, which every control the job turns off names. */
  const HOLDER = 'Marked for Later'
  /** The rows of the three stored lists, none of which a saved list is at. */
  const ROWS = { [MINE]: copyRow(MINE), [OTHER]: copyRow(OTHER), [UNDESCRIBED]: copyRow(UNDESCRIBED) }
  const HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000

  const seed = {
    // The reader is someone else, so this Marked for Later is another
    // account's, and a row like the others rather than the reader's own tile.
    'option.user': { userId: 'someone' },
    ...storedLists({
      [MINE]: {
        scrapedAt: HOURS_AGO,
        blurbsHtml: [blurb(31, 'Work number 31'), blurb(32, 'Work number 32')],
        descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later', listUrl: `${ARCHIVE}/users/reader/readings?show=to-read` },
      },
      [OTHER]: {
        scrapedAt: HOURS_AGO,
        blurbsHtml: [blurb(41, 'Work number 41')],
        descriptor: { sourceId: 'tag-works', label: 'Coffee Shop AU', listUrl: `${ARCHIVE}/tags/Coffee%20Shop%20AU/works` },
      },
      [UNDESCRIBED]: { scrapedAt: HOURS_AGO, blurbsHtml: [blurb(51, 'Work number 51')] },
    }),
    // A cached work no list holds, so the cache's two deletions both have
    // something to offer while no job runs.
    'workTextIndex': { 99: { size: 120, updatedAt: 0, chapters: 1, words: 100, fetchedAt: HOURS_AGO, v: 1 } },
  }

  let session
  let options
  let page
  let release
  /** Every work page waits on this. */
  const held = new Promise((resolve) => {
    release = resolve
  })
  let releaseOther
  /** The other list's work waits on this as well, so a job on it is caught running after the rest are let go. */
  const otherHeld = new Promise((resolve) => {
    releaseOther = resolve
  })

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed,
      hash: '#saved-lists',
      prepare: async (p) => {
        await p.evaluateOnNewDocument(captureDownloads)
        await standInForArchive(p, async (url) => {
          const { pathname } = new URL(url)
          // The reader's Marked for Later, for a refresh to read.
          if (pathname === '/users/reader/readings')
            return { body: listingPage([31, 32]) }
          const workId = /^\/works\/(\d+)$/.exec(pathname)?.[1]
          if (!workId)
            return { status: 404 }
          await held
          if (workId === '41')
            await otherHeld
          return { body: workPage(workId) }
        })
      },
    })
    page = options.page
  }, { timeout: 180000 })

  after(() => {
    release()
    releaseOther()
    return session?.close()
  })

  const row = key => options.savedList(ROWS[key])
  /** A control on a row, its details opened first: in its `details`, or in its `actions`, beside it. */
  const button = async (key, action, part = 'details') => options.action(await (await options.savedListDetails(ROWS[key])).$(`[data-saved-list-part="${part}"]`), action)
  /** A control on a row wherever it is: the job's own, under it. */
  const inRow = async (key, action) => options.action(await row(key), action)
  const cacheButton = async action => options.action(await options.row(CACHE_ROW), action)
  const jobState = async key => (await row(key)).evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)
  const jobWrites = () => page.evaluate(() => window.__writes.filter(w => 'siteExportJob' in w).length)
  /** What a row's Caching cell says. */
  const caching = async key => options.text(await (await row(key)).$('[data-saved-list-part="caching"]'))
  /** The notice over every row while a job runs, or null with none. */
  const busy = async () => (await options.list('saved-lists')).$('[data-busy]')

  /** The other list's offline controls, by part and action. */
  const OTHER_CONTROLS = [['actions', 'download'], ['details', 'refresh'], ['details', 'cache'], ['details', 'download']]
  /** The other list's link-like controls, whose tooltip is the reason alone while they are off. */
  const OTHER_LINKS = [['details', 'refresh-first']]

  test('a list saved before it could be fetched again says what brings its controls back', async () => {
    for (const [part, action] of [...OTHER_CONTROLS, ...OTHER_LINKS]) {
      const control = await button(UNDESCRIBED, action, part)
      assert.equal(await control.evaluate(el => el.disabled), true, `${action} should be off`)
      assert.ok(mentions(await control.evaluate(el => el.title), OFFLINE_OFF.undescribed), `${action}'s tooltip should give the reason`)
      assert.ok(mentions(await options.description(control), OFFLINE_OFF.undescribed), `${action}'s description should give the reason`)
    }
    assert.ok(mentions(await options.text(await row(UNDESCRIBED)), NEEDS_VISIT_NOTE), 'the row says what to do')
  })

  test('while one list caches, every other list\'s offline controls name the list that holds the job', async () => {
    await options.press(await button(MINE, 'cache'))
    await until('the job to be running', async () => await jobState(MINE) === 'running')

    for (const [part, action] of OTHER_CONTROLS)
      await saysOff(options, await button(OTHER, action, part), HOLDER)
    for (const [part, action] of OTHER_LINKS) {
      const control = await button(OTHER, action, part)
      assert.equal(await control.evaluate(el => el.disabled), true, `${action} should be off`)
      assert.ok(mentions(await options.description(control), HOLDER), `${action}'s description should name the list with the job`)
    }
    // Said in the row as well, where the reader is looking, and over every row.
    assert.ok(mentions(await options.text(await row(OTHER)), HOLDER), 'the row says which list has the job')
    assert.ok(mentions(await options.text(await busy()), HOLDER), 'and so does the notice over every row')
    // And on the rail, from any category.
    const railJob = await options.page.$eval('[data-rail] [data-rail-job]', el => ({ title: el.title, text: el.textContent.trim() }))
    assert.ok(mentions(railJob.title, HOLDER) && mentions(railJob.title, CACHING), railJob.title)
    assert.match(railJob.text, /\/2$/)
    // Tracking asks AO3 for nothing, so no job turns it off.
    const toggle = await options.control(await row(OTHER), 'switch')
    assert.equal(await toggle.evaluate(el => el.disabled), false)

    // A list nothing can fetch keeps its own reason.
    assert.ok(mentions(await options.description(await button(UNDESCRIBED, 'cache')), OFFLINE_OFF.undescribed))

    // The list the job is on: its Download is Pause, its caching says so, and its copy can't be removed from under it.
    assert.ok(await inRow(MINE, 'pause'))
    assert.ok(mentions(await caching(MINE), CACHING), 'its caching says it is caching now')
    await saysOff(options, await button(MINE, 'remove-copy'), CACHING)

    // Nor can the work text it is writing.
    for (const action of ['discard-orphans', 'delete-cached'])
      await saysOff(options, await cacheButton(action), HOLDER)
  })

  test('Pause leaves the job stored, offering to continue or discard it, and frees every other control', async () => {
    const before = await jobWrites()
    await options.press(await inRow(MINE, 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(MINE) === 'stopped')

    // As written: the storage stand-in keeps the runner's own object, which a
    // running job goes on changing, while a write is copied as it lands.
    const job = await options.lastWrite('siteExportJob')
    assert.equal(job.cacheKey, MINE)
    assert.deepEqual(job.steps, ['caching'])
    assert.deepEqual([...job.queue].sort(), ['31', '32'], 'the works it was fetching go back on the queue')
    assert.equal(job.done, 0)

    await inRow(MINE, 'resume')
    await inRow(MINE, 'discard')
    for (const [part, action] of OTHER_CONTROLS)
      await saysOn(await button(OTHER, action, part))
    assert.ok(!mentions(await options.text(await row(OTHER)), HOLDER), 'the row has no job to name')
    assert.equal(await busy(), null, 'nor is there one over every row')
    assert.equal(await options.page.$('[data-rail] [data-rail-job]'), null, 'and nothing runs on the rail')
    await saysOn(await button(MINE, 'remove-copy'))
    for (const action of ['discard-orphans', 'delete-cached'])
      await saysOn(await cacheButton(action))
  })

  test('Discard throws the stopped job away', async () => {
    await options.press(await inRow(MINE, 'discard'))
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('the row to stop offering it', async () => await jobState(MINE) === null)
    assert.deepEqual(await options.actions(await row(MINE), 'resume'), [])
  })

  test('Continue picks a stopped job up where it left off, and finishing it clears it', async () => {
    await options.press(await button(MINE, 'cache'))
    await until('the job to be running', async () => await jobState(MINE) === 'running')
    const before = await jobWrites()
    await options.press(await inRow(MINE, 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(MINE) === 'stopped')
    const stopped = await options.lastWrite('siteExportJob')

    await options.press(await inRow(MINE, 'resume'))
    await until('the job to run again', async () => await jobState(MINE) === 'running')
    await saysOff(options, await button(OTHER, 'cache'), HOLDER)

    release()
    await until('the finished job to be cleared', async () => await options.stored('siteExportJob') === null)
    await until('the row to say it finished', async () => await jobState(MINE) === 'finished')
    // The job it wrote on its way to the end is the one that stopped, carried on.
    const finished = await options.lastWrite('siteExportJob')
    assert.equal(finished.startedAt, stopped.startedAt)
    assert.deepEqual(finished.steps, [])
    assert.deepEqual(finished.queue, [])
    assert.equal(finished.done, 2)
    const index = await options.stored('workTextIndex')
    assert.ok(index['31']?.size > 0 && index['32']?.size > 0, 'both works were fetched')
    await saysOn(await button(OTHER, 'cache'))
  })

  /**
   * Every way a row starts a job: Download beside it, and in its details
   * Refresh list, Cache works, Download, Refresh the list first and Download
   * without refreshing, each the job with its own steps.
   */
  test('each of a row\'s actions starts its own job', async () => {
    const actions = [
      [() => button(MINE, 'download', 'actions'), ['refreshing', 'caching', 'exporting']],
      [() => button(MINE, 'refresh'), ['refreshing']],
      [() => button(MINE, 'cache'), ['caching']],
      [() => button(MINE, 'download'), ['refreshing', 'caching', 'exporting']],
      [() => button(MINE, 'refresh-first'), ['refreshing', 'caching']],
      [() => button(MINE, 'download-cached'), ['exporting']],
    ]
    for (const [control, steps] of actions) {
      const before = await jobWrites()
      await options.press(await control())
      await until('the job to be written', async () => await jobWrites() > before)
      const job = await page.evaluate(n => window.__writes.filter(w => 'siteExportJob' in w)[n].siteExportJob, before)
      assert.equal(job.cacheKey, MINE)
      assert.deepEqual(job.steps, steps)
      await until('the job to finish', async () => await jobState(MINE) === 'finished' && await options.stored('siteExportJob') === null)
    }
    assert.equal(await page.evaluate(() => window.__downloads.length), 3, 'each Download hands a file over')
  })

  test('removing a copy with a stopped job on it discards the job too', async () => {
    await options.press(await button(OTHER, 'cache'))
    await until('the job to be running', async () => await jobState(OTHER) === 'running')
    const before = await jobWrites()
    await options.press(await inRow(OTHER, 'pause'))
    await until('the stopped job to be written', async () => await jobWrites() > before && await jobState(OTHER) === 'stopped')

    const remove = await button(OTHER, 'remove-copy')
    assert.ok(mentions(await options.text(await row(OTHER)), COPY_REMOVAL.discardsJob), 'it says the job goes with it')
    await options.press(remove)
    await until('it to ask', () => armed(remove))
    await options.press(remove)
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('the copy to go', async () => !(OTHER in await options.stored('cache.searchLists')))
    await until('its row to go', async () => !(await options.savedListIds()).includes(ROWS[OTHER]))
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * One search stored in two sort orders, and a job left stopped on the older:
 * started on it before the newer was stored. The row shows the newer copy, and
 * the job is the row's all the same, since it reads and writes one of the
 * copies the row's removals would take.
 */
describe('options UI — a job on an older sort order of a saved list\'s search', { skip }, () => {
  const NEWER = 'text-search:work_search%5Bquery%5D=latte'
  const OLDER = 'text-search:work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count'
  const OLDER_COPY = {
    scrapedAt: Date.now() - 4 * 60 * 60 * 1000,
    blurbsHtml: [blurb(72, 'Work number 72')],
    descriptor: { sourceId: 'text-search', label: 'Works search — latte', listUrl: `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count` },
  }
  const LIST = 'l4tte'
  const NAME = 'Latte art'

  const seed = {
    'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [] },
    'option.savedLists': { v: 1, lists: { [LIST]: { id: LIST, kind: 'text-search', url: '/works/search?work_search[query]=latte', title: NAME, type: 'search', entity: 'latte' } } },
    ...storedLists({
      [NEWER]: {
        scrapedAt: Date.now() - 60 * 60 * 1000,
        blurbsHtml: [blurb(71, 'Work number 71')],
        descriptor: { sourceId: 'text-search', label: 'Works search — latte', listUrl: `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte` },
      },
      [OLDER]: OLDER_COPY,
    }),
    'siteExportJob': {
      cacheKey: OLDER,
      descriptor: OLDER_COPY.descriptor,
      steps: ['caching'],
      queue: ['72'],
      done: 0,
      total: 1,
      startedAt: Date.now() - 5 * 60 * 60 * 1000,
      updatedAt: Date.now() - 5 * 60 * 60 * 1000,
      errors: [],
      errorCount: 0,
    },
  }

  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed,
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
      // AO3 never answers, so a job runs until it is stopped.
      prepare: p => standInForArchive(p, () => new Promise(() => {})),
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const row = () => options.savedList(LIST)
  const details = () => options.savedListDetails(LIST)
  const jobState = async () => (await row()).evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)
  /** What the row offers beside it. */
  const besideRow = async () => (await row()).$('[data-saved-list-part="actions"]')

  test('stopped, its line is under the row, with Continue and Discard, and removing the copy says it goes too', async () => {
    await until('the row to show the job', async () => await jobState() === 'stopped')
    assert.ok(await options.action(await row(), 'resume'))
    assert.ok(await options.action(await row(), 'discard'))
    assert.deepEqual(await options.actions(await besideRow(), 'download'), [], 'its Download waits on the job')
    assert.ok(mentions(await options.text(await details()), COPY_REMOVAL.discardsJob), 'removing its copy says the job goes too')
  })

  test('running, the row is busy itself: Pause, caching now, and neither removal can take a copy from under it', async () => {
    await options.press(await options.action(await row(), 'resume'))
    await until('the job to run', async () => await jobState() === 'running')
    assert.ok(await options.action(await besideRow(), 'pause'))
    assert.ok(mentions(await options.text(await (await row()).$('[data-saved-list-part="caching"]')), CACHING), 'its caching says it is caching now')
    await saysOff(options, await options.action(await details(), 'cache'), CACHING)

    const removeCopy = await options.action(await details(), 'remove-copy')
    const removeList = await options.action(await details(), 'remove-list')
    await saysOff(options, removeCopy, CACHING)
    await saysOff(options, removeList, CACHING)
    for (const remove of [removeCopy, removeList]) {
      await options.press(remove)
      await options.press(remove)
    }
    await options.saved()
    const stored = await options.stored('cache.searchLists')
    assert.ok(NEWER in stored && OLDER in stored, 'both copies stay')
    assert.ok((await options.stored('option.savedLists')).lists[LIST], 'and so does the list')
    assert.equal(await jobState(), 'running')
  })

  test('stopped again, Remove offline copy takes both copies and the job on the older', async () => {
    await options.press(await options.action(await besideRow(), 'pause'))
    await until('the job to stop', async () => await jobState() === 'stopped')
    const remove = await options.action(await details(), 'remove-copy')
    await options.press(remove)
    await until('it to ask', () => armed(remove))
    await options.press(remove)
    await until('the job to be discarded', async () => await options.stored('siteExportJob') === null)
    await until('both copies to go', async () => {
      const stored = await options.stored('cache.searchLists')
      return !(NEWER in stored) && !(OLDER in stored)
    })
    assert.ok((await options.stored('option.savedLists')).lists[LIST], 'the list stays')
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * A row's job, driven from the keyboard: Download turns into Pause, Pause leaves
 * Continue and Discard in the job's line, and each press takes away the control
 * that was pressed. Focus stays in the row, on the control in its place.
 */
describe('options UI — a saved list\'s job, from the keyboard', { skip }, () => {
  const KEY = 'tag-works:Coffee%20Shop%20AU'
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: storedLists({
        [KEY]: {
          scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
          blurbsHtml: [blurb(61, 'Work number 61')],
          descriptor: { sourceId: 'tag-works', label: 'Coffee Shop AU', listUrl: `${ARCHIVE}/tags/Coffee%20Shop%20AU/works` },
        },
      }),
      hash: '#saved-lists',
      // AO3 never answers, so a job runs until it is stopped.
      prepare: p => standInForArchive(p, () => new Promise(() => {})),
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const row = () => options.savedList(copyRow(KEY))
  const jobState = async () => (await row()).evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState ?? null)
  /** The row's Download, beside it. */
  const downloads = async () => options.actions(await (await row()).$('[data-saved-list-part="actions"]'), 'download')
  /** What has focus now, by what it does: a control of the row's. */
  const focused = () => options.page.evaluate((key) => {
    const el = document.activeElement
    if (!el || el === document.body)
      return 'nothing: the page itself'
    return el.closest(`[data-saved-list="${key}"]`) ? el.dataset.action ?? 'a control that does nothing' : 'something outside the row'
  }, copyRow(KEY))
  async function pressKey(control) {
    await control.focus()
    await options.page.keyboard.press('Enter')
  }

  test('Download hands focus to Pause', async () => {
    await until('the copy to be read', async () => (await downloads()).length === 1)
    await pressKey((await downloads())[0])
    await until('the job to run', async () => await jobState() === 'running')
    assert.equal(await focused(), 'pause')
  })

  test('Pause hands it to the row\'s details, beside the place it left', async () => {
    await options.page.keyboard.press('Enter')
    await until('the job to stop', async () => await jobState() === 'stopped')
    assert.equal(await focused(), 'details')
  })

  test('Continue hands it to Pause', async () => {
    await pressKey(await options.action(await row(), 'resume'))
    await until('the job to run again', async () => await jobState() === 'running')
    assert.equal(await focused(), 'pause')
  })

  test('Discard hands it to Download', async () => {
    await options.page.keyboard.press('Enter')
    await until('the job to stop', async () => await jobState() === 'stopped')
    await pressKey(await options.action(await row(), 'discard'))
    await until('the job to go', async () => await jobState() === null)
    assert.equal(await focused(), 'download')
  })

  test('nothing threw along the way, and no Pause was logged as an error', () => {
    assert.deepEqual(options.problems(), [])
  })
})
