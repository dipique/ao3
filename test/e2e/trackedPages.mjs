import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

import { DIST, installMock, sleep } from './helpers.mjs'

/**
 * A stand-in archive for the tracked-list pill's refining and updating e2e tests,
 * and the tab plumbing they share. Not a test file itself.
 *
 * Refining a list is a walk across pages — the list's own page, the page its
 * Sort & Filter sidebar submits to, a search with other words — so unlike the
 * other pill tests these tabs navigate for real, and two things have to survive
 * each load the way they do in a browser with the extension installed:
 *
 * - **the extension's storage**, which the page's mock keeps in the page's own
 *   `localStorage` ({@link persistentMock}) so the next page on the archive
 *   starts from what the last one wrote;
 * - **the content script**, which isn't installed here but injected, and so is
 *   injected again after every load ({@link inject}).
 *
 * The tab's `sessionStorage` — where the refining mark lives — is the browser's
 * own, and outlives a navigation without help, which is what these tests are
 * partly there to show.
 */

export const ARCHIVE = 'https://archiveofourown.org'

const STORE_KEY = '__ao3eMockStore'

/**
 * A script for `evaluateOnNewDocument`: {@link installMock}, with the store kept
 * in the page's `localStorage` and picked up again by the next page of the tab.
 * Each call gets a token of its own, so a new tab starts from its own seed
 * rather than from what an earlier tab left behind on the same origin.
 * `window.__writes` still starts empty on every page; read the store with
 * {@link storedOption}.
 */
export function persistentMock(seed) {
  const token = Math.random().toString(36).slice(2)
  return `(() => {
    let seed = ${JSON.stringify(seed)}
    try {
      const kept = JSON.parse(localStorage.getItem(${JSON.stringify(STORE_KEY)}) || 'null')
      if (kept && kept.token === ${JSON.stringify(token)})
        seed = kept.store
    }
    catch {}
    ;(${installMock})(seed)
    const store = { ...seed }
    const keep = () => {
      try {
        localStorage.setItem(${JSON.stringify(STORE_KEY)}, JSON.stringify({ token: ${JSON.stringify(token)}, store }))
      }
      catch {}
    }
    keep()
    const local = window.browser.storage.local
    const set = local.set
    local.set = (items) => {
      Object.assign(store, JSON.parse(JSON.stringify(items)))
      keep()
      return set(items)
    }
  })()`
}

/** A stored option, as the tab's store now holds it. */
export function storedOption(tab, name = 'trackedLists') {
  return tab.evaluate((key, option) => JSON.parse(localStorage.getItem(key) || 'null')?.store?.[`option.${option}`] ?? null, STORE_KEY, name)
}

/** The tab's refining mark, as it stored it, or null. */
export function refiningMark(tab) {
  return tab.evaluate(() => JSON.parse(sessionStorage.getItem('ao3e:refining') || 'null'))
}

let bundle = null

/** The built content script and its stylesheet, read once. */
async function contentScript() {
  bundle ??= {
    css: await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8'),
    js: await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8'),
  }
  return bundle
}

export function launch(chromePath) {
  return puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
}

/** Put the content script into the page on screen, and give it time to run. */
export async function inject(tab) {
  const { css, js } = await contentScript()
  await tab.addStyleTag({ content: css })
  await tab.addScriptTag({ content: js })
  await sleep(1200)
}

/**
 * A new tab on the stand-in archive: every request answered by `route(url)`
 * (which returns a page's HTML, or null for a 404), the extension's storage
 * seeded with `seed` and kept across loads. `requests` collects every URL the
 * tab asked for.
 */
