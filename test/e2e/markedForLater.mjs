import { WAIT_WORDS } from '../../src/content_script/archiveFetch.ts'
import { installMock, openWindow, storedLists } from './helpers.mjs'
import { mentions } from './optionsPage.mjs'
import { ARCHIVE, inject, relayWrites } from './trackedPages.mjs'

/**
 * The reader's Marked for Later list on a stand-in archive, for tests where
 * more than one page shares its refresh: the list's pages, a stored copy of
 * it, a tab that opens it, and what the pages say about a refresh.
 */

export const TO_READ = `${ARCHIVE}/users/me/readings?show=to-read`
export const KEY = 'marked-for-later:me'
export const DESCRIPTOR = { sourceId: 'marked-for-later', label: 'Marked for Later — me', listUrl: TO_READ }
export const PAGES = 3
export const PER_PAGE = 2
export const HOUR = 60 * 60_000

export function blurb(id, title) {
  return `<li class="reading work blurb group" id="work_${id}">
    <div class="header module"><h4 class="heading"><a href="/works/${id}">${title}</a>
      by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
    <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd>
      <dt class="chapters">Chapters:</dt><dd class="chapters">1/1</dd></dl>
  </li>`
}

/** Page `page` of the list as AO3 has it now, its works titled `${titles} work n`; signed out, a page of it with no works. */
export function toReadPage(page, titles = 'Live', { signedIn = true } = {}) {
  const start = (page - 1) * PER_PAGE + 1
  const listed = signedIn ? Array.from({ length: PER_PAGE }, (_, i) => blurb(start + i, `${titles} work ${start + i}`)).join('') : ''
  const pages = Array.from({ length: PAGES }, (_, i) => i + 1)
    .map(n => (n === page ? `<li><span class="current">${n}</span></li>` : `<li><a href="?show=to-read&page=${n}">${n}</a></li>`))
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Marked for Later</title></head>
<body${signedIn ? ' class="logged-in"' : ''}>
  <div id="header"><a href="/users/me/preferences">Preferences</a></div>
  <div id="main" class="readings-index dashboard region">
    <h2 class="heading">Marked for Later</h2>
    <ul class="navigation actions" role="navigation">
      <li><a href="/users/me/readings">History</a></li>
      <li><span class="current">Marked for Later</span></li>
    </ul>
    <ol class="reading work index group">${listed}</ol>
    <ol role="navigation" class="pagination actions">${pages}</ol>
  </div>
</body></html>`
}

/** The extension's storage with the list stored `ageMs` ago, its works titled "Stored work n" — older than a day is due a refresh. */
export function storedSeed(ageMs = 48 * HOUR, extra = {}) {
  return {
    'option.searchMarkedForLater': true,
    ...storedLists({ [KEY]: { scrapedAt: Date.now() - ageMs, blurbsHtml: [blurb(1, 'Stored work 1'), blurb(2, 'Stored work 2')], descriptor: DESCRIPTOR } }),
    ...extra,
  }
}

/**
 * A tab on the stand-in archive, its storage seeded with `seed` and
 * ready to be linked to other pages' (`linkWrites`). `answer(url)`
 * gives each request's response — `{ status, headers, body }`, a page's HTML,
 * or a promise of either, to hold the answer back — and `asked` collects the
 * numbered pages of the list the tab asks for, which only a refresh does.
 */
export async function archiveTab(browser, seed, answer, asked = []) {
  // A window of its own: the other tab's work goes on at full speed beside it.
  const tab = await openWindow(browser)
  await tab.setViewport({ width: 1280, height: 900 })
  await tab.setRequestInterception(true)
  tab.on('request', async (req) => {
    const url = new URL(req.url())
    if (url.origin !== ARCHIVE)
      return void req.abort()
    if (url.searchParams.has('page'))
      asked.push(Number(url.searchParams.get('page')))
    const reply = await answer(url)
    const { status = 200, headers = {}, body } = typeof reply === 'string' ? { body: reply } : reply
    void req.respond({ status, headers, contentType: 'text/html; charset=utf-8', body }).catch(() => {})
  })
  await tab.evaluateOnNewDocument(installMock, seed)
  await tab.evaluateOnNewDocument(relayWrites)
  return tab
}

/** Load the to-read page in `tab`, without the content script yet: its storage is live from here on. */
export async function loadToRead(tab) {
  await tab.goto(TO_READ, { waitUntil: 'domcontentloaded' })
}

/** Run the content script on the to-read page `tab` has loaded, and wait for the view to show works. */
export async function runToRead(tab) {
  await inject(tab)
  await tab.waitForSelector('.AO3E--search-view--results li.blurb')
}

/** Open the to-read page in `tab` and run the content script on it. */
export async function openToRead(tab) {
  await loadToRead(tab)
  await runToRead(tab)
}

/** What the view's *Updating…* note says, or null while it is off. */
export function updatingNote(tab) {
  return tab.$eval('.AO3E--search-view--updating-on .AO3E--search-view--updating-text', el => el.textContent.trim()).catch(() => null)
}

/** Whether `note` counts the pages of the list loaded so far, out of `total`. */
export function showsProgress(note, total = PAGES) {
  return new RegExp(`\\b\\d+\\b\\D+\\b${total}\\b`).test(note ?? '')
}

/** What AO3 says to wait, in seconds: long enough that a test sees the wait, and never sits it out. */
export const RETRY_AFTER = 90

/** Whether `line` says AO3 refused, counting down what is left of a {@link RETRY_AFTER} pause. */
export function waitsOutRefusal(line) {
  return mentions(line ?? '', WAIT_WORDS.refused) && /\b1:[23]\d\b/.test(line ?? '')
}

/** The note's Stop button, while it offers one. */
export function updatingStop(tab) {
  return tab.$('.AO3E--search-view--updating-on .AO3E--search-view--updating-stop:not([hidden])')
}

/** The titles of the works the view shows. */
export function shownTitles(tab) {
  return tab.evaluate(() =>
    Array.from(document.querySelectorAll('.AO3E--search-view--results > li.blurb'))
      .filter(li => !li.classList.contains('AO3E--search-view--hidden'))
      .map(li => li.querySelector('.header h4.heading a')?.textContent?.trim()))
}

/** The list's refresh claim, as the tab's storage holds it now. */
export function storedClaim(tab) {
  return tab.evaluate(async key => (await window.browser.storage.local.get(key))[key] ?? null, `listRefresh.${KEY}`)
}

/** All the live titles, in order. */
export function liveTitles(titles = 'Live') {
  return Array.from({ length: PAGES * PER_PAGE }, (_, i) => `${titles} work ${i + 1}`)
}
