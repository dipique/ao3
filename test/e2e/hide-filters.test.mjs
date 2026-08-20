import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

// Two 'hideFilter' rules: an exact one restricted to Additional Tags ('F'), and
// an any-tag "contains" one — the shape you get from a noise tag like
// "<character> is a jerk". Neither should hide any work.
const SEED = {
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hideFilter' },
      { target: 'tag', value: 'is a jerk', matcher: 'contains', behavior: 'hideFilter' },
    ],
  },
}

/** A blurb, a work's own meta list, and a slice of the filter sidebar. */
const PAGE = `
<div id="main">
  <ol class="work index group">
    <li class="blurb work" id="blurb">
      <h4 class="heading"><a href="/works/1">A work</a></h4>
      <h5 class="fandoms heading"><span class="landmark">Fandoms:</span><a class="tag" href="/tags/Some%20Fandom/works">Some Fandom</a></h5>
      <ul class="tags commas">
        <li class="warnings" id="b-warn"><strong><a class="tag" href="/tags/w/works">No Archive Warnings Apply</a></strong></li>
        <li class="characters" id="b-jerk"><a class="tag" href="/tags/j/works">Bob is a jerk</a></li>
        <li class="freeforms" id="b-angst"><a class="tag" href="/tags/a/works">Angst</a></li>
        <li class="freeforms" id="b-fluff"><a class="tag" href="/tags/f/works">Fluff</a></li>
      </ul>
    </li>
  </ol>

  <dl class="work meta group">
    <dd class="freeform tags">
      <ul class="commas">
        <li id="w-fluff"><a class="tag" href="/tags/f/works">Fluff</a></li>
        <li id="w-burn"><a class="tag" href="/tags/s/works">Slow Burn</a></li>
      </ul>
    </dd>
    <dd class="character tags">
      <ul class="commas">
        <li id="w-fluffchar"><a class="tag" href="/tags/fc/works">Fluff</a></li>
      </ul>
    </dd>
  </dl>

  <form id="work-filters">
    <dd id="exclude_freeform_tags" class="expandable freeform tags">
      <ul>
        <li id="s-fluff"><label for="ex_f_110"><input type="checkbox" name="exclude_work_search[freeform_ids][]" id="ex_f_110" value="110"><span class="indicator"></span><span>Fluff (6385)</span></label></li>
        <li id="s-angst"><label for="ex_f_176"><input type="checkbox" name="exclude_work_search[freeform_ids][]" id="ex_f_176" value="176"><span class="indicator"></span><span>Angst (5686)</span></label></li>
      </ul>
    </dd>
    <dd id="include_freeform_tags" class="expandable freeform tags">
      <ul>
        <li id="s-fluff-on"><label for="in_f_110"><input type="checkbox" name="include_work_search[freeform_ids][]" id="in_f_110" value="110" checked><span class="indicator"></span><span>Fluff (6385)</span></label></li>
      </ul>
    </dd>
  </form>
</div>
`

/**
 * The "hide filter" behaviour: a matching tag is taken out of every list it
 * appears in — blurbs, a work's own meta, and the filter sidebar — while the
 * works themselves are left alone.
 */
describe('hide-filter tag rules', { skip }, () => {
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

  const displayOf = id => page.evaluate((sel) => {
    const el = document.getElementById(sel)
    return el ? getComputedStyle(el).display : 'missing'
  }, id)

  test('hides the matching tags in a blurb, and only those', async () => {
    assert.equal(await displayOf('b-fluff'), 'none', 'exact + type match should be hidden')
    assert.equal(await displayOf('b-jerk'), 'none', 'untyped contains match should be hidden')
    assert.notEqual(await displayOf('b-angst'), 'none', 'unmatched tag should still show')
    assert.notEqual(await displayOf('b-warn'), 'none', 'unmatched tag should still show')
  })

  test('leaves the work itself visible', async () => {
    const state = await page.evaluate(() => {
      const blurb = document.getElementById('blurb')
      return {
        display: getComputedStyle(blurb).display,
        hiddenBy: blurb.dataset.ao3eHiddenBy ?? null,
        message: !!blurb.querySelector('.AO3E--hide-works--msg'),
      }
    })
    assert.notEqual(state.display, 'none')
    assert.equal(state.hiddenBy, null)
    assert.equal(state.message, false)
  })

  test('drops the dangling comma after a hidden last tag', async () => {
    const marked = await page.evaluate(() =>
      [...document.querySelectorAll('#blurb .AO3E--hidden-filter-last')].map(el => el.id))
    assert.deepEqual(marked, ['b-angst'], 'the last still-visible tag should lose its separator')
  })

  test('types work-page tags from their <dd>, not the <li>', async () => {
    // The work meta list puts the type on the `dd`; the type-restricted rule must
    // still match there — and must not match the same name under another type.
    assert.equal(await displayOf('w-fluff'), 'none')
    assert.notEqual(await displayOf('w-burn'), 'none')
    assert.notEqual(await displayOf('w-fluffchar'), 'none', 'a Character tag must not match an Additional Tags rule')
  })

  test('hides the matching filter sidebar rows, but never a checked one', async () => {
    assert.equal(await displayOf('s-fluff'), 'none')
    assert.notEqual(await displayOf('s-angst'), 'none')
    assert.notEqual(await displayOf('s-fluff-on'), 'none', 'an active selection must stay visible')
  })
})
