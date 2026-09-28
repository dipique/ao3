import { formatDay } from '../../src/common/trackedLists.ts'

/**
 * A stand-in archive for the tracked-lists review, shared by the review's e2e
 * tests. Not a test file itself.
 *
 * Everything the review reads is a works listing bounded by date: the reader's
 * own readings page for the entry point, and then each tracked list's query,
 * asked for oldest-first from a day, twenty works to a page. So the handler
 * here answers `work_search[date_from]` and `page` exactly as the archive does
 * — inclusive whole UTC days — and prints the heading count the fetcher reads
 * its boundaries off.
 */

export const MS_PER_DAY = 86_400_000
const PER_PAGE = 20

/** The UTC day every fixture's days are counted from. */
export const TODAY = Math.floor(Date.now() / MS_PER_DAY)

/**
 * Noon of {@link TODAY}, where the page's clock is started.
 *
 * The clock has to move — the fetch layer paces itself against elapsed time, and
 * one test winds it forward past the blurb store's grace period — but it must
 * never wander into another UTC day, or the fixture's days would stop meaning
 * what the test says they mean. Starting at noon leaves half a day of room.
 */
export const CLOCK_BASE = TODAY * MS_PER_DAY + 12 * 60 * 60_000

/**
 * Runs in the page, before anything else: a clock that starts at `base` and
 * then keeps real time, plus `window.__offset` for a test that needs to wind it
 * on. Real time rather than a frozen instant, because a paused fetch waits for
 * a clock that never advances for ever.
 */
export function installClock(base) {
  const real = Date.now
  window.__offset = 0
  const started = real()
  window.__clockBase = base
  Date.now = () => base + (real() - started) + window.__offset
}

/** Wind the page's clock on, in milliseconds. */
export function advanceClock(tab, ms) {
  return tab.evaluate(by => (window.__offset += by), ms)
}

let nextWorkId = 5000

/** Start work ids from the top again, so each test file's ids are its own. */
export function resetWorkIds(from = 5000) {
  nextWorkId = from
}

/**
 * Works for a fixture list, in the order the archive files them: `[filed,
 * count, drift, extra]` rows, each making `count` works filed that day and
 * dated `drift` days off it (the drift a real listing has between a blurb's
 * printed date and the day the archive filed it under).
 */
export function works(rows) {
  const out = []
  for (const [filed, count, drift = 0, extra = {}] of rows) {
    for (let i = 0; i < count; i++)
      out.push({ id: String(nextWorkId++), filed, dateText: formatDay(filed + drift), ...extra })
  }
  return out
}

/** Rows to build works from, or works already built (for a work two lists share). */
function worksFrom(rows) {
  return rows.length && Array.isArray(rows[0]) ? works(rows) : rows
}

/**
 * One tracked list: the stored entry, the works behind it, and how the archive
 * serves them. `key` is how a request finds its way back here — the tag's name
 * for a search by name, the query for a text search, the path otherwise.
 */
export function listing(id, rows, over = {}) {
  return {
    entry: { id, kind: 'works-filter', url: `/tags/${id}/works`, alias: id, tracked: true, since: 0, ...over.entry },
    key: `/tags/${id}/works`,
    layout: 'listing',
    works: worksFrom(rows),
    ...over.list,
  }
}

export function search(id, rows, over = {}) {
  return {
    entry: { id, kind: 'text-search', url: `/works/search?work_search[query]=${id}`, alias: id, tracked: true, since: 0, ...over.entry },
    key: id,
    layout: 'search',
    works: worksFrom(rows),
    ...over.list,
  }
}

/** The `option.trackedLists` value a set of fixtures describes. */
export function trackedOption(fixtures, over = {}) {
  return {
    enabled: true,
    target: 40,
    reviewedThrough: 0,
    lists: fixtures.map(fixture => fixture.entry),
    ...over,
  }
}

const tagLi = (name, kind = 'freeforms') => `<li class="${kind}"><a class="tag" href="/tags/${encodeURIComponent(name)}">${name}</a></li>`

/**
 * A work's blurb as the archive draws it. `work.characters` go in their own
 * `li`s ahead of `work.tags`, which are drawn as freeforms.
 */
export function blurbHtml(work) {
  return `<li id="work_${work.id}" class="work blurb group" role="article">`
    + `<div class="header module"><h4 class="heading">`
    + `<a href="/works/${work.id}">Work ${work.id}</a> by `
    + `<a rel="author" href="/users/${work.author || 'someone'}/pseuds/${work.author || 'someone'}">${work.author || 'someone'}</a>`
    + `</h4><h5 class="fandoms heading">Fandoms: <a class="tag" href="/tags/Fandom/works">Fandom</a></h5>`
    + `<p class="datetime">${work.dateText}</p></div>`
    + `<ul class="tags commas">${(work.characters || []).map(name => tagLi(name, 'characters')).join('')}${(work.tags || []).map(name => tagLi(name)).join('')}</ul>`
    + `<dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>`
    + `<dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl></li>`
}

