import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { REOPEN_GUARD_MS } from '../../src/common/constants.ts'
import { DIST, hurryTimers, installMock, sleep } from './helpers.mjs'

export { launch } from './helpers.mjs'

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

/**
 * A script for `evaluateOnNewDocument`, after the storage mock: once the page
 * is linked to others ({@link linkWrites}), every write it makes is handed to
 * `window.__relay`, and `window.__relayed` writes one made elsewhere — as
 * another tab's write reaches this one, change event and all, without being
 * handed on again.
 */
export function relayWrites() {
  const local = window.browser.storage.local
  const own = local.set
  window.__relayed = items => own(items)
  local.set = (items) => {
    if (typeof window.__relay === 'function')
      window.__relay(JSON.parse(JSON.stringify(items)))
    return own(items)
  }
}

/**
 * Keep the storage of pages that run {@link relayWrites} in step from now on,
 * the way a browser's is: each write one makes reaches every other, in the
 * order it was made, and on every page they load after. Writes made before
 * aren't handed on. Call it once for a set of pages; any pages will do, so an
 * archive tab and the options page share one store as two archive tabs do.
 */
export async function linkWrites(pages) {
  for (const from of pages) {
    let queue = Promise.resolve()
    await from.exposeFunction('__relay', (items) => {
      for (const to of pages) {
        if (to !== from)
          queue = queue.then(() => to.evaluate(i => window.__relayed?.(i), items)).catch(() => {})
      }
    })
  }
}

/** A stored option, as the tab's store now holds it. */
export function storedOption(tab, name = 'trackedLists') {
  return stored(tab, `option.${name}`)
}

/**
 * Anything the tab's store holds, by its whole key (`cache.searchLists`), as it
 * is kept across loads. Only what is set is kept ({@link persistentMock}), so a
 * key the page has removed still reads as it was: ask the page's own
 * `browser.storage` for those.
 */
export function stored(tab, key) {
  return tab.evaluate((store, name) => JSON.parse(localStorage.getItem(store) || 'null')?.store?.[name] ?? null, STORE_KEY, key)
}

/**
 * Everything the tab's store holds, as it is kept across loads: to seed another
 * page, such as the options page, with what the tab wrote. Read as
 * {@link stored} reads one key, so a key the page has removed is still there.
 */
