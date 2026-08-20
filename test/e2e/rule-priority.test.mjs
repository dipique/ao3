import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * One "always show" tag rule at its default strength (4), and hide rules on
 * three fandoms at 0, 5 and 4 — everything needed to see which side of a
 * priority tie each blurb lands on.
 */
const SEED = {
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'f', value: 'Soft Fandom', matcher: 'exact', behavior: 'hide' },
      { target: 'f', value: 'Hard Fandom', matcher: 'exact', behavior: 'hide', priority: 5 },
      { target: 'f', value: 'Tied Fandom', matcher: 'exact', behavior: 'hide', priority: 4 },
      { target: 'F', value: 'Keeper', matcher: 'exact', behavior: 'invert' },
      { target: 'F', value: 'Override', matcher: 'exact', behavior: 'invert', priority: 9 },
    ],
  },
}

/** A blurb with the given fandoms and additional tags. */
function blurb(id, fandoms, tags) {
  return `
    <li class="blurb work" id="${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id.replace(/\D/g, '') || '1'}">Work ${id}</a></h4>
        <h5 class="fandoms heading">
          <span class="landmark">Fandoms:</span>
          ${fandoms.map(f => `<a class="tag" href="/tags/${encodeURIComponent(f)}/works">${f}</a>`).join('')}
        </h5>
      </div>
      <ul class="tags commas">
        ${tags.map(t => `<li class="freeforms"><a class="tag" href="/tags/${encodeURIComponent(t)}/works">${t}</a></li>`).join('')}
      </ul>
    </li>`
}

const PAGE = `
<div id="main">
  <ol class="work index group">
    ${blurb('b1', ['Soft Fandom'], ['Keeper'])}
    ${blurb('b2', ['Soft Fandom'], ['Angst'])}
    ${blurb('b3', ['Hard Fandom'], ['Keeper'])}
    ${blurb('b4', ['Hard Fandom'], ['Override'])}
    ${blurb('b5', ['Tied Fandom'], ['Keeper'])}
    ${blurb('b6', ['Soft Fandom', 'Hard Fandom'], ['Keeper'])}
  </ol>
</div>
`

/**
 * Rule priority decides which of several matching rules has the last word on
 * whether a work is hidden. With everything at its default an "always show"
 * (priority 4) beats an ordinary hide (0) — the long-standing behaviour — but a
 * hide raised above it now wins, and a tie goes back to the force-show.
 */
describe('rule priority', { skip }, () => {
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
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)
    await page.evaluate((html) => {
      document.body.innerHTML = html
    }, PAGE)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Which kinds of rule hid a blurb, or null when it wasn't hidden at all. */
  const hiddenBy = id => page.evaluate(
    sel => document.getElementById(sel)?.dataset.ao3eHiddenBy ?? null,
    id,
  )

  /** The reason line the collapsed work shows. */
  const reason = id => page.evaluate(
    sel => document.getElementById(sel)?.querySelector('.AO3E--hide-works--reasons')?.textContent ?? null,
    id,
  )

  test('an "always show" tag overrules an ordinary hide', async () => {
    assert.equal(await hiddenBy('b1'), null, 'invert at 4 beats hide at 0')
  })

  test('the same hide still applies without the force-show', async () => {
    assert.equal(await hiddenBy('b2'), 'tags')
    assert.match(await reason('b2'), /Soft Fandom/)
  })

  test('a hide raised above the force-show wins', async () => {
    assert.equal(await hiddenBy('b3'), 'tags', 'hide at 5 beats invert at 4')
    assert.match(await reason('b3'), /Hard Fandom/)
  })

  test('a force-show raised higher still wins', async () => {
    assert.equal(await hiddenBy('b4'), null, 'invert at 9 beats hide at 5')
  })

  test('a tie goes to the force-show', async () => {
    assert.equal(await hiddenBy('b5'), null, 'hide at 4 does not beat invert at 4')
  })

  test('reasons that lost the contest are not listed', async () => {
    // Both fandoms match a hide rule, but only the one above the force-show had
    // any say — claiming the other hid the work would be a lie.
    assert.equal(await hiddenBy('b6'), 'tags')
    const text = await reason('b6')
    assert.match(text, /Hard Fandom/)
    assert.doesNotMatch(text, /Soft Fandom/)
  })
})
