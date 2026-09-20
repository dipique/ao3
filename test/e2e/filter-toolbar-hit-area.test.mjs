import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

// tagToolbar alone is enough for the floating toolbar to render (it makes
// `menuFeaturesActive` true), which gives us the collapsed FAB + one hidden pill.
const SEED = { 'option.tagToolbar': true, 'option.filterToolbar': true }

/**
 * The collapsed toolbar keeps its panel in the layout (`visibility: hidden`
 * reserves space), so the container box is far larger than the visible circle.
 * Anything the page puts in that corner — AO3's filter sidebar buttons, most
 * often — must still be clickable through the empty part of that box.
 */
describe('floating toolbar — collapsed hit area', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    // Injected as content rather than by URL: an about:blank document has an
    // opaque origin and can't load them cross-origin from a local server.
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await browser.newPage()
    await page.setViewport({ width: 1024, height: 768 })
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)

    // A stand-in for whatever AO3 renders in the bottom-right — the filter
    // sidebar's controls are exactly what the user could not click.
    await page.evaluate(() => {
      document.body.innerHTML = ''
      const target = document.createElement('button')
      target.id = 'page-control'
      target.textContent = 'Filter'
      target.style.cssText = 'position:fixed;right:0;bottom:0;width:420px;height:320px;'
      document.body.append(target)
    })

    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('the toolbar renders collapsed', async () => {
    const state = await page.evaluate(() => {
      const el = document.querySelector('.AO3E--filter-toolbar')
      const fab = document.querySelector('.AO3E--filter-toolbar--fab')
      if (!el || !fab)
        return null
      const box = el.getBoundingClientRect()
      const circle = fab.getBoundingClientRect()
      return {
        open: el.classList.contains('AO3E--filter-toolbar--open'),
        box: { w: Math.round(box.width), h: Math.round(box.height) },
        circle: { w: Math.round(circle.width), h: Math.round(circle.height) },
      }
    })
    assert.ok(state, 'the floating toolbar should have rendered')
    assert.equal(state.open, false, 'it should start collapsed')
    // The premise of this test: the container really is bigger than the circle.
    assert.ok(
      state.box.w > state.circle.w + 20 || state.box.h > state.circle.h + 20,
      `expected a container larger than the circle, got box ${state.box.w}x${state.box.h} vs circle ${state.circle.w}x${state.circle.h}`,
    )
  })

  test('does not swallow clicks in the empty part of its box', async () => {
    const result = await page.evaluate(() => {
      const el = document.querySelector('.AO3E--filter-toolbar')
      const fab = document.querySelector('.AO3E--filter-toolbar--fab')
      const box = el.getBoundingClientRect()
      const circle = fab.getBoundingClientRect()

      // Probe the container's top-left: inside its box, well clear of the circle.
      const x = Math.round(box.left + 4)
      const y = Math.round(box.top + 4)
      const overCircle = x >= circle.left && x <= circle.right && y >= circle.top && y <= circle.bottom

      const hit = document.elementFromPoint(x, y)
      return {
        overCircle,
        hitId: hit?.id ?? null,
        hitClass: typeof hit?.className === 'string' ? hit.className : '',
        insideToolbar: !!hit && el.contains(hit),
      }
    })

    assert.equal(result.overCircle, false, 'probe point should not be over the visible circle')
    assert.equal(
      result.insideToolbar,
      false,
      `the collapsed toolbar swallowed the click (hit .${result.hitClass})`,
    )
    assert.equal(result.hitId, 'page-control', 'the click should reach the page underneath')
  })

  test('the circle itself is still clickable', async () => {
    const hitFab = await page.evaluate(() => {
      const fab = document.querySelector('.AO3E--filter-toolbar--fab')
      const r = fab.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      return !!hit && (hit === fab || fab.contains(hit))
    })
    assert.ok(hitFab, 'the FAB must still receive its own clicks')
  })

  test('pills are clickable once expanded', async () => {
    const ok = await page.evaluate(async () => {
      const fab = document.querySelector('.AO3E--filter-toolbar--fab')
      fab.click()
      await new Promise(r => setTimeout(r, 400))
      const pill = document.querySelector('.AO3E--filter-toolbar--button')
      if (!pill)
        return { ok: false, why: 'no pill rendered' }
      const r = pill.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      return { ok: !!hit && (hit === pill || pill.contains(hit)), why: hit?.className ?? 'nothing' }
    })
    assert.ok(ok.ok, `an expanded pill must receive clicks (hit ${ok.why})`)
  })
})

/**
 * The same corner, with a toast in it.
 *
 * Saving anything from one of the toolbar's own pills raises a toast, and a
 * toast is fixed to the bottom-right too — so it used to come down squarely on
 * top of the launcher and the lowest pills, at a z-index the toolbar can't
 * argue with. The reader had pressed a button and lost the toolbar for as long
 * as the message about it was up. The toast now steps above whatever the
 * content script has parked in that corner (`--ao3e-corner-reserve`), and stops
 * hit-testing outside its own card.
 */
