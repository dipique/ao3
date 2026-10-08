import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { inject, menuGuardOver, openMenu } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/works'
const FLUFF_URL = 'https://archiveofourown.org/tags/Fluff/works'

// `openMenuOnClick` is on, so a plain left-click on a tag link opens our menu
// instead of following it — the "fully hijacked" case Ctrl+Shift has to undo.
// The highlight rule gives the Fluff tag an indicator: our own span, sitting
// beside the link, with no native click behaviour of its own.
const SEED = {
  'option.tagToolbar': true,
  'option.openMenuOnClick': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [{ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight' }],
  },
}

const PAGE_HTML = `<!doctype html>
<html><head><title>Works</title></head>
<body>
  <div id="main">
    <ol class="work index group">
      <li class="blurb work" id="blurb">
        <h4 class="heading"><a href="/works/1">A work</a></h4>
        <ul class="tags commas">
          <li class="freeforms"><a class="tag" id="tag-fluff" href="/tags/Fluff/works">Fluff</a></li>
        </ul>
      </li>
    </ol>
    <form id="work-filters">
      <input type="text" name="work_search[other_tag_names]" id="work_search_other_tag_names">
      <input type="text" name="work_search[excluded_tag_names]" id="work_search_excluded_tag_names">
    </form>
  </div>
</body></html>`

/**
 * Shift as the "stand back" chord: for one gesture the extension gets out of the
 * way and the element behaves the way the browser would have it. Shift alone, so
 * that anything else held is still the browser's to read — Ctrl+Shift+click has
 * to keep meaning "open in a new tab".
 *
 * Driven with real mouse and keyboard input rather than synthetic events, since
 * what's under test is partly the *browser's* own handling of a modified click.
 * Navigations away from the fixture are intercepted and aborted, so the page (and
 * the injected content script) survive to be asserted on.
 */
describe('Shift bypass', { skip }, () => {
  let browser
  let page
  /** Main-frame navigations the page attempted, recorded then aborted. */
  let mount
  let navigations = []
  /** URLs opened in a new tab or window (whether by the browser or by us). */
  let newTabs = []

  before(async () => {
    ensureBuilt()

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        // A modified click opens a real new tab/window, which our per-page
        // request interception doesn't cover. Fail DNS browser-wide so nothing
        // can reach archiveofourown.org for real; the fixture is served from the
        // interceptor, which sits in front of the network.
        '--host-resolver-rules=MAP * ~NOTFOUND',
      ],
    })
    browser.on('targetcreated', (target) => {
      // Opening a window also spins up Chrome's own UI targets (omnibox popup and
      // friends); only real page URLs are of interest here.
      if (/^https?:/.test(target.url()))
        newTabs.push(target.url())
    })

    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url() === LISTING_URL) {
        void req.respond({ status: 200, contentType: 'text/html', body: PAGE_HTML })
        return
      }
      // Anything else the page tries to reach is a navigation we want to observe
      // without actually leaving: record it, then abort so nothing commits.
      if (req.isNavigationRequest())
        navigations.push(req.url())
      void req.abort()
    })

    await page.evaluateOnNewDocument(installMock, SEED)

    // Load the fixture and decorate it. Repeatable: a gesture that navigates in
    // the same tab lands on an aborted-navigation error page, taking the
    // decorated DOM with it, and beforeEach puts it back.
    mount = async () => {
      await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
      await inject(page)
      // Registered after the content script, on the same node and phase, so it
      // runs after the extension's handler and sees whatever it decided — and
      // survives the stopPropagation() the extension calls when it takes over.
      await page.evaluate(() => {
        window.__events = []
        const record = e => window.__events.push({ type: e.type, prevented: e.defaultPrevented })
        document.addEventListener('contextmenu', record, true)
        document.addEventListener('click', record, true)
      })
    }
    await mount()
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    // Put the fixture back if the previous gesture navigated off it.
    if (page.url() !== LISTING_URL || !(await page.$('#blurb')))
      await mount()
    await page.evaluate(() => {
      window.__events = []
      document.querySelectorAll('.AO3E--menu').forEach(el => el.remove())
    })
  })

  /**
   * What a gesture that opens no menu of ours is waited out for: the page's own
   * listener hearing the event, after the extension's has had its say; or the
   * link being opened, in this tab or another, whether the browser opened it or
   * we did.
   */
  const OUTCOMES = {
    event: () => page.evaluate(() => window.__events.length > 0),
    open: () => navigations.length + newTabs.length > 0,
  }

  /**
   * Click `selector` for real while holding `keys`, wait for its `outcome` (our
   * `menu` opening, or one of {@link OUTCOMES}), and report what followed.
   * Waiting for what the gesture brings about, rather than for a while, is what
   * keeps a tab the browser is slow to open counted against its own gesture,
   * and not the next one. Every gesture first sits out what is left of the
   * menu guard ({@link menuGuardOver}), which would otherwise swallow whatever
   * menu it opens: the one it should, or one it should not have.
   */
  async function gesture(selector, { button = 'left', keys = [], outcome }) {
    await menuGuardOver(page)
    navigations = []
    newTabs = []
    const click = async () => {
      for (const key of keys)
        await page.keyboard.down(key)
      try {
        await page.click(selector, { button })
      }
      finally {
        for (const key of [...keys].reverse())
          await page.keyboard.up(key)
      }
    }
    if (outcome === 'menu') {
      await openMenu(page, click)
    }
    else {
      await click()
      await until(`the ${outcome} to follow`, OUTCOMES[outcome])
    }
    // A modified click can open a *foreground* tab, which backgrounds ours
    // — and puppeteer can't drive input on a backgrounded tab. Close whatever
    // opened and take the focus back before the next gesture.
    for (const other of await browser.pages()) {
      if (other !== page)
        await other.close()
    }
    await page.bringToFront()
    return {
      events: await page.evaluate(() => window.__events),
      menu: (await page.$('.AO3E--menu')) !== null,
      // Either route counts as "the link was opened": a same-tab navigation, or a
      // new tab/window — whether the browser opened it or we did.
      opened: [...navigations, ...newTabs],
    }
  }

  const INDICATOR = '#blurb .AO3E--indicators'
  const SHIFT = ['Shift']
  const CTRL_SHIFT = ['Control', 'Shift']

  /**
   * A browser under load can open a modified click's tab well after the click
   * itself has been handled. A link here stands in for that: its click is
   * handled at once, and the tab it opens is held back until the test lets it
   * go (`window.__openLate()`), once the click has reached the page.
   */
  const LATE_URL = 'https://archiveofourown.org/tags/Late/works'

  test('a tab the browser is slow to open is its own gesture\'s, and not the next one\'s', async () => {
    await page.evaluate((url) => {
      const link = document.createElement('a')
      link.id = 'late'
      link.href = url
      link.textContent = 'Opens late'
      const held = new Promise((resolve) => {
        window.__openLate = resolve
      })
      link.addEventListener('click', (event) => {
        event.preventDefault()
        void held.then(() => window.open(url, '_blank'))
      })
      document.getElementById('main').append(link)
    }, LATE_URL)

    const opening = gesture('#late', { outcome: 'open' })
    await until('the click to reach the page', () => page.evaluate(() => window.__events.some(e => e.type === 'click')))
    await page.evaluate(() => window.__openLate())
    const late = await opening
    assert.deepEqual(late.opened, [LATE_URL])

    const next = await gesture('#tag-fluff', { button: 'right', outcome: 'menu' })
    assert.equal(next.menu, true)
    assert.deepEqual(next.opened, [], 'the slow tab was counted where it belonged')
  })

  test('the highlighted tag got an indicator to aim at', async () => {
    assert.equal(await page.$(INDICATOR) !== null, true)
  })

  // --- Right-click ---------------------------------------------------------

  test('a plain right-click on a link opens our menu', async () => {
    const r = await gesture('#tag-fluff', { button: 'right', outcome: 'menu' })
    assert.equal(r.menu, true)
    assert.deepEqual(r.events, [{ type: 'contextmenu', prevented: true }])
  })

  test('Shift+right-click on a link leaves the native menu alone', async () => {
    const r = await gesture('#tag-fluff', { button: 'right', keys: SHIFT, outcome: 'event' })
    assert.equal(r.menu, false)
    assert.deepEqual(r.events, [{ type: 'contextmenu', prevented: false }])
  })

  test('Shift+right-click on an indicator leaves the native menu alone', async () => {
    const r = await gesture(INDICATOR, { button: 'right', keys: SHIFT, outcome: 'event' })
    assert.equal(r.menu, false)
    assert.deepEqual(r.events, [{ type: 'contextmenu', prevented: false }])
  })

  test('a plain right-click on an indicator still opens our menu', async () => {
    const r = await gesture(INDICATOR, { button: 'right', outcome: 'menu' })
    assert.equal(r.menu, true)
    assert.deepEqual(r.events, [{ type: 'contextmenu', prevented: true }])
  })

  // --- Left-click, no navigation -------------------------------------------

  test('with openMenuOnClick, a plain click on a link opens the menu instead of navigating', async () => {
    const r = await gesture('#tag-fluff', { outcome: 'menu' })
    assert.equal(r.menu, true)
    assert.deepEqual(r.opened, [], 'the link must not have been followed')
  })

  test('a plain click on an indicator still opens its menu', async () => {
    const r = await gesture(INDICATOR, { outcome: 'menu' })
    assert.equal(r.menu, true)
    assert.deepEqual(r.opened, [])
  })

  // --- Left-click that follows the link ------------------------------------

  test('Shift+click on a link is left to the browser', async () => {
    const r = await gesture('#tag-fluff', { keys: SHIFT, outcome: 'open' })
    assert.equal(r.menu, false, 'our menu must not open')
    assert.ok(r.events.every(e => !e.prevented), 'the browser must still be free to handle it')
    assert.deepEqual(r.opened, [FLUFF_URL])
  })

  test('Ctrl+Shift+click on a link still reaches the browser as "new tab"', async () => {
    // The whole point of Shift (not Ctrl+Shift) being the chord: Ctrl is left for
    // the browser to read, so the habit of Ctrl+Shift+click for a new foreground
    // tab keeps working on a link we have otherwise hijacked.
    const r = await gesture('#tag-fluff', { keys: CTRL_SHIFT, outcome: 'open' })
    assert.equal(r.menu, false, 'our menu must not open')
    assert.ok(r.events.every(e => !e.prevented), 'the browser must still be free to handle it')
    assert.deepEqual(r.opened, [FLUFF_URL])
    assert.equal(newTabs.length, 1, 'the browser should have opened it in a new tab')
  })

  test('Shift+click on an indicator opens the link it belongs to, here', async () => {
    const r = await gesture(INDICATOR, { keys: SHIFT, outcome: 'open' })
    assert.equal(r.menu, false, 'our menu must not open')
    // An indicator is a span beside the link, so nothing would happen at all
    // unless we stand in for the menu's "Open" row.
    assert.deepEqual(r.opened, [FLUFF_URL])
    assert.equal(newTabs.length, 0, 'no modifier for "new tab" was held')
  })

  test('Ctrl+Shift+click on an indicator opens it in a new tab', async () => {
    // Standing in for the menu's "Open in new tab" row — the modifier the browser
    // would have read on a real link is read here instead.
    const r = await gesture(INDICATOR, { keys: CTRL_SHIFT, outcome: 'open' })
    assert.equal(r.menu, false, 'our menu must not open')
    assert.deepEqual(r.opened, [FLUFF_URL])
    assert.equal(newTabs.length, 1)
  })
})