function pagination(pages) {
  if (pages <= 1)
    return ''
  const items = Array.from({ length: pages }, (_, i) => `<li><a href="?page=${i + 1}">${i + 1}</a></li>`).join('')
  return `<ol class="pagination actions" role="navigation">${items}<li class="next"><a href="?page=2">Next</a></li></ol>`
}

/**
 * One of the two readings pages. The archive serves both at the same path, told
 * apart by `show=to-read`, and gives both the same subnav — which is where the
 * review's own item goes.
 */
export function readingsPage({ toRead = false, user = 'me' } = {}) {
  const subnav = toRead
    ? `<li><a href="/users/${user}/readings">History</a></li>
       <li><span class="current">Marked for Later</span></li>`
    : `<li><span class="current">History</span></li>
       <li><a href="/users/${user}/readings?show=to-read">Marked for Later</a></li>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="csrf-token" content="fixture-token"><title>${toRead ? 'Marked for Later' : 'History'}</title></head>
<body class="logged-in">
  <div id="header"><a href="/users/${user}/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">${toRead ? 'Marked for Later' : 'History'}</h2>
    <ul class="navigation actions" role="navigation">
      ${subnav}
      <li><a href="/users/${user}/readings/confirm_clear">Clear Entire History</a></li>
    </ul>
    <ol class="reading work index group"></ol>
  </div>
</body></html>`
}

/** Which fixture a request is for: the tag's name, the search's query, or the path. */
function keyOf(url) {
  return url.searchParams.get('work_search[other_tag_names]')
    ?? url.searchParams.get('work_search[query]')
    ?? url.pathname
}

function dayOfIso(iso) {
  return iso ? Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY) : null
}

/** One listing page, rendered as the kind of page that query would be served from. */
function listingPage(list, url) {
  const page = Number(url.searchParams.get('page') || '1')
  const from = dayOfIso(url.searchParams.get('work_search[date_from]'))
  const query = from === null ? list.works.slice() : list.works.filter(work => work.filed >= from)
  query.sort((a, b) => a.filed - b.filed || Number(a.id) - Number(b.id))
  const total = query.length
  const pages = Math.max(1, Math.ceil(total / PER_PAGE))
  const rows = query.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const blurbs = rows.map(blurbHtml).join('')

  const main = list.layout === 'search'
    ? `<div id="main" class="works-search region"><h3 class="heading">${total} Found</h3>`
    + `<ol class="work index group">${blurbs}</ol>${pagination(pages)}</div>`
    : `<div id="main" class="works-index region">`
      + `<h2 class="heading">${total ? `${(page - 1) * PER_PAGE + 1} - ${(page - 1) * PER_PAGE + rows.length} of ${total}` : '0'} Works in <a class="tag" href="/tags/x">X</a></h2>`
      + `<ol class="work index group">${blurbs}</ol>${pagination(pages)}</div>`
  return `<!DOCTYPE html><html><head><title>t</title></head><body class="logged-in">${main}</body></html>`
}

/**
 * A puppeteer request handler over the fixtures: the reader's readings pages,
 * and every tracked list's query. Anything else is a 404, which the fetcher
 * reads as a list that couldn't be loaded.
 *
 * `fetched` collects every list URL asked for, so a test can say what was read
 * and what wasn't. A fixture marked `fail` answers 500 to everything.
 */
export function archiveRoutes({ fixtures, user = 'me', fetched = [] }) {
  const lists = Object.fromEntries(fixtures.map(fixture => [fixture.key, fixture]))
  return (req) => {
    if (!req.url().startsWith('https://archiveofourown.org/'))
      return void req.abort()
    const url = new URL(req.url())
    if (url.pathname === `/users/${user}/readings`) {
      return void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: readingsPage({ toRead: url.searchParams.get('show') === 'to-read', user }),
      })
    }
    // AO3's own "mark for later" action, and the work page whose mark button the
    // menu reads the current state off. The review makes neither request itself,
    // but a reader saving a work from a blurb's menu mid-review makes both.
    if (/^\/works\/\d+\/mark_(?:for_later|as_read)$/.test(url.pathname))
      return void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html><body class="logged-in"></body></html>' })
    const work = /^\/works\/(\d+)$/.exec(url.pathname)
    if (work) {
      return void req.respond({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html><html><body class="logged-in"><div id="main"><ul class="work navigation actions">`
          + `<li class="mark"><form class="button_to" action="/works/${work[1]}/mark_for_later" method="post">`
          + `<button type="submit">Mark for Later</button></form></li></ul></div></body></html>`,
      })
    }
    fetched.push(url.pathname + url.search)
    const list = lists[keyOf(url)]
    if (!list || list.fail)
      return void req.respond({ status: list ? 500 : 404, body: 'no' })
    void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: listingPage(list, url) })
  }
}
