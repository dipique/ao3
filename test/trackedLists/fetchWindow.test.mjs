import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { formatDay, isoDay, listBase } from '../../src/common/trackedLists.ts'
import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * The fetcher that reads a review window out of the archive, driven against a
 * stand-in archive in a real DOM.
 *
 * It needs a DOM (it parses blurbs) but not an extension, so — like the work
 * text sanitizer — the one module is bundled and dropped into a blank page, and
 * `fetch` is replaced with a server that renders listing pages out of a fixture.
 * That server answers `date_from`, `page` and the two heading spellings exactly
 * as the archive does, which is what every assertion here is really about: the
 * window is worked out from *what the pages say*, and it is worked out in a
 * handful of requests however far behind the reader is.
 *
 * The planner's own rules are unit-tested next door and are not re-tested here.
 * What is tested is the half that can only be seen against pages: which requests
 * go out, what is made of the answers, and what comes back.
 */

const skip = skipWithoutChrome

const MS_PER_DAY = 86_400_000
/** A fixed "now", so a fixture's days mean the same thing on every machine. */
const TODAY = Date.UTC(2026, 8, 20) / MS_PER_DAY

let nextWorkId = 4000

/**
 * Works for a fixture, in the order the archive files them: `[filed, count,
 * drift, extra]` rows, each making `count` works filed on that day and dated
 * `drift` days off it (the blurb/archive date drift a real listing has).
 */
function works(rows) {
  const out = []
  for (const [filed, count, drift = 0, extra = {}] of rows) {
    for (let i = 0; i < count; i++)
      out.push({ id: String(nextWorkId++), filed, dateText: formatDay(filed + drift), ...extra })
  }
  return out
}

/** Rows to build works from, or works already built. */
function worksFrom(rows) {
  return Array.isArray(rows[0]) ? works(rows) : rows
}

/**
 * One fixture list: a tracked entry, the works behind it, and the kind of page
 * the stand-in archive serves for it. `key` is how a request finds its way back
 * to the fixture — the tag's name for a search by name, the path otherwise.
 */
function listing(id, rows, over = {}) {
  return {
    entry: { id, kind: 'works-filter', url: `/tags/${id}/works`, alias: id, tracked: true, since: 0, ...over.entry },
    key: `/tags/${id}/works`,
    layout: 'listing',
    works: worksFrom(rows),
    ...over.list,
  }
}

function search(id, rows, over = {}) {
  return {
    entry: { id, kind: 'text-search', url: `/works/search?work_search[query]=${id}`, alias: id, tracked: true, since: 0, ...over.entry },
    key: id,
    layout: 'search',
    works: worksFrom(rows),
    ...over.list,
  }
}

function series(id, rows, over = {}) {
  return {
    entry: { id, kind: 'series-works', url: `/series/${id}`, alias: `Series ${id}`, tracked: true, since: 0, ...over.entry },
    key: `/series/${id}`,
    layout: 'series',
    works: worksFrom(rows),
    ...over.list,
  }
}

/**
 * An uncommon tag. Without `scan` it is read through a works search by the
 * tag's name — which the archive answers under that name, so that is the key —
 * and with it, off the tag's own page, which is keyed by its path like any other.
 */
function uncommonTag(name, rows, { scan = false } = {}) {
  return {
    entry: {
      id: `tag-${name}`,
      kind: 'tag-works',
      url: `/tags/${encodeURIComponent(name)}`,
      alias: name,
      tracked: true,
      since: 0,
      ...(scan ? { scan: true } : {}),
    },
    key: scan ? `/tags/${encodeURIComponent(name)}` : name,
    layout: scan ? 'tag' : 'search',
    works: worksFrom(rows),
  }
}

/** The fixture as the page's stand-in archive takes it. */
function spec(fixtures) {
  return {
    entries: fixtures.map(fixture => fixture.entry),
    lists: Object.fromEntries(fixtures.map(fixture => [fixture.key, {
      layout: fixture.layout,
      works: fixture.works,
      fail: fixture.fail,
      signedOut: fixture.signedOut,
    }])),
  }
}

