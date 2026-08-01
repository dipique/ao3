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