export function keptStore(tab) {
  return tab.evaluate(store => JSON.parse(localStorage.getItem(store) || 'null')?.store ?? {}, STORE_KEY)
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

/** Put the content script into the page on screen, and wait for the page to settle ({@link settled}). */
export async function inject(tab) {
  const { css, js } = await contentScript()
  await tab.addStyleTag({ content: css })
  await tab.addScriptTag({ content: js })
  await settled(tab)
}

/** How many runs the page's content script has finished, each with every unit it ran ready. */
export function runs(tab) {
  return tab.evaluate(() => Number(document.documentElement.dataset.ao3eRuns ?? 0))
}

/**
 * Wait for the page to settle: its content script has finished a run after its
 * `after`th, and none is under way or asked for by an options change — the
 * marks it keeps on `<html>`. Work a unit leaves going once it is ready, such
 * as a search view opening, isn't part of a run: wait for what it does instead.
 */
export function settled(tab, after = 0) {
  return tab.waitForFunction((done) => {
    const { dataset } = document.documentElement
    return !('ao3eBusy' in dataset) && Number(dataset.ao3eRuns ?? 0) > done
  }, {}, after)
}

/**
 * Press one of the toggles on the search view's facet row named `value` (its
 * `include`, `require` or `exclude`), and wait until the toggle shows the
 * press: the view filters its works as it draws the toggle, so they are in
 * step by then.
 */
export async function pressFacet(tab, value, toggle = 'include') {
  const find = (want, kind) => [...document.querySelectorAll('.AO3E--search-view--row')]
    .find(row => row.querySelector('.AO3E--search-view--row-name')?.textContent?.trim() === want)
    ?.querySelector(`.AO3E--search-view--toggle-${kind}`)
  const pressed = () => tab.evaluate(`(${find})(${JSON.stringify(value)}, ${JSON.stringify(toggle)})?.getAttribute('aria-pressed')`)
  const was = await pressed()
  await tab.evaluate(`(${find})(${JSON.stringify(value)}, ${JSON.stringify(toggle)}).click()`)
  await tab.waitForFunction(`(${find})(${JSON.stringify(value)}, ${JSON.stringify(toggle)})?.getAttribute('aria-pressed') !== ${JSON.stringify(was)}`)
}

/** When each tab last showed one of the extension's menus, by the clock here. */
const menuShown = new WeakMap()

/**
 * Wait until the content script would open a menu in the tab again: it opens
 * none within {@link REOPEN_GUARD_MS} of the last, so this waits out what is
 * left of that since the last menu {@link openMenu} opened there. Before a
 * gesture that should open no menu, so that it shows none for its own reasons.
 */
export function menuGuardOver(tab) {
  return sleep(Math.max(0, (menuShown.get(tab) ?? 0) + REOPEN_GUARD_MS - Date.now()))
}

/**
 * Do `gesture`, which opens one of the extension's menus in the tab (a
 * right-click, a click on what opens one), once the content script would open
 * one ({@link menuGuardOver}), and wait for the menu. Returns what `gesture`
 * does.
 */
export async function openMenu(tab, gesture) {
  await menuGuardOver(tab)
  const before = await tab.$('.AO3E--menu')
  const done = await gesture()
  await tab.waitForFunction(old => !!document.querySelector('.AO3E--menu') && document.querySelector('.AO3E--menu') !== old, {}, before)
  menuShown.set(tab, Date.now())
  return done
}

/** Wait until no menu of the extension's is open: one closes at once, on Escape or a pick. */
export function menuClosed(tab) {
  return tab.waitForFunction(() => !document.querySelector('.AO3E--menu'))
}

/**
 * The open menu's rows, in order, by what each does: its `data-ao3e-action`
 * and `data-ao3e-value`, whether it is off or the current choice, the scope
 * group it sits in, and whether it is in the open submenu.
 */
export function menuRows(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')].map(el => ({
    action: el.dataset.ao3eAction ?? null,
    value: el.dataset.ao3eValue ?? null,
    disabled: el.disabled,
    active: el.classList.contains('AO3E--menu--active'),
    scope: [...el.classList].find(c => c.startsWith('AO3E--menu--item--'))?.slice('AO3E--menu--item--'.length) ?? null,
    submenu: !!el.closest('.AO3E--menu--submenu'),
  })))
}

/**
 * Click the open menu's row that does `action` — to `value`, when given — in
 * the menu or its open submenu. False when there is no such row, or it is off.
 */
export function pickRow(tab, action, value) {
  return tab.evaluate((a, v) => {
    const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      .find(el => el.dataset.ao3eAction === a && (v === undefined || el.dataset.ao3eValue === v) && !el.disabled)
    row?.click()
    return !!row
  }, action, value)
}

/**
 * Wait for a search view to be on screen and done loading: its works drawn,
 * with no progress panel up and no refresh under way. Opening a view is work a
 * unit leaves going once it is ready, so {@link settled} doesn't wait for it.
 */
export function viewDrawn(tab) {
  return tab.waitForFunction(() => !!document.querySelector('.AO3E--search-host .AO3E--search-view--results')
    && !document.querySelector('.AO3E--search-host--progress, .AO3E--search-view--updating-on'))
}

/**
 * A new tab on the stand-in archive: every request answered by `route(url)`
 * (which returns a page's HTML, or null for a 404, or a promise of either, to
 * hold the answer back until it settles), the extension's storage seeded with
 * `seed` and kept across loads. `requests` collects every URL the tab asked for.
 * `hurry` shortens the page's timers of the delays it names, on every page of
 * the tab ({@link hurryTimers}).
 */