function withOptions(over = {}) {
  return { ...structuredClone(OPTION_DEFAULTS), ...over }
}

/**
 * Runs in the page. A stand-in archive over `fetch`: it finds the fixture the
 * request is for, applies `date_from` and `page` exactly as the archive does
 * (inclusive whole UTC days, twenty works to a page, oldest first), and renders
 * the answer as the kind of page that query would really be served from —
 * heading count and all, since the heading count is what the fetcher reads its
 * boundaries off.
 *
 * It also puts a movable clock under `Date.now`. The fetch layer paces itself
 * every twenty requests and resets that count after a minute's quiet, so winding
 * the clock on between runs is what stops one test's requests making the next
 * one sit out a breather it hasn't earned.
 */
function installArchive() {
  const DAY = 86_400_000
  const PER_PAGE = 20

  // A blurb is adopted into the live document before it is parsed, so it is
  // *this* page's base that decides what a blurb's `/works/123` link resolves
  // to — and on a blank page, to nothing at all. The archive is where the real
  // thing runs, and a link that won't parse is not a case worth reproducing.
  const base = document.createElement('base')
  base.href = 'https://archiveofourown.org/'
  document.head.append(base)

  const realNow = Date.now
  window.__offset = 0
  Date.now = () => realNow() + window.__offset
  window.__requests = []
  window.__attempts = {}
  window.__spec = { entries: [], lists: {} }

  const keyOf = u => u.searchParams.get('work_search[other_tag_names]')
    ?? u.searchParams.get('work_search[query]')
    ?? u.pathname

  const dayOfIso = iso => iso ? Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY) : null

  const tagLi = name => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(name)}">${name}</a></li>`

  const blurb = w => `<li id="work_${w.id}" class="work blurb group" role="article">`
    + `<div class="header module"><h4 class="heading">`
    + `<a href="/works/${w.id}">Work ${w.id}</a> by `
    + `<a rel="author" href="/users/${w.author || 'someone'}/pseuds/${w.author || 'someone'}">${w.author || 'someone'}</a>`
    + `</h4><h5 class="fandoms heading">Fandoms: <a class="tag" href="/tags/Fandom/works">Fandom</a></h5>`
    + `<p class="datetime">${w.dateText}</p></div>`
    + `<ul class="tags commas">${(w.tags || []).map(tagLi).join('')}</ul>`
    + `<dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>`
    + `<dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl></li>`

  const pagination = pages => pages <= 1
    ? ''
    : `<ol class="pagination actions" role="navigation">${
      Array.from({ length: pages }, (_, i) => `<li><a href="?page=${i + 1}">${i + 1}</a></li>`).join('')
    }<li class="next"><a href="?page=2">Next</a></li></ol>`

  window.__respond = (u) => {
    const key = keyOf(u)
    const list = window.__spec.lists[key]
    if (!list)
      return new Response('<html><body class="logged-in">no such list</body></html>', { status: 404 })
    window.__attempts[key] = (window.__attempts[key] || 0) + 1
    if (list.fail)
      return new Response('boom', { status: 500 })

    const scanned = list.layout === 'tag' || list.layout === 'series'
    const page = Number(u.searchParams.get('page') || '1')
    const from = dayOfIso(u.searchParams.get('work_search[date_from]'))
    const query = scanned || from === null ? list.works.slice() : list.works.filter(w => w.filed >= from)
    if (!scanned)
      query.sort((a, b) => a.filed - b.filed || Number(a.id) - Number(b.id))
    const total = query.length
    const pages = Math.max(1, Math.ceil(total / PER_PAGE))
    const rows = query.slice((page - 1) * PER_PAGE, page * PER_PAGE)
    const blurbs = rows.map(blurb).join('')

    let main
    if (list.layout === 'search') {
      main = `<div id="main" class="works-search region"><h3 class="heading">${total} Found</h3>`
        + `<ol class="work index group">${blurbs}</ol>${pagination(pages)}</div>`
    }
    else if (list.layout === 'series') {
      main = `<div id="main" class="series-show region"><h2 class="heading">A Series</h2>`
        + `<ul class="series work index group">${blurbs}</ul>${pagination(pages)}</div>`
    }
    else if (list.layout === 'tag') {
      main = `<div id="main" class="tags-show region"><div class="tag profile"><p>This tag has not been marked common.</p>`
        + `<div class="work listbox group"><h3 class="heading">Works</h3>${pagination(pages)}`
        + `<ul class="index group">${blurbs}</ul></div></div></div>`
    }
    else {
      const first = (page - 1) * PER_PAGE + 1
      const range = total ? `${first} - ${first + rows.length - 1} of ${total}` : '0'
      main = `<div id="main" class="works-index region">`
        + `<h2 class="heading">${range} Works in <a class="tag" href="/tags/x">X</a></h2>`
        + `<ol class="work index group">${blurbs}</ol>${pagination(pages)}</div>`
    }

    const body = list.signedOut ? 'logged-out' : 'logged-in'
    return new Response(
      `<!DOCTYPE html><html><head><title>t</title></head><body class="${body}">${main}</body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )
  }

  window.fetch = async (url) => {
    const u = new URL(String(url))
    window.__requests.push(u.pathname + u.search)
    return window.__respond(u)
  }
}

/** Runs in the page: one `fetchWindow` call, reported in things a test can read. */
async function runInPage(input) {
  // Far enough on that the fetch layer's own pacing counts as idle and resets,
  // so a run is never slowed by the requests of the run before it.
  window.__offset += 120_000
  window.__spec = input.spec
  window.__requests = []
  window.__attempts = {}
  if (!input.reuseSession)
    window.__session = window.FW.createTrackedSession()

  const progress = []
  const result = await window.FW.fetchWindow({
    lists: input.spec.entries,
    start: input.start,
    today: input.today,
    target: input.target,
    endOverride: input.endOverride,
    reviewed: new Set(input.reviewed || []),
    options: input.options,
    session: window.__session,
    onProgress: (text, done) => progress.push(`${text} @${done}`),
  })

  return {
    window: { ...result.window, days: [...result.window.days] },
    works: result.works.map(work => ({
      id: work.workId,
      order: work.markedOrder,
      date: work.dateText,
      hidden: !!work.hidden,
      filtered: !!work.filtered,
    })),
    sources: [...result.sources],
    days: [...result.days],
    failed: result.failed,
    capped: result.capped,
    backlog: result.backlog,
    blocked: result.blocked,
    requests: result.requests,
    urls: window.__requests,
    progress,
  }
}

describe('tracked/fetchWindow', { skip }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage('src/content_script/tracked/fetchWindow.ts', 'FW', { stubBrowser: true }))
    await page.evaluate(installArchive)
  }, { timeout: 120_000 })

  after(async () => close?.())

  beforeEach(() => {
    nextWorkId = 4000
  })

  /** Gather a window over `fixtures`, with sensible defaults for everything else. */
  const gather = (fixtures, opts = {}) => page.evaluate(runInPage, {
    spec: spec(fixtures),
    today: TODAY,
    target: 40,
    options: withOptions(),
    ...opts,
  })

  const ids = result => result.works.map(work => work.id)

  test('settles the window part-way into a list, reading only the pages it needs', async () => {
    const start = TODAY - 10
    // Eight works a day for ten days: the target of 40 is reached on the fifth.
    const result = await gather([listing('L1', Array.from({ length: 10 }, (_, i) => [start + i, 8]))], { start })

    assert.equal(result.window.start, start)
    assert.equal(result.window.end, start + 4, 'the fifth day is the last that fits the target')
    assert.equal(result.window.count, 40)
    assert.equal(result.window.reviewable, true)
    assert.equal(result.window.nextDayCount, 8, 'one more day would add the eight already read')
    assert.deepEqual(result.days, [[start, 8], [start + 1, 8], [start + 2, 8], [start + 3, 8], [start + 4, 8]])
    assert.equal(result.works.length, 40)
    // Eighty works behind the window, read forty of them: three pages, no more.
    assert.equal(result.requests, 3)
    assert.deepEqual(result.works.map(w => w.order), Array.from({ length: 40 }, (_, i) => i))
  })

  test('each list is asked for works from one day before the window', async () => {
    const start = TODAY - 6
    const entry = { since: 0 }
    const result = await gather([listing('L1', [[start, 3]])], { start })

    const from = new URLSearchParams(result.urls[0].split('?')[1]).get('work_search[date_from]')
    assert.equal(from, isoDay(listBase(entry, start)))
    assert.equal(from, isoDay(start - 1), 'a day early, to catch a work filed then but dated in the window')
  })

  test('a first day bigger than the whole target is still a window of its own', async () => {
    const start = TODAY - 8
    const result = await gather([listing('L1', [[start, 50], [start + 1, 25]])], { start })

    assert.equal(result.window.end, start, 'never less than a day, however big that day is')
    assert.equal(result.window.count, 50)
    assert.equal(result.works.length, 50)
    assert.deepEqual(result.days, [[start, 50]])
  })

  test('reviewed through yesterday: today is previewed, and cannot be marked reviewed', async () => {
    const start = TODAY
    const result = await gather([listing('L1', [[TODAY - 1, 4], [TODAY, 3]])], { start })

    assert.equal(result.window.start, TODAY)
    assert.equal(result.window.end, TODAY)
    assert.equal(result.window.reviewable, false, 'today is not over, so it is not reviewable')
    assert.equal(result.works.length, 3, 'only today\'s works, not yesterday\'s')
    assert.equal(result.requests, 1)
  })

  test('a boundary request confirms the window instead of reading on', async () => {
    const start = TODAY - 8
    // Twenty-one works on the first day, so the target is passed on the second
    // — and the page that shows it passing ends barely past the window's edge,
    // which is exactly when asking where a day begins beats reading another page.
    const result = await gather([listing('L1', [[start, 21], [start + 1, 25], [start + 2, 20]])], { start })

    assert.equal(result.window.end, start)
    assert.equal(result.window.count, 21)
    assert.equal(result.window.nextDayCount, 25)

    const boundary = result.urls.filter((url) => {
      const params = new URLSearchParams(url.split('?')[1])
      return params.get('work_search[date_from]') === isoDay(start + 2)
    })
    assert.equal(boundary.length, 1, 'one request at the day after the window, to place it')
    assert.match(boundary[0], /page=1/, 'a boundary is always page 1 — it is the heading that is wanted')
    // Three pages and the boundary. Sixty-six works behind it, twenty-one shown.
    assert.equal(result.requests, 4)
  })

  test('a blurb dated a day either side of its archive day lands in the right window', async () => {
    const start = TODAY - 9
    const result = await gather([listing('L1', [
      [start - 2, 1], // filed and dated before the query even starts
      [start - 1, 1], // filed the day before the window, dated then too
      [start - 1, 1, +1], // filed the day before, dated the window's first day
      [start, 2],
      [start + 1, 2],
      [start + 2, 1, -1], // filed the day after the window's end, dated inside it
      [start + 2, 3],
      [start + 3, 3],
    ])], { start, target: 7 })

    assert.equal(result.window.end, start + 1)
    assert.deepEqual(result.days, [[start, 3], [start + 1, 3]])
    const dates = result.works.map(work => work.date)
    assert.equal(dates.filter(date => date === formatDay(start)).length, 3, 'the one filed a day early counts here')
    assert.equal(dates.filter(date => date === formatDay(start + 1)).length, 3, 'so does the one filed a day late')
    assert.ok(!dates.includes(formatDay(start - 1)), 'a work dated before the window is not in it')
    assert.ok(!dates.includes(formatDay(start - 2)))
  })

  test('already-reviewed works are left out and do not count', async () => {
    const start = TODAY - 1
    const fixture = listing('L1', [[start, 6]])
    const reviewed = fixture.works.slice(0, 3).map(work => work.id)
    const result = await gather([fixture], { start, reviewed })

    assert.equal(result.window.count, 3)
    assert.deepEqual(result.days, [[start, 3]])
    assert.deepEqual(ids(result), fixture.works.slice(3).map(work => work.id))
    assert.deepEqual(result.sources.map(([sid]) => sid).length, 3, 'nor are they in the List source facet')
  })

  test('works the rules hide do not count, but are still handed over', async () => {
    const start = TODAY - 1
    const fixture = listing('L1', [[start, 4], [start, 2, 0, { tags: ['Nope'] }]])
    const result = await gather([fixture], {
      start,
      options: withOptions({
        rules: { enabled: true, filters: [{ target: 'tag', value: 'Nope', matcher: 'exact', behavior: 'hide' }], colors: {} },
      }),
    })

    assert.equal(result.window.count, 4, 'the hidden two are not part of the target')
    assert.deepEqual(result.days, [[start, 4]])
    assert.equal(result.works.length, 6, 'but they are still in the window, for the view to draw')
    assert.equal(result.works.filter(work => work.hidden).length, 2)
  })

  test('a series is read whole, and its old works stay out of the review', async () => {
    const start = TODAY - 5
    const result = await gather([series('7', [
      [start - 40, 4],
      [start, 2],
      [start + 1, 1],
    ])], { start })

    assert.equal(result.requests, 1, 'one page is the whole of it')
    assert.equal(result.works.length, 3, 'a series lists every part, but only the new ones are reviewable')
    assert.deepEqual(result.days.filter(([, n]) => n > 0), [[start, 2], [start + 1, 1]])
  })

  test('a long series is read at the cap, from the end where new parts land', async () => {
    const start = TODAY - 5
    // Seven pages. Page 1 is paid for to learn that, then the last five.
    const result = await gather([series('9', [[start, 140]])], { start })

    assert.equal(result.requests, 6)
    assert.equal(result.works.length, 120, 'pages 1 and 3 through 7 — page 2 is past the cap')
  })

  test('an uncommon tag marked for scanning is read off its own page', async () => {
    const start = TODAY - 4
    const result = await gather([uncommonTag('marriage-problems', [[start - 30, 2], [start + 1, 3]], { scan: true })], { start })

    assert.equal(result.works.length, 3, 'the tag page lists everything; only the new works are reviewable')
    assert.ok(result.urls.every(url => url.startsWith('/tags/marriage-problems')), 'the tag page, not a search')
  })

  test('an uncommon tag left unscanned is read through a search by its name', async () => {
    const start = TODAY - 4
    const result = await gather([uncommonTag('marriage problems', [[start - 30, 2], [start, 3]])], { start })

    assert.equal(result.works.length, 3, 'the search is bounded by date, so the old works never arrive')
    assert.ok(result.urls.every(url => url.startsWith('/works/search')), 'the search can be read by date; the page cannot')
    assert.ok(result.urls.every(url => url.includes('other_tag_names')), 'by the tag name')
  })

  test('a list that will not load is written off, and the rest still make a window', async () => {
    const start = TODAY - 2
    const good = listing('L1', [[start, 5]])
    const bad = { ...search('L2', [[start, 5]]), fail: true }
    const result = await gather([good, bad], { start })

    assert.deepEqual(result.failed, ['L2'])
    assert.equal(result.window.reviewable, false, 'a range whose works are missing cannot be marked reviewed')
    assert.equal(result.works.length, 5, 'the list that answered is still shown')
    assert.equal(result.blocked, false, 'nothing about this says the archive refused us')
  })

  test('a signed-out answer is a failure, not a short list', async () => {
    const start = TODAY - 2
    const result = await gather([{ ...listing('L1', [[start, 5]]), signedOut: true }], { start })

    assert.deepEqual(result.failed, ['L1'])
    assert.equal(result.works.length, 0)
    assert.equal(result.requests, 1, 'asked once, and believed the answer')
  })

  test('endOverride shrinks and grows the window, and never reaches today', async () => {
    const start = TODAY - 10
    const rows = Array.from({ length: 10 }, (_, i) => [start + i, 8])

    const smaller = await gather([listing('L1', rows)], { start, endOverride: start + 2 })
    assert.equal(smaller.window.end, start + 2)
    assert.equal(smaller.window.count, 24)

    const bigger = await gather([listing('L1', rows)], { start, endOverride: start + 7 })
    assert.equal(bigger.window.end, start + 7)
    assert.equal(bigger.window.count, 64, 'a range the reader asked for is not held to the target')

    const past = await gather([listing('L1', rows)], { start, endOverride: TODAY + 3 })
    assert.equal(past.window.end, TODAY - 1, 'today is never part of a window it could be marked reviewed over')
  })

  test('moving the window by a day re-plans over what is already in hand', async () => {
    const start = TODAY - 10
    const fixtures = [listing('L1', Array.from({ length: 10 }, (_, i) => [start + i, 8]))]

    const first = await gather(fixtures, { start })
    assert.equal(first.window.end, start + 4)
    assert.ok(first.requests > 0)

    const shrunk = await gather(fixtures, { start, endOverride: start + 2, reuseSession: true })
    assert.equal(shrunk.window.end, start + 2)
    assert.equal(shrunk.requests, 0, 'a day off the end asks the archive for nothing at all')
    assert.equal(shrunk.works.length, 24)
  })

  test('the backlog comes free, from what page 1 already said', async () => {
    const start = TODAY - 8
    const result = await gather([listing('L1', [[start, 21], [start + 1, 25], [start + 2, 20]])], { start })

    assert.equal(result.window.count, 21)
    // Sixty-six works from the window's start through today, twenty-one of them
    // in the window: the rest is what the toolbar calls "about N more to review".
    assert.equal(result.backlog, 45)
  })

  test('two lists holding the same work show it once, carrying both of them', async () => {
    const start = TODAY - 2
    const shared = works([[start, 1]])
    const one = listing('L1', [...shared, ...works([[start, 2]])])
    const two = search('L2', [...shared, ...works([[start, 2]])])
    const result = await gather([one, two], { start })

    assert.equal(result.window.count, 5, 'five works, not six')
    assert.equal(result.works.length, 5)
    const both = result.sources.filter(([, lists]) => lists.length === 2)
    assert.equal(both.length, 1)
    assert.deepEqual(both[0][1], ['L1', 'L2'])
  })

  test('a day past the ceiling is cut off at it, and says which lists filled it', async () => {
    const start = TODAY - 1
    const result = await gather([listing('L1', [[start, 6]])], {
      start,
      options: withOptions({ searchMaxResults: 3 }),
    })

    assert.equal(result.works.length, 3)
    assert.deepEqual(result.days, [[start, 3]], 'what is shown is what the day strip counts')
    assert.deepEqual(result.capped, [{ day: start, count: 6, shown: 3, lists: ['L1'] }])
  })

  test('says what it is reading while it reads it', async () => {
    const start = TODAY - 2
    const result = await gather([listing('L1', [[start, 5]], { entry: { alias: 'Hurt/comfort' } })], { start })

    assert.ok(result.progress.some(line => line.includes('Hurt/comfort')), 'names the list, not a page number')
  })
})
