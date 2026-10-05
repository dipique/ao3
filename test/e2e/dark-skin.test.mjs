import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/tags/A%20Fandom/works'
const ON = { 'option.darkSkin': true }

/**
 * Stands in for AO3's own skin: the same selectors, so every rule the dark skin
 * sets meets one of exactly equal specificity, and only the order the two
 * arrive in decides which wins.
 */
const AO3_CSS = `
  body { background: #fff; color: #2a2a2a; }
  #header .heading a { color: #900; }`

const PAGE = `<!doctype html>
<html><head><title>Works</title>
<link rel="stylesheet" type="text/css" media="screen" href="/stylesheets/skins/skin_1_default/1_site_screen_.css" />
</head>
<body class="logged-in">
  <div id="header"><h1 class="heading"><a href="/">Archive of Our Own</a></h1></div>
  <div id="main"><h2 class="heading">1 - 20 of 235 Works in A Fandom</h2></div>
</body></html>`

/**
 * The opt-in dark skin. It has to come after AO3's stylesheets, so that it wins
 * ties the way a site skin chosen on AO3 does, and it has to be in place before
 * the page is first painted, or every page load flashes white.
 *
 * The content script is loaded the way `document_start` loads it -- before a
 * byte of the page is parsed -- rather than after it, as most of the suite does,
 * because both properties are about exactly that window.
 */
describe('the dark skin', { skip }, () => {
  let browser
  let js

  before(async () => {
    ensureBuilt()
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /**
   * Load the listing with `seed` in storage. `remembered` pre-fills the page's
   * own localStorage the way a previous page would have; `stalled` makes the
   * extension's storage never answer, leaving only what was remembered.
   */
  const load = async (seed, { remembered = null, stalled = false } = {}) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      const url = req.url()
      if (url.endsWith('.css'))
        void req.respond({ status: 200, contentType: 'text/css', body: AO3_CSS })
      else if (url.startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: PAGE })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.evaluateOnNewDocument((remembered, stalled) => {
      // The page's localStorage outlives the tab, so each test starts from its own.
      if (remembered === null)
        localStorage.removeItem('ao3e:dark-skin')
      else
        localStorage.setItem('ao3e:dark-skin', remembered)
      if (stalled)
        window.chrome.storage.local.get = () => new Promise(() => {})
    }, remembered, stalled)
    await tab.evaluateOnNewDocument(js)
    // After the content script, so that in the microtask where <body> first
    // appears, this runs after anything the content script does in it: what it
    // sees is what the first paint could see.
    await tab.evaluateOnNewDocument(() => {
      window.__skinAtBody = null
      const watch = new MutationObserver(() => {
        if (!document.body)
          return
        window.__skinAtBody = !!document.querySelector('style[data-ao3e-dark-skin]')
        watch.disconnect()
      })
      watch.observe(document, { childList: true, subtree: true })
    })
    await tab.goto(LISTING_URL, { waitUntil: 'load' })
    await sleep(1500)
    return tab
  }

  const state = tab => tab.evaluate(() => {
    const skin = document.querySelector('style[data-ao3e-dark-skin]')
    const sheets = [...document.styleSheets].map(s => s.ownerNode)
    const ao3 = document.querySelector('link[rel="stylesheet"]')
    return {
      skin: !!skin,
      // The extension's own tweak sheet may follow it; what matters is AO3's.
      afterAo3: !!skin && sheets.indexOf(skin) > sheets.indexOf(ao3),
      atBody: window.__skinAtBody,
      body: getComputedStyle(document.body).backgroundColor,
      title: getComputedStyle(document.querySelector('#header .heading a')).color,
      surfaces: document.documentElement.dataset.ao3eTheme ?? null,
      remembered: localStorage.getItem('ao3e:dark-skin'),
    }
  })

  const setOption = (tab, value) => tab.evaluate(v => window.chrome.storage.local.set({ 'option.darkSkin': v }), value)

  test('is off unless asked for', async () => {
    const tab = await load({})
    const s = await state(tab)
    await tab.close()
    assert.equal(s.skin, false, 'no skin on the page')
    assert.equal(s.body, 'rgb(255, 255, 255)', 'AO3\'s own background stands')
    assert.equal(s.surfaces, 'light')
  })

  test('switched on, it comes after AO3\'s sheets and wins their ties', async () => {
    const tab = await load(ON)
    const s = await state(tab)
    await tab.close()
    assert.ok(s.skin, 'the skin is on the page')
    assert.ok(s.afterAo3, 'and it comes after AO3\'s own stylesheet')
    assert.equal(s.body, 'rgb(9, 9, 11)', 'the page ground is the dark token')
    assert.equal(s.title, 'rgb(217, 102, 102)', 'AO3 red as text becomes brand-fg')
  })

  test('the extension\'s own surfaces follow it', async () => {
    // "Use theme from AO3" reads the page's background, which the skin sets.
    const tab = await load(ON)
    const s = await state(tab)
    await tab.close()
    assert.equal(s.surfaces, 'dark')
  })

  test('it is in place before the page body can be painted', async () => {
    const tab = await load(ON)
    const s = await state(tab)
    await tab.close()
    assert.equal(s.atBody, true, 'present when <body> first appeared')
  })

  test('the next page applies it from memory, before the settings are read', async () => {
    const tab = await load(ON, { remembered: '1', stalled: true })
    const s = await state(tab)
    await tab.close()
    assert.equal(s.atBody, true, 'present when <body> first appeared')
    assert.ok(s.afterAo3, 'and still after AO3\'s own stylesheet')
  })

  test('nothing remembered and nothing read yet: no skin', async () => {
    const tab = await load(ON, { stalled: true })
    const s = await state(tab)
    await tab.close()
    assert.equal(s.skin, false)
  })

  test('the setting is remembered for the next page', async () => {
    const tab = await load(ON)
    const on = await state(tab)
    await setOption(tab, false)
    await sleep(1500)
    const off = await state(tab)
    await tab.close()
    assert.equal(on.remembered, '1')
    assert.notEqual(off.remembered, '1')
  })

  test('switching it off takes it away without a reload', async () => {
    const tab = await load(ON)
    await setOption(tab, false)
    await sleep(1500)
    const s = await state(tab)
    await tab.close()
    assert.equal(s.skin, false, 'the skin is gone')
    assert.equal(s.body, 'rgb(255, 255, 255)', 'AO3\'s own background is back')
    assert.equal(s.surfaces, 'light', 'and the surfaces went back with it')
  })

  test('switching it on applies it without a reload', async () => {
    const tab = await load({})
    await setOption(tab, true)
    await sleep(1500)
    const s = await state(tab)
    await tab.close()
    assert.ok(s.afterAo3, 'the skin comes after AO3\'s own stylesheet')
    assert.equal(s.body, 'rgb(9, 9, 11)')
    assert.equal(s.surfaces, 'dark')
  })

  test('a stale memory gives way to the setting', async () => {
    // Switched off on another device: this one still remembers "on" until the
    // synced setting is read, and then has to let go of it.
    const tab = await load({}, { remembered: '1' })
    const s = await state(tab)
    await tab.close()
    assert.equal(s.skin, false)
    assert.notEqual(s.remembered, '1')
  })
})