export async function openTab(browser, { seed, route, requests = [] }) {
  const tab = await browser.newPage()
  await tab.setViewport({ width: 1280, height: 900 })
  await tab.setRequestInterception(true)
  tab.on('request', (req) => {
    const url = req.url()
    if (!url.startsWith(`${ARCHIVE}/`))
      return void req.abort()
    requests.push(url)
    const body = route(new URL(url))
    if (body === null)
      return void req.respond({ status: 404, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>404</title>' })
    void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
  })
  await tab.evaluateOnNewDocument(persistentMock(seed))
  return tab
}

/** Load `url` in the tab — a real navigation — and run the content script on it. */
export async function visit(tab, url) {
  await tab.goto(url, { waitUntil: 'domcontentloaded' })
  await inject(tab)
}

/** Do something that navigates the tab (a form submit, a click), then run the content script on where it lands. */
export async function navigateBy(tab, action) {
  await Promise.all([tab.waitForNavigation({ waitUntil: 'domcontentloaded' }), action()])
  await inject(tab)
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

export const TRACK_PILL = '.AO3E--filter-toolbar--track > button'
export const TRACK_TEXT = '.AO3E--filter-toolbar--track--text'
export const TRACK_BOX = '.AO3E--filter-toolbar--track--box'
export const TITLE_INPUT = `${TRACK_BOX} input[aria-label="Title for this list"]`

/** Open the collapsed toolbar, and the pill's box under it. Every re-run rebuilds both shut. */
export async function openBox(tab) {
  await tab.click('.AO3E--filter-toolbar--fab')
  await sleep(300)
  await tab.click(TRACK_PILL)
  await sleep(300)
}

export function pillText(tab) {
  return tab.$eval(TRACK_TEXT, el => el.textContent.trim())
}

/** Everything the box says, as the reader reads it. */
export function boxText(tab) {
  return tab.$eval(TRACK_BOX, el => el.textContent.replace(/\s+/g, ' ').trim())
}

/** The lines of the box's diff summary. */
export function diffLines(tab) {
  return tab.$$eval(`${TRACK_BOX} ul li`, els => els.map(el => el.textContent.trim()))
}

/** The texts of the box's buttons, in order. */
export function boxButtons(tab) {
  return tab.$$eval(`${TRACK_BOX} button`, els => els.map(el => el.textContent.trim()))
}

/** Click the box's button with this text — a real pointer click. */
export async function clickBoxButton(tab, text) {
  const handles = await tab.$$(`${TRACK_BOX} button`)
  for (const handle of handles) {
    if (await handle.evaluate(el => el.textContent.trim()) === text)
      return handle.click()
  }
  throw new Error(`No button "${text}" in the box`)
}

/** The messages of the toasts on screen. */
export function toasts(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast .message') ?? []])
    .map(el => el.textContent.trim()))
}

/** Click a toast's action button (its **Undo**). */
export function clickToastAction(tab, label) {
  return tab.evaluate((text) => {
    for (const el of document.querySelectorAll('body > div')) {
      const button = [...el.shadowRoot?.querySelectorAll('.toast button.action') ?? []].find(b => b.textContent.trim() === text)
      if (button) {
        button.click()
        return true
      }
    }
    return false
  }, label)
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The signed-in header `parseUser` reads the reader's own id out of. */
const HEADER = `
  <div id="header">
    <ul class="user navigation actions">
      <li><a href="/users/someone/preferences">someone</a></li>
    </ul>
  </div>`

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * A work blurb, filing its tags the way the archive does: the fandoms in the
 * heading, a rating in the required tags, and characters, relationships and
 * freeforms each in their own `li` class.
 */
export function blurb(id, { fandoms = ['Harry Potter - J. K. Rowling'], rating = 'Teen And Up Audiences', characters = [], relationships = [], freeforms = [] } = {}) {
  const tag = (kind, name) => `<li class="${kind}"><a class="tag" href="/tags/${encodeURIComponent(name)}/works">${escape(name)}</a></li>`
  return `
    <li id="work_${id}" class="work blurb group" role="article">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a>
          by <a rel="author" href="/users/other/pseuds/other">other</a></h4>
        <h5 class="fandoms heading"><span class="landmark">Fandoms:</span>
          ${fandoms.map(name => `<a class="tag" href="/tags/${encodeURIComponent(name)}/works">${escape(name)}</a>`).join(', ')}</h5>
        <ul class="required-tags">
          <li><span class="rating" title="${escape(rating)}"><span class="text">${escape(rating)}</span></span></li>
        </ul>
        <p class="datetime">14 Sep 2026</p>
      </div>
      <ul class="tags commas">
        ${relationships.map(name => tag('relationships', name)).join('')}
        ${characters.map(name => tag('characters', name)).join('')}
        ${freeforms.map(name => tag('freeforms', name)).join('')}
      </ul>
      <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
        <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
    </li>`
}

/** The sidebar's character checkboxes, by id: the only ones these tests exclude by. */
export const SIDEBAR_CHARACTERS = [
  { id: '1234', name: 'Draco Malfoy', count: 12 },
  { id: '5678', name: 'Ron Weasley', count: 8 },
]

/**
 * A tag's works listing, in either spelling (`/tags/X/works` or the `/works?…&tag_id=X`
 * its sidebar submits to), with the Sort & Filter sidebar the archive draws: a
 * sort, the character exclusions as checkboxes labelled with their counts, the
 * completion radios, the free-text tag fields, and the tag as a hidden input
 * last. What's ticked follows the address, as it does on the archive.
 *
 * `tagId` is the name as `tag_id` spells it, the archive's own escapes included.
 */
export function listingPage(url, { tagId, blurbs = [blurb(101), blurb(102)] }) {
  const values = name => url.searchParams.getAll(name)
  const excluded = values('exclude_work_search[character_ids][]')
  const complete = url.searchParams.get('work_search[complete]') ?? ''
  const checkbox = ({ id, name, count }) => `
    <li><label for="exclude_work_search_character_ids_${id}">
      <input type="checkbox" name="exclude_work_search[character_ids][]" id="exclude_work_search_character_ids_${id}" value="${id}"${excluded.includes(id) ? ' checked' : ''} />
      <span class="indicator" aria-hidden="true"></span><span>${escape(name)} (${count})</span>
    </label></li>`
  const radio = (value, label) => `
    <li><label><input type="radio" name="work_search[complete]" value="${value}"${complete === value ? ' checked' : ''} /> <span>${label}</span></label></li>`
  const name = tagId.replace(/\*s\*/g, '/').replace(/\*a\*/g, '&').replace(/\*d\*/g, '.').replace(/\*q\*/g, '?').replace(/\*h\*/g, '#')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Works in ${escape(name)}</title></head>
<body>
  ${HEADER}
  <div id="main" class="works-index region">
    <h2 class="heading">1 - ${blurbs.length} of ${blurbs.length} Works in <a class="tag" href="/tags/${encodeURIComponent(tagId)}">${escape(name)}</a></h2>
    <ol class="work index group">${blurbs.join('')}</ol>
    <form class="narrow-hidden filters" id="work-filters" action="/works" accept-charset="UTF-8" method="get">
      <input name="utf8" type="hidden" value="✓" />
      <select name="work_search[sort_column]" id="work_search_sort_column"><option value="revised_at" selected>Date Updated</option></select>
      <dl class="filters">
        <dt>Exclude</dt>
        <dd><ul>${SIDEBAR_CHARACTERS.map(checkbox).join('')}</ul></dd>
        <dt>More options</dt>
        <dd>
          <input type="text" name="work_search[other_tag_names]" value="" />
          <input type="text" name="work_search[excluded_tag_names]" value="" />
          <ul>${radio('', 'All works')}${radio('T', 'Complete works only')}${radio('F', 'Works in progress only')}</ul>
        </dd>
      </dl>
      <input type="hidden" name="tag_id" value="${escape(tagId)}" />
      <input type="submit" name="commit" value="Sort and Filter" />
    </form>
  </div>
</body></html>`
}

/** Works search results for whatever the address asked for. */
export function searchPage(url, blurbs = [blurb(201), blurb(202)]) {
  const query = url.searchParams.get('work_search[query]') ?? ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Search Works</title></head>
<body>
  ${HEADER}
  <div id="main" class="works-search region">
    <h2 class="heading">Search Works</h2>
    <h4 class="heading">You searched for: ${escape(query)}</h4>
    <h3 class="heading">${blurbs.length} Found</h3>
    <ol class="work index group">${blurbs.join('')}</ol>
  </div>
</body></html>`
}

/**
 * A tag's own page (`/tags/NAME`): the sentence naming its category, and — for
 * an uncommon tag, `works` given — the works it lists, which is what makes the
 * page trackable at all.
 */
export function tagPage(name, category, works = null) {
  const listbox = works
    ? `<p>This tag has not been marked common and can't be filtered on (yet).</p>
      <div class="work listbox group">
        <h3 class="heading">Works which have used it as a tag:</h3>
        <ul class="index group">${works.join('')}</ul>
      </div>`
    : `<p>It's a <a href="/faq/glossary#canonicaldef">canonical tag</a>.</p>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(name)}</title></head>
<body>
  ${HEADER}
  <div id="main" class="tags-show region">
    <div class="tag home profile">
      <div class="primary header module"><h2 class="heading">${escape(name)}</h2></div>
      <p>This tag belongs to the ${category} Category.
      </p>
      ${listbox}
    </div>
  </div>
</body></html>`
}

/** A series' page: its title as the heading, and its works. */
export function seriesPage(title, works = [blurb(301)]) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body>
  ${HEADER}
  <div id="main" class="series-show region">
    <h2 class="heading">
      ${escape(title)}
    </h2>
    <ul class="series work index group">${works.join('')}</ul>
  </div>
</body></html>`
}
