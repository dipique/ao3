import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { DIST, ensureBuilt, findChrome, installMock, launch } from '../helpers.mjs'
import { contrastRatio } from '../optionsPage.mjs'
import { rerun, settled } from '../trackedPages.mjs'

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
  body { background: #fff; color: #2a2a2a; font: 100%/1.125 'Lucida Grande', 'Lucida Sans Unicode', Verdana, Helvetica, sans-serif; }
  #header .heading a { color: #900; }
  input, textarea { font: 100% 'Lucida Grande', 'Lucida Sans Unicode', Verdana, Helvetica, sans-serif; width: 100%; border: 1px solid #bbb; }
  select { vertical-align: text-top; width: 100%; min-width: 10.5em; }
  .actions a, .actions input, input[type="submit"], button { font-size: 100%; line-height: 1.286; height: 1.286em; display: inline-block; padding: 0.25em 0.75em; border: 1px solid #bbb; border-radius: 0.25em; }
  input[type="submit"] { height: auto; }`

const PAGE = `<!doctype html>
<html><head><title>Works</title>
<link rel="stylesheet" type="text/css" media="screen" href="/stylesheets/skins/skin_1_default/1_site_screen_.css" />
</head>
<body class="logged-in">
  <div id="header"><h1 class="heading"><a href="/">Archive of Our Own</a></h1></div>
  <div id="main"><h2 class="heading">1 - 20 of 235 Works in A Fandom</h2>
    <ul class="navigation actions"><li><a href="/tags/A%20Fandom/bookmarks">Bookmarks</a></li></ul>
    <form class="filters"><p class="submit actions"><input type="submit" id="go" value="Sort and Filter"></p><input type="text" id="tag-search"><select id="sort-by"><option>Date Updated</option></select></form>
    <ol class="work index group"><li class="work blurb group" id="work_1">A work</li></ol>
    <div class="AO3E--search-view--sel AO3E--search-view--sel-require"><span class="AO3E--search-view--sel-label">Required</span></div>
    <div class="AO3E--search-view--sel AO3E--search-view--sel-include"><span class="AO3E--search-view--sel-label">Included</span></div>
    <div class="AO3E--search-view--sel AO3E--search-view--sel-exclude"><span class="AO3E--search-view--sel-label">Excluded</span></div>
    <button type="button" class="AO3E--dashboard-rail" style="display: block">Show the sidebar</button>
    <form class="filters" id="sidebar-filters"><dl>
      <dd class="include"><ul><li><label for="inc"><input type="checkbox" id="inc" checked><span class="indicator" aria-hidden="true"></span><span>F/M (84)</span></label></li>
        <li><label for="inc-off"><input type="checkbox" id="inc-off"><span class="indicator" aria-hidden="true"></span><span>Gen (63)</span></label></li></ul></dd>
      <dd class="exclude"><ul><li><label for="exc"><input type="checkbox" id="exc" checked><span class="indicator" aria-hidden="true"></span><span>A Fandom (12)</span></label></li></ul></dd>
    </dl></form>
    <aside class="AO3E--search-view--sidebar" style="width: 240px">
      <div class="AO3E--search-view--field"><label class="AO3E--search-view--label">Word count</label><input type="number" class="AO3E--search-view--input"></div>
      <button type="button" class="AO3E--search-view--reset">Reset filters</button>
    </aside>
  </div>
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
  let css

  before(async () => {
    ensureBuilt()
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    browser = await launch(chromePath)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /**
   * Load the listing with `seed` in storage. `remembered` pre-fills the page's
   * own localStorage the way a previous page would have; `stalled` makes the
   * extension's storage never answer, leaving only what was remembered — so the
   * content script never finishes a run, and what the page holds once it has
   * loaded is all it will.
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
    // The manifest's stylesheet, ahead of every sheet the page brings, as the
    // browser cascades it.
    await tab.evaluateOnNewDocument((css) => {
      const style = document.createElement('style')
      style.textContent = css
      const put = () => document.documentElement.prepend(style)
      if (document.documentElement)
        return put()
      const wait = new MutationObserver(() => {
        if (!document.documentElement)
          return
        wait.disconnect()
        put()
      })
      wait.observe(document, { childList: true })
    }, css)
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
    if (!stalled)
      await settled(tab)
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

  const setOption = (tab, value) => rerun(tab, () => tab.evaluate(v => window.chrome.storage.local.set({ 'option.darkSkin': v }), value))

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
    const off = await state(tab)
    await tab.close()
    assert.equal(on.remembered, '1')
    assert.notEqual(off.remembered, '1')
  })

  test('switching it off takes it away without a reload', async () => {
    const tab = await load(ON)
    await setOption(tab, false)
    const s = await state(tab)
    await tab.close()
    assert.equal(s.skin, false, 'the skin is gone')
    assert.equal(s.body, 'rgb(255, 255, 255)', 'AO3\'s own background is back')
    assert.equal(s.surfaces, 'light', 'and the surfaces went back with it')
  })

  test('switching it on applies it without a reload', async () => {
    const tab = await load({})
    await setOption(tab, true)
    const s = await state(tab)
    await tab.close()
    assert.ok(s.afterAo3, 'the skin comes after AO3\'s own stylesheet')
    assert.equal(s.body, 'rgb(9, 9, 11)')
    assert.equal(s.surfaces, 'dark')
  })

  /** Each element's computed `props`, by selector. */
  const computed = (tab, selectors, props) => tab.evaluate((selectors, props) => Object.fromEntries(selectors.map((sel) => {
    const style = getComputedStyle(document.querySelector(sel))
    return [sel, Object.fromEntries(props.map(p => [p, style.getPropertyValue(p).trim()]))]
  })), selectors, props)

  test('controls and boxes take the options page\'s shapes', async () => {
    const tab = await load(ON)
    const controls = ['#main .actions a', '#go', '#tag-search']
    const s = await computed(tab, [...controls, 'li.blurb'], ['border-top-left-radius', 'background-color', 'border-top-color'])
    await tab.close()
    for (const sel of controls)
      assert.equal(s[sel]['border-top-left-radius'], '7px', `${sel} is rounded like an options control`)
    assert.equal(s['li.blurb']['border-top-left-radius'], '9px', 'a blurb is rounded like an options panel')
    assert.equal(s['#main .actions a']['background-color'], 'rgb(9, 9, 11)', 'a button sits on the page\'s ground')
    assert.equal(s['#main .actions a']['border-top-color'], 'rgb(63, 63, 70)', 'framed in the border token')
  })

  test('a select stands as tall as a text field and a button, and neither spills out of its column', async () => {
    // AO3 sizes neither a select's text nor its padding, so the browser's own
    // leave it a few pixels short of the fields and buttons beside it -- which
    // shows once the skin gives them all one flat frame. AO3's fields are also
    // a full-width content box, which any padding pushes past the column.
    const tab = await load(ON)
    const boxes = await tab.evaluate(() => ['#sort-by', '#tag-search', '#go'].map((sel) => {
      const el = document.querySelector(sel)
      return { height: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right, column: el.parentElement.getBoundingClientRect().right }
    }))
    await tab.close()
    const [select, field, button] = boxes
    assert.ok(Math.abs(select.height - field.height) <= 1, `select ${select.height}px, text field ${field.height}px`)
    assert.ok(Math.abs(select.height - button.height) <= 1, `select ${select.height}px, button ${button.height}px`)
    for (const [name, box] of [['select', select], ['text field', field]])
      assert.ok(box.right <= box.column + 0.5, `${name} ends at ${box.right}px, its column at ${box.column}px`)
  })

  test('the filter sidebar\'s submit is the one filled button', async () => {
    const tab = await load(ON)
    const s = await computed(tab, ['#go'], ['background-color', 'color'])
    await tab.close()
    assert.equal(s['#go']['background-color'], 'rgb(153, 0, 0)', 'primary fill')
    assert.equal(s['#go'].color, 'rgb(255, 255, 255)')
  })

  test('the extension\'s menus and popovers take the options page\'s popover colours', async () => {
    const tab = await load(ON)
    const tokens = await tab.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return ['bg', 'border', 'divider'].map(name => style.getPropertyValue(`--ao3e-surface-${name}`).trim())
    })
    await tab.close()
    assert.deepEqual(tokens, ['#1f1f23', '#3f3f46', '#2a2a2f'], 'popover, border and hairline tokens')
  })

  test('the search view\'s require, include and exclude labels read on the dark ground', async () => {
    const tab = await load(ON)
    const colours = await tab.evaluate(() => ['require', 'include', 'exclude'].map((kind) => {
      const el = document.querySelector(`.AO3E--search-view--sel-${kind} .AO3E--search-view--sel-label`)
      return [kind, getComputedStyle(el).color.match(/\d+/g).slice(0, 3).map(Number)]
    }))
    await tab.close()
    for (const [kind, colour] of colours) {
      const ratio = contrastRatio(colour, [9, 9, 11])
      assert.ok(ratio >= 4.5, `${kind} label is ${ratio.toFixed(2)}:1 on the ground`)
    }
  })

  test('the extension\'s own buttons keep their own hover', async () => {
    // The skin frames AO3's buttons on hover; the folded dashboard's rail is a
    // button too, and has to stay the red it copied from the dashboard's band.
    const tab = await load(ON)
    const rest = await computed(tab, ['.AO3E--dashboard-rail'], ['background-color'])
    await tab.hover('.AO3E--dashboard-rail')
    const hovered = await computed(tab, ['.AO3E--dashboard-rail'], ['background-color'])
    await tab.close()
    assert.equal(hovered['.AO3E--dashboard-rail']['background-color'], rest['.AO3E--dashboard-rail']['background-color'])
  })

  test('the search view\'s Reset filters is a ghost button at the end of the column, not the last field\'s', async () => {
    const tab = await load(ON)
    const s = await tab.evaluate(() => {
      const reset = document.querySelector('.AO3E--search-view--reset')
      const column = reset.parentElement.getBoundingClientRect()
      const box = reset.getBoundingClientRect()
      return { width: box.width, column: column.width, right: column.right - box.right, background: getComputedStyle(reset).backgroundColor }
    })
    await tab.close()
    assert.ok(s.width < s.column / 2, `${s.width}px of a ${s.column}px column`)
    assert.ok(s.right < 1, 'at the end of the column')
    assert.equal(s.background, 'rgba(0, 0, 0, 0)', 'no fill until hovered')
  })

  test('a ticked filter box is framed in its own colour, an unticked one in the border\'s', async () => {
    const tab = await load(ON)
    const frames = await tab.evaluate(() => Object.fromEntries(['inc', 'inc-off', 'exc'].map(id =>
      [id, getComputedStyle(document.querySelector(`#${id} + .indicator`), '::before').borderTopColor])))
    await tab.close()
    assert.deepEqual(frames, {
      'inc': 'rgb(74, 222, 128)',
      'inc-off': 'rgb(63, 63, 70)',
      'exc': 'rgb(217, 102, 102)',
    })
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
