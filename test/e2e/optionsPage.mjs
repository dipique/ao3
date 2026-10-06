import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { inflateSync } from 'node:zlib'

import { ensureBuilt, findChrome, installMock, launch, serveDist, sleep } from './helpers.mjs'

/**
 * The options page, opened the one way every e2e test opens it, and read
 * through hooks that hold still while its layout changes:
 *
 * - the categories the pane shows, by their `data-category`
 *   ({@link OptionsPage.shownCategories}), and the rail's links
 *   ({@link OptionsPage.rail}, {@link OptionsPage.railItems});
 * - a settings row by its anchor id ({@link OptionsPage.row});
 * - an editable list by its `data-list`, the list's rows by their
 *   `data-list-row`, and the count in its header by `data-list-count`
 *   ({@link OptionsPage.list}, {@link OptionsPage.listRows},
 *   {@link OptionsPage.listCount});
 * - a control inside either by its role and accessible name
 *   ({@link OptionsPage.control}), and what it is described by
 *   ({@link OptionsPage.description});
 * - what the page stored, read back from the storage mock rather than off the
 *   screen ({@link OptionsPage.stored}, {@link OptionsPage.lastWrite}), and
 *   the files it saved ({@link OptionsPage.lastDownload});
 * - a colour as it is drawn, for what only a screenshot shows
 *   ({@link OptionsPage.colourAt}), and colours as styles give them: an
 *   element's, a token's, and how well an element's text stands out from what
 *   is behind it ({@link OptionsPage.colour}, {@link OptionsPage.token},
 *   {@link OptionsPage.contrast}).
 *
 * It also stands in for AO3 ({@link stubArchive}), for a page that would ask
 * the archive for something, and for the background
 * ({@link scriptBackground}), and catches what a page saves
 * ({@link captureDownloads}).
 *
 * Not a test file itself.
 */

export const chromePath = findChrome()
export const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** Puppeteer's own default, so a test that names no size gets the window it always had. */
export const DEFAULT_VIEWPORT = { width: 800, height: 600 }

/**
 * The build, served, and Chrome, started: what a test file's `before` sets up
 * once for every options page it then opens with `open`. `scrollbars` draws
 * scrollbars that take room, as they do outside a test (see {@link launch}).
 */
export async function startOptions({ scrollbars = false } = {}) {
  ensureBuilt()
  const server = await serveDist()
  const browser = await launch(chromePath, { scrollbars })
  return {
    browser,
    server,
    /** {@link openOptions} in this browser, against this server. */
    open: options => openOptions(browser, server, options),
    close: async () => {
      await browser.close()
      await server.close()
    },
  }
}

/**
 * Open the options page in a new tab of `browser`, served by `server`.
 *
 * - `seed`: the extension storage the page starts with (see {@link installMock}).
 *   `runtime.getURL` names the build's own files, as it does in the extension.
 * - `hash`: where the page opens, such as `#sync-backups`.
 * - `viewport`: the window.
 * - `theme`: `'light'` or `'dark'`, the theme the page shows. The page follows
 *   the reader's choice in `option.theme`, so that is seeded as the choice,
 *   unless `seed` has an `option.theme` of its own; the system's preferred
 *   colour scheme is set to match.
 * - `prepare(page)`: whatever has to be in place before the page loads, such as
 *   request interception or a script of its own. It runs after the storage mock
 *   is installed, so a script can build on the mock.
 *
 * @returns {Promise<OptionsPage>} the page, once it has had time to read its
 *   options and draw them.
 */
export async function openOptions(browser, server, { seed = {}, hash = '', viewport = DEFAULT_VIEWPORT, theme, prepare } = {}) {
  const page = await browser.newPage()
  await page.setViewport(viewport)
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme ?? 'light' }])
  const messages = []
  page.on('console', m => messages.push({ type: m.type(), text: m.text() }))
  page.on('pageerror', e => messages.push({ type: 'pageerror', text: e.message }))
  const themed = theme && !('option.theme' in seed) ? { ...seed, 'option.theme': { chosen: theme, current: theme } } : seed
  await page.evaluateOnNewDocument(installMock, themed)
  // The page is served from the build's root, so a file the extension ships,
  // such as the bundled fandom index, is found where the extension finds it.
  await page.evaluateOnNewDocument(() => {
    window.browser.runtime.getURL = path => new URL(path, location.origin).href
  })
  await prepare?.(page)
  await page.goto(`${server.url}/options_ui/options_ui.html${hash}`, { waitUntil: 'networkidle2' })
  await sleep(1500)
  return new OptionsPage(page, messages)
}

/** Where every request the options page makes of AO3 goes. */
export const ARCHIVE = 'https://archiveofourown.org'