export async function openTab(browser, { seed, route, requests = [], hurry }) {
  const tab = await browser.newPage()
  await tab.setViewport({ width: 1280, height: 900 })
  if (hurry)
    await tab.evaluateOnNewDocument(hurryTimers, hurry)
  await tab.setRequestInterception(true)
  tab.on('request', async (req) => {
    const url = req.url()
    if (!url.startsWith(`${ARCHIVE}/`))
      return void req.abort()
    requests.push(url)
    const body = await route(new URL(url))
    // A request held back may have been dropped meanwhile, by a navigation.
    if (body === null)
      return void req.respond({ status: 404, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>404</title>' }).catch(() => {})
    void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body }).catch(() => {})
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
export const TITLE_INPUT = `${TRACK_BOX} input.AO3E--filter-toolbar--track--alias`
/** The box's chooser of which list to update, where there are several. */
export const LIST_CHOOSER = `${TRACK_BOX} select.AO3E--filter-toolbar--track--chooser`

/** Open the toolbar, unless it is open, and wait for its pills to be in place. */
export async function openToolbar(tab) {
  if (!await tab.$eval('.AO3E--filter-toolbar', bar => bar.classList.contains('AO3E--filter-toolbar--open')))
    await tab.click('.AO3E--filter-toolbar--fab')
  // The panel fades and slides in, and a click aimed while it moves can miss.
  await tab.waitForFunction(() => getComputedStyle(document.querySelector('.AO3E--filter-toolbar--panel')).opacity === '1')
}

/**
 * Open the toolbar, and the pill's box under it, whichever of them is shut:
 * every re-run rebuilds both shut, and a pill rebuilt in place is shut in a
 * toolbar left open. A pill with no box (one click tracks a saved list) is
 * left unpressed.
 */
export async function openBox(tab) {
  await openToolbar(tab)
  if (await tab.$eval(TRACK_BOX, box => box.hidden).catch(() => false)) {
    await tab.click(TRACK_PILL)
    await tab.waitForFunction(selector => document.querySelector(selector)?.hidden === false, {}, TRACK_BOX)
  }
}

/**
 * Do `action`, which writes an option the page's units re-run on, and wait for
 * the re-run to finish, every unit built again from what was written.
 */
export async function rerun(tab, action) {
  const before = await runs(tab)
  await action()
  await settled(tab, before)
}

export function pillText(tab) {
  return tab.$eval(TRACK_TEXT, el => el.textContent.trim())
}

/**
 * Which state the pill was drawn for, as its `data-ao3e-row` says: `new`,
 * `exact:<id>`, `saved:<id>`, `same-root:<ids>`, or `refining:<id>:` with
 * `same` until the search differs from the list's and `changed` once it does.
 */
export function pillRow(tab) {
  return tab.$eval('.AO3E--filter-toolbar--track', el => el.dataset.ao3eRow ?? null)
}

/** The lines of the box's diff summary. */
export function diffLines(tab) {
  return tab.$$eval(`${TRACK_BOX} ul li`, els => els.map(el => el.textContent.trim()))
}

/** What the box warns of, in order, by each warning's `data-ao3e-warn`: `root`, `twin`. */
export function boxWarnings(tab) {
  return tab.$$eval(`${TRACK_BOX} [data-ao3e-warn]`, els => els.map(el => el.dataset.ao3eWarn))
}

/** What each of the box's buttons and links does, by its `data-ao3e-action`, in order. */
export function boxActions(tab) {
  return tab.$$eval(`${TRACK_BOX} [data-ao3e-action]`, els => els.map(el => el.dataset.ao3eAction))
}

/** The box's control that does `action`. */
export async function boxAction(tab, action) {
  const handle = await tab.$(`${TRACK_BOX} [data-ao3e-action="${action}"]`)
  if (!handle)
    throw new Error(`No control that does ${action} in the box`)
  return handle
}

/** Click the box's control that does `action` — a real pointer click. */
export async function clickBoxAction(tab, action) {
  return (await boxAction(tab, action)).click()
}

/** The type of each toast on screen — `success`, `error`, or null for a plain one. */
export function toastTypes(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
    .map(el => el.dataset.type ?? null))
}

/** Which toast each one on screen is, by its `data-ao3e-toast`; null for one with no name. */
export function toastNames(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
    .map(el => el.dataset.ao3eToast ?? null))
}

/** Where the links the toasts on screen offer go, as the page resolves each `href`. */
export function toastLinks(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast a.link') ?? []])
    .map(a => a.href))
}

/** Follow the toast's link to `href`, as a click on it does. */
export function clickToastLink(tab, href) {
  return tab.evaluate((to) => {
    for (const el of document.querySelectorAll('body > div')) {
      const link = [...el.shadowRoot?.querySelectorAll('.toast a.link') ?? []].find(a => a.href === to)
      if (link) {
        link.click()
        return true
      }
    }
    return false
  }, href)
}

/**
 * The toasts on screen, as `{ name, type, message }`: `name` is the toast's
 * `data-ao3e-toast`, which says which one it is however it is worded.
 */
export function shownToasts(tab) {
  return tab.evaluate(() => [...document.querySelectorAll('body > div')]
    .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
    .map(el => ({ name: el.dataset.ao3eToast ?? null, type: el.dataset.type ?? null, message: el.querySelector('.message')?.textContent.trim() ?? '' })))
}