describe('floating toolbar — while a toast is up', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    page = await browser.newPage()
    await page.setViewport({ width: 1024, height: 768 })
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)
    await page.evaluate(() => {
      document.body.innerHTML = ''
    })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /**
   * Put a toast up the way the background does — one that never times out, so
   * the state under test doesn't expire halfway through the file.
   */
  const raiseToast = async (message = 'Saved.') => {
    await page.evaluate(m => window.__message({ toast: [m, { type: 'success', timeout: 0 }] }), message)
    // Past the toast's own entrance transition.
    await sleep(600)
  }

  /**
   * Where everything in the corner is, and what a pointer put in the middle of
   * each of them would actually hit. `elementFromPoint` reports the shadow
   * host for a point over the toast, which is exactly the answer we're after:
   * "something that isn't the toolbar is in the way".
   */
  const corner = () => page.evaluate(() => {
    const toolbar = document.querySelector('.AO3E--filter-toolbar')
    const fab = document.querySelector('.AO3E--filter-toolbar--fab')
    if (!toolbar || !fab)
      return null
    const pills = [...document.querySelectorAll('.AO3E--filter-toolbar--button')]
    let card = null
    for (const el of document.body.children) {
      const found = [...el.shadowRoot?.querySelectorAll('.toast') ?? []]
        .find(t => t.style.visibility !== 'hidden')
      if (found) {
        card = found
        break
      }
    }

    const at = (el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        inToolbar: !!hit && !!toolbar && toolbar.contains(hit),
        isToast: !!hit && hit.shadowRoot?.contains(card ?? null) === true,
        hit: hit ? (hit.className || hit.tagName) : null,
      }
    }

    return {
      open: toolbar?.classList.contains('AO3E--filter-toolbar--open') ?? false,
      reserve: document.documentElement.style.getPropertyValue('--ao3e-corner-reserve'),
      fab: at(fab),
      // Bottom-up: the pill nearest the corner is the one a toast used to bury.
      pills: pills.map(at).reverse(),
      toast: card ? at(card.querySelector('.inner')) : null,
    }
  })

  test('the toast sits above the collapsed launcher, not over it', async () => {
    await raiseToast()
    const state = await corner()
    assert.ok(state, 'the floating toolbar should have rendered')
    assert.ok(state.toast, 'the toast should be up')
    assert.equal(state.open, false, 'the toolbar starts collapsed')
    // Collapsed, only the circle is really in the corner — the panel keeps its
    // layout box but is invisible, so the reserve is the circle's height plus
    // its offset, not the whole container's.
    assert.match(state.reserve, /^\d+px$/, 'the toolbar should publish what it takes')
    assert.ok(
      state.toast.bottom <= state.fab.top,
      `the toast (bottom ${state.toast.bottom}) should clear the launcher (top ${state.fab.top})`,
    )
  })

  test('a pointer in the middle of the launcher lands on the launcher', async () => {
    const state = await corner()
    assert.ok(state.fab.inToolbar, `the launcher's own centre hit ${state.fab.hit}`)
    assert.equal(state.fab.isToast, false, 'and it is not the toast')
  })

  test('the toast still takes its own clicks', async () => {
    const state = await corner()
    assert.ok(state.toast.isToast, `the toast's own card hit ${state.toast.hit}`)
  })

  test('a real click on the launcher opens the panel', async () => {
    await page.click('.AO3E--filter-toolbar--fab')
    await sleep(400)
    const state = await corner()
    assert.equal(state.open, true, 'the click should have reached the launcher')
    assert.ok(state.pills.length > 0, 'the panel should have pills in it')
  })

  test('the toast steps up again for the expanded panel', async () => {
    const state = await corner()
    assert.ok(
      state.toast.bottom <= state.pills[0].top,
      `the toast (bottom ${state.toast.bottom}) should clear the lowest pill (top ${state.pills[0].top})`,
    )
    for (const [i, pill] of state.pills.entries())
      assert.ok(pill.inToolbar, `pill ${i} counting up from the corner was covered by ${pill.hit}`)
  })

  test('a real click on a pill still does what it says', async () => {
    await page.click('.AO3E--filter-toolbar--menus')
    // The write re-runs every unit, which rebuilds the toolbar — collapsed, and
    // measured afresh. The toast is not ours to remove, so it rides that out.
    await sleep(1500)
    const wrote = await page.evaluate(() =>
      (window.__writes ?? []).some(w => 'option.contextMenusEnabled' in w))
    assert.ok(wrote, 'the click should have reached the pill and saved the setting')
  })

  test('and the rebuilt toolbar is still reachable under the same toast', async () => {
    const state = await corner()
    assert.ok(state.toast, 'the toast should have outlived the rebuild')
    assert.equal(state.open, false, 'the rebuilt toolbar is collapsed')
    assert.ok(state.toast.bottom <= state.fab.top, 'and the toast is back above the collapsed launcher')
    assert.ok(state.fab.inToolbar, `the rebuilt launcher's centre hit ${state.fab.hit}`)
  })
})