/**
 * Stand in for AO3 in `page`, so nothing reaches the real archive: call it
 * from `openOptions`' `prepare`. Every request to the archive is answered by
 * `answer(url)`, which gives, or promises, one of:
 *
 * - a response, `{ json }` or `{ status, headers, body }`. It is readable
 *   across origins, as the extension's own page would read it, since the page
 *   under test is plain localhost; `Retry-After` is readable too. It is never
 *   cached, so a request the page makes again reaches the stub again;
 * - `'fail'`: the network failing.
 *
 * @returns `asked`, the URLs the page asked for, in order, and `abandoned`,
 *   those it gave up on before an answer came.
 */
export async function stubArchive(page, answer) {
  const asked = []
  const abandoned = []
  await page.setRequestInterception(true)
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(ARCHIVE) && request.failure()?.errorText === 'net::ERR_ABORTED')
      abandoned.push(request.url())
  })
  page.on('request', async (request) => {
    const url = request.url()
    if (!url.startsWith(ARCHIVE))
      return void request.continue()
    asked.push(url)
    const reply = await answer(url)
    try {
      if (reply === 'fail') {
        await request.abort('internetdisconnected')
        return
      }
      const json = 'json' in reply
      await request.respond({
        status: reply.status ?? 200,
        contentType: json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        headers: {
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'Retry-After',
          'cache-control': 'no-store',
          ...reply.headers,
        },
        body: json ? JSON.stringify(reply.json) : (reply.body ?? ''),
      })
    }
    catch {
      // The page gave up on the request before the answer was ready.
    }
  })
  return { asked, abandoned }
}

/**
 * Stand in for the background: a page script, for `evaluateOnNewDocument` (in
 * `openOptions`' `prepare`). Each API message is answered from `replies`, by
 * method name: the value itself, `'never'` to leave it unanswered (as a
 * background too old to know the method does), or `'fail'` to reject it (as a
 * method that throws). A method with no reply is answered with nothing.
 *
 * The replies stay in `window.__replies`, for a test to change one between
 * messages, and every message is recorded ({@link OptionsPage.sent}).
 */
export function scriptBackground(replies) {
  window.__replies = { ...replies }
  window.__sent = []
  window.browser.runtime.sendMessage = (message) => {
    const [name] = Object.keys(message ?? {})
    window.__sent.push({ name, args: message?.[name] })
    const reply = window.__replies[name]
    if (reply === 'never')
      return new Promise(() => {})
    if (reply === 'fail')
      return Promise.reject(new Error(`${name} failed`))
    return Promise.resolve(reply)
  }
}

/**
 * Catch what `saveAs` hands the browser, instead of letting it hand it to the
 * browser: a page script, for `evaluateOnNewDocument` (in `openOptions`'
 * `prepare`, for the options page). A detached `<a download>` still starts a
 * real download in headless Chrome, which a test has nowhere to put and nothing
 * to say about; what it wants is the Blob itself. Each file is recorded in
 * `window.__downloads` as `{ name, url }`, and `window.__downloadBytes(url)`
 * gives its bytes in base64 ({@link OptionsPage.lastDownload} reads both).
 */
export function captureDownloads() {
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

/**
 * The elements a role names without saying so. A `role` attribute overrides the
 * element's own, so an element that has one is matched by that alone.
 */
const IMPLICIT_ROLES = {
  button: ['button', 'input[type="button"]', 'input[type="submit"]'],
  checkbox: ['input[type="checkbox"]'],
  link: ['a[href]'],
  radio: ['input[type="radio"]'],
  spinbutton: ['input[type="number"]'],
  textbox: ['input:not([type])', 'input[type="text"]', 'input[type="search"]', 'textarea'],
}

function roleSelector(role) {
  return [`[role="${role}"]`, ...(IMPLICIT_ROLES[role] ?? []).map(selector => `${selector}:not([role])`)].join(', ')
}

/**
 * What a screen reader calls an element, near enough for finding controls by:
 * `aria-labelledby`, `aria-label`, a `<label>` of its own, its text (unless it
 * is a field), then its tooltip or placeholder. Runs in the page.
 */
function accessibleName(el) {
  const squash = text => (text ?? '').replace(/\s+/g, ' ').trim()
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy)
    return squash(labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' '))
  if (el.getAttribute('aria-label'))
    return squash(el.getAttribute('aria-label'))
  const labels = squash([...el.labels ?? []].map(label => label.textContent).join(' '))
  if (labels)
    return labels
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
  if (!isField && squash(el.textContent))
    return squash(el.textContent)
  return squash(el.getAttribute('title') ?? el.getAttribute('placeholder'))
}

/** A string names exactly; a pattern is tested. */
function nameMatches(name, wanted) {
  return wanted instanceof RegExp ? wanted.test(name) : name === wanted
}