/** The toast named `name` that is on screen, as {@link shownToasts} gives it, or null. */
export async function toastNamed(tab, name) {
  return (await shownToasts(tab)).find(one => one.name === name) ?? null
}

/** Click the action of the toast named `name` (its **Undo**, its **Mark reviewed**). False when no such toast is up. */
export function pressToast(tab, name) {
  return tab.evaluate((want) => {
    for (const el of document.querySelectorAll('body > div')) {
      const button = el.shadowRoot?.querySelector(`.toast[data-ao3e-toast="${want}"] button.action`)
      if (button) {
        button.click()
        return true
      }
    }
    return false
  }, name)
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
 * `collection` (`{ name, title, number }`) makes it that collection's listing
 * instead, whose sidebar submits the collection's own path with its number as
 * `collection_id`, as the archive's does.
 *
 * `subnav` draws the row of actions the archive puts above a listing (Works,
 * Bookmarks, and the Filters link a narrow screen opens the sidebar by), which
 * is where the search view's button goes. `pages` draws its
 * pagination, above and below the works, on the page the address names, and
 * `total` is how many works the heading says the listing holds.
 */
export function listingPage(url, { tagId, collection, blurbs = [blurb(101), blurb(102)], subnav = false, pages = 1, total = blurbs.length }) {
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
  const owner = collection
    ? { name: collection.title, home: `/collections/${collection.name}`, action: `/collections/${collection.name}/works`, hidden: ['collection_id', collection.number] }
    : {
        name: tagId.replace(/\*s\*/g, '/').replace(/\*a\*/g, '&').replace(/\*d\*/g, '.').replace(/\*q\*/g, '?').replace(/\*h\*/g, '#'),
        home: `/tags/${encodeURIComponent(tagId)}`,
        action: '/works',
        hidden: ['tag_id', tagId],
      }
  const page = Number(url.searchParams.get('page') ?? 1)
  const first = (page - 1) * blurbs.length + 1
  const pagination = pages > 1
    ? `<h4 class="landmark heading">Navigation</h4>
    <ol class="pagination actions pagy" role="navigation">${Array.from({ length: pages }, (_, i) => i + 1)
      .map(n => (n === page ? `<li><a aria-current="page" class="current">${n}</a></li>` : `<li><a href="?page=${n}">${n}</a></li>`))
      .join('')}</ol>`
    : ''
  const actions = subnav
    ? `<div class="navigation actions module">
      <h3 class="landmark heading">Navigation and Actions</h3>
      <ul class="user navigation actions" role="navigation">
        <li><span class="current">Works</span></li>
        <li><a href="${owner.home}/bookmarks">Bookmarks</a></li>
        <li class="narrow-shown hidden"><a href="#work-filters" id="go_to_filters">Filters</a></li>
      </ul>
    </div>`
    : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Works in ${escape(owner.name)}</title></head>
<body>
  ${HEADER}
  <div id="main" class="works-index region">
    <h2 class="heading">${first} - ${first + blurbs.length - 1} of ${total} Works in <a class="tag" href="${owner.home}">${escape(owner.name)}</a></h2>
    ${actions}
    ${pagination}
    <ol class="work index group">${blurbs.join('')}</ol>
    ${pagination}
    <form class="narrow-hidden filters" id="work-filters" action="${owner.action}" accept-charset="UTF-8" method="get">
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
      <input type="hidden" name="${owner.hidden[0]}" value="${escape(owner.hidden[1])}" />
      <input type="submit" name="commit" value="Sort and Filter" />
    </form>
  </div>
</body></html>`
}

/**
 * Works search results for whatever the address asked for. `subnav` draws the
 * "Edit Your Search" row the archive puts above them, which is where the
 * search view's button goes: without it no view is offered.
 */
export function searchPage(url, blurbs = [blurb(201), blurb(202)], { subnav = false } = {}) {
  const query = url.searchParams.get('work_search[query]') ?? ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Search Works</title></head>
<body>
  ${HEADER}
  <div id="main" class="works-search region">
    <h2 class="heading">Search Works</h2>
    <h4 class="heading">You searched for: ${escape(query)}</h4>
    ${subnav ? '<ul class="navigation actions"><li><a href="?edit_search=true">Edit Your Search</a></li></ul>' : ''}
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