/**
 * The first pixel of a PNG Chrome drew, as `[r, g, b]`. A PNG's lines are
 * filtered against the pixels left of and above each one, and the first pixel
 * has neither, so whatever the filter, its bytes are the colour itself.
 */
function firstPixel(png) {
  const bytes = Buffer.from(png)
  const data = []
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const chunk = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR')
      assert.ok(chunk[8] === 8 && [2, 6].includes(chunk[9]), 'an 8-bit RGB or RGBA image')
    if (type === 'IDAT')
      data.push(chunk)
    at += 12 + length
  }
  const [, r, g, b] = inflateSync(Buffer.concat(data))
  return [r, g, b]
}

/**
 * WCAG's contrast ratio between two opaque colours, each `[r, g, b]`: 4.5 is
 * AA for text under 18.66 px bold or 24 px regular.
 */
export function contrastRatio(a, b) {
  const luminance = colour => colour
    .map(channel => channel / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** `top`, `[r, g, b, a]`, drawn over the opaque `[r, g, b]` under it. */
function over(top, under) {
  return under.map((channel, i) => top[i] * top[3] + channel * (1 - top[3]))
}

/**
 * The element's text colour, and the background colours behind it from its own
 * outwards, up to the first opaque one, each as `[r, g, b, a]`. Runs in the
 * page.
 */
function colourStack(el) {
  const rgba = (css) => {
    const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number)
    return [r, g, b, a]
  }
  const grounds = []
  for (let at = el; at; at = at.parentElement) {
    const ground = rgba(getComputedStyle(at).backgroundColor)
    if (ground[3] > 0)
      grounds.push(ground)
    if (ground[3] === 1)
      break
  }
  return { text: rgba(getComputedStyle(el).color), grounds }
}

/**
 * Throughout, a `scope` is the page itself or an element handle from it, and a
 * control's `name` is a string it must equal or a pattern it must match.
 */
export class OptionsPage {
  constructor(page, messages) {
    /** The Puppeteer page, for anything the hooks don't reach. */
    this.page = page
    /** Every console message and uncaught error, as `{ type, text }`. */
    this.messages = messages
  }

  /** The console errors and uncaught errors, as text, less any that `ignore` matches. */
  problems(ignore = null) {
    return this.messages
      .filter(m => (m.type === 'error' || m.type === 'pageerror') && !ignore?.test(m.text))
      .map(m => m.text)
  }

  /** The ids of the categories the pane shows, in the order it shows them. */
  shownCategories() {
    return this.page.$$eval('[data-category]', els => els.filter(el => el.checkVisibility()).map(el => el.dataset.category))
  }

  /** The category rail: a column beside the pane, or a row of chips under the top bar on a narrow window. */
  async rail() {
    const handle = await this.page.$('[data-rail]')
    assert.ok(handle, 'no rail')
    return handle
  }

  /**
   * The rail's links as they are drawn, in order, each as `{ kind, id, name,
   * count, current }`: `kind` is `'category'` or `'subsection'`, `id` is the
   * anchor it links to, `name` is its label, `count` is the number beside it
   * (or null), and `current` says whether it is the current category.
   */
  railItems() {
    return this.page.$$eval('[data-rail] [data-rail-item]', links => links.filter(a => a.checkVisibility()).map(a => ({
      kind: a.dataset.railItem,
      id: decodeURIComponent(a.hash.slice(1)),
      name: a.querySelector('[data-rail-label]')?.textContent.trim() ?? '',
      count: a.querySelector('[data-rail-count]')?.checkVisibility() ? Number(a.querySelector('[data-rail-count]').textContent) : null,
      current: a.getAttribute('aria-current') === 'true',
    })))
  }

  /** The settings row with this anchor id: the id a `#hash` to it names. */
  async row(id) {
    const handle = await this.page.$(`[id="${id}"]`)
    assert.ok(handle, `no settings row #${id}`)
    return handle
  }

  /** The editable list with this `data-list`: its rows, its empty state and its own controls. */
  async list(id) {
    const handle = await this.page.$(`[data-list="${id}"]`)
    assert.ok(handle, `no list "${id}"`)
    return handle
  }

  /** The list's rows, in the order they are drawn. */
  async listRows(id) {
    return (await this.list(id)).$$('[data-list-row]')
  }

  /** One of the list's rows, by its `data-list-row`. */
  async listRow(id, rowId) {
    const handle = await (await this.list(id)).$(`[data-list-row="${rowId}"]`)
    assert.ok(handle, `no row "${rowId}" in list "${id}"`)
    return handle
  }

  /** The `data-list-row` of each of the list's rows, in the order they are drawn. */
  async listRowIds(id) {
    return (await this.list(id)).$$eval('[data-list-row]', els => els.map(el => el.dataset.listRow))
  }

  /** The count in the list's header, as it reads. */
  async listCount(id) {
    const handle = await (await this.list(id)).$('[data-list-count]')
    assert.ok(handle, `no count in list "${id}"`)
    return this.text(handle)
  }

  /**
   * The colour drawn at one point of the window, by its distance from the
   * window's top left corner, as `[r, g, b]`: for what only shows on screen,
   * such as a shadow painted as a background.
   */
  async colourAt(x, y) {
    const scroll = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    const png = await this.page.screenshot({
      clip: { x: scroll.x + x, y: scroll.y + y, width: 1, height: 1 },
      captureBeyondViewport: false,
    })
    return firstPixel(png)
  }

  /** The element's computed colour (`color`, unless `property` names another), as `[r, g, b]`. */
  colour(handle, property = 'color') {
    return handle.evaluate((el, p) => getComputedStyle(el)[p].match(/[\d.]+/g).slice(0, 3).map(Number), property)
  }

  /** A colour token in the theme the page shows, such as `default-fg`, as `[r, g, b]`. */
  token(name) {
    return this.page.evaluate(n => getComputedStyle(document.body).getPropertyValue(`--color-${n}`).trim().split(/\s+/).map(Number), name)
  }

  /**
   * The contrast ratio of the element's text against what is drawn behind it
   * ({@link contrastRatio}), with a colour or background that is partly
   * transparent laid over what is under it.
   */
  async contrast(handle) {
    const { text, grounds } = await handle.evaluate(colourStack)
    const ground = grounds.reduceRight((under, layer) => over(layer, under), [255, 255, 255])
    return contrastRatio(over(text, ground), ground)
  }

  /** Every control in `scope` with this role (and, given one, this name), in document order. */
  async controls(scope, role, name) {
    const found = await scope.$$(roleSelector(role))
    if (name === undefined)
      return found
    const named = []
    for (const handle of found) {
      if (nameMatches(await this.name(handle), name))
        named.push(handle)
    }
    return named
  }

  /** The first control in `scope` with this role (and, given one, this name). */
  async control(scope, role, name) {
    const [handle] = await this.controls(scope, role, name)
    assert.ok(handle, `no ${role}${name === undefined ? '' : ` named ${name}`}`)
    return handle
  }

  /** What a screen reader would call the element. */
  name(handle) {
    return handle.evaluate(accessibleName)
  }

  /** What a screen reader would read after the element's name: the text its `aria-describedby` points to. */
  description(handle) {
    return handle.evaluate(el => (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
  }

  /** Click the element from inside the page, where nothing drawn over it can take the click instead. */
  press(handle) {
    return handle.evaluate(el => el.click())
  }

  /** The element's text, its whitespace collapsed. */
  text(handle) {
    return handle.evaluate(el => el.textContent.replace(/\s+/g, ' ').trim())
  }

  /**
   * The element's text as it is laid out, one entry per line, blank lines
   * dropped. `innerText`, since it is the layout that breaks the lines.
   */
  lines(handle) {
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content
    return handle.evaluate(el => el.innerText.split('\n').map(line => line.trim()).filter(Boolean))
  }

  /** What the extension's storage holds under `key` now, or null. */
  stored(key) {
    return this.page.evaluate(async k => (await window.browser.storage.local.get(k))[k] ?? null, key)
  }

  /** The last value the page wrote to `key`, or null if it never wrote one. */
  lastWrite(key) {
    return this.page.evaluate(k => window.__writes.filter(w => k in w).map(w => w[k]).at(-1) ?? null, key)
  }

  /** The arguments of each `name` message the page sent, in order: with {@link scriptBackground} in the page. */
  sent(name) {
    return this.page.evaluate(n => window.__sent.filter(m => m.name === n).map(m => m.args), name)
  }

  /** The messages of the toasts on screen, oldest first. */
  toasts() {
    return this.page.evaluate(() => [...document.body.children]
      .flatMap(el => [...el.shadowRoot?.querySelectorAll('.toast') ?? []])
      .filter(toast => toast.style.visibility !== 'hidden')
      .map(toast => toast.querySelector('.message')?.textContent.replace(/\s+/g, ' ').trim() ?? ''))
  }

  /**
   * The last file the page handed the browser to save, as `{ name, text }`, or
   * null if it handed none: with {@link captureDownloads} in the page.
   */
  async lastDownload() {
    const record = await this.page.evaluate(() => window.__downloads.at(-1) ?? null)
    if (!record)
      return null
    const base64 = await this.page.evaluate(url => window.__downloadBytes(url), record.url)
    return { name: record.name, text: Buffer.from(base64, 'base64').toString('utf-8') }
  }

  close() {
    return this.page.close()
  }
}
