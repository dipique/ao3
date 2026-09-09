import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * One rule of every shape the feature has to tell apart, plus the "always show"
 * that has to survive it:
 *
 * - `Omegaverse`  exact Additional Tags, no sidebar row  -> typed into the field
 * - `Fluff`       exact Additional Tags, sidebar row     -> its checkbox ticked
 * - `Explicit`    a rating, always a checkbox            -> its checkbox ticked
 * - `coffee`      a *contains* rule, no sidebar row      -> left alone
 * - `Angst`       exact, but an always-show keeps a work carrying it -> left alone
 * - `Meh`         a *collapse* rule                      -> left alone
 */
const SEED = {
  'option.autoExcludeHidden': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Omegaverse', matcher: 'exact', behavior: 'hide' },
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'hide' },
      { target: 'r', value: 'Explicit', matcher: 'exact', behavior: 'hide' },
      { target: 'F', value: 'coffee', matcher: 'contains', behavior: 'hide' },
      { target: 'F', value: 'Angst', matcher: 'exact', behavior: 'hide' },
      { target: 'F', value: 'Meh', matcher: 'exact', behavior: 'collapse' },
      { target: 'author', value: 'keeper', matcher: 'exact', behavior: 'invert' },
    ],
  },
}

function blurb(id, title, tags, { rating = 'General Audiences', author = 's' } = {}) {
  const tagList = tags
    .map(t => `<li class="freeforms"><a class="tag" href="https://archiveofourown.org/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <ul class="required-tags"><li><span class="rating">${rating}</span></li></ul>
        <h4 class="heading">
          <a href="https://archiveofourown.org/works/${id}">${title}</a> by
          <a rel="author" href="https://archiveofourown.org/users/${author}/pseuds/${author}">${author}</a>
        </h4>
        <h5 class="fandoms heading"><a class="tag" href="https://archiveofourown.org/tags/A%20Fandom/works">A Fandom</a></h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
    </li>`
}

/**
 * A works listing with AO3's Sort & Filter form under it: the two free-text tag
 * fields, an exclude row for one freeform tag (`Fluff`) and the rating group,
 * which the archive renders in full on every filterable listing.
 */
const PAGE = `
<div id="main">
  <ol class="work index group">
    ${blurb(1, 'An omegaverse one', ['Omegaverse'])}
    ${blurb(2, 'A fluffy one', ['Fluff'])}
    ${blurb(3, 'An explicit one', [], { rating: 'Explicit' })}
    ${blurb(4, 'A coffee shop one', ['Coffee Shop AU'])}
    ${blurb(5, 'An angsty one', ['Angst'])}
    ${blurb(6, 'An angsty one by a keeper', ['Angst'], { author: 'keeper' })}
    ${blurb(7, 'A so-so one', ['Meh'])}
  </ol>

  <form id="work-filters" action="/tags/x/works">
    <dd>
      <input id="work_search_other_tag_names" name="work_search[other_tag_names]" type="text" value="">
    </dd>
    <dd>
      <input id="work_search_excluded_tag_names" name="work_search[excluded_tag_names]" type="text" value="">
    </dd>
    <dd id="exclude_freeform_tags" class="expandable freeform tags">
      <ul>
        <li><label for="ex_f_110"><input type="checkbox" name="exclude_work_search[freeform_ids][]" id="ex_f_110" value="110"><span class="indicator"></span><span>Fluff (6385)</span></label></li>
        <li><label for="ex_f_176"><input type="checkbox" name="exclude_work_search[freeform_ids][]" id="ex_f_176" value="176"><span class="indicator"></span><span>Angst (5686)</span></label></li>
      </ul>
    </dd>
    <dd id="exclude_ratings" class="rating tags">
      <ul>
        <li><label for="ex_r_9"><input type="checkbox" name="exclude_work_search[rating_ids][]" id="ex_r_9" value="9"><span class="indicator"></span><span>Not Rated (12)</span></label></li>
        <li><label for="ex_r_13"><input type="checkbox" name="exclude_work_search[rating_ids][]" id="ex_r_13" value="13"><span class="indicator"></span><span>Explicit (34)</span></label></li>
      </ul>
    </dd>
  </form>
</div>
`

/**
 * "Exclude hidden works from the search": a rule that takes a work out of the
 * listing outright also goes into AO3's own filter, so the next search never
 * fetches it — rather than leaving the reader to type the same exclusions in by
 * hand every time a page comes back nearly empty.
 */
describe('auto-excluding what the rules hide', { skip }, () => {
  let browser
  let page

  before(async () => {
    ensureBuilt()
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
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const excluded = () => page.evaluate(() => {
    const { value } = document.getElementById('work_search_excluded_tag_names')
    return value.split(',').map(name => name.trim()).filter(Boolean)
  })
  const checked = id => page.evaluate(sel => document.getElementById(sel).checked, id)

  test('types an exact Additional Tags rule into the excluded tags field', async () => {
    assert.deepEqual(await excluded(), ['Omegaverse'])
  })

  test('ticks the sidebar checkbox a tag already has, rather than re-typing it', async () => {
    assert.equal(await checked('ex_f_110'), true, 'the Fluff exclude checkbox should be ticked')
  })

  test('ticks a rating the same way', async () => {
    assert.equal(await checked('ex_r_13'), true, 'the Explicit exclude checkbox should be ticked')
    assert.equal(await checked('ex_r_9'), false, 'an unmatched rating should be left alone')
  })

  test('leaves a contains rule alone — it names a shape, not a tag', async () => {
    assert.ok(!(await excluded()).includes('Coffee Shop AU'))
  })

  test('leaves a value alone while an always-show rule keeps a work carrying it', async () => {
    assert.ok(!(await excluded()).includes('Angst'), 'Angst should not be typed in')
    assert.equal(await checked('ex_f_176'), false, 'nor should its checkbox be ticked')
  })

  test('leaves a collapse rule alone — that work is on the page on purpose', async () => {
    assert.ok(!(await excluded()).includes('Meh'))
  })

  test('never touches the include side', async () => {
    const included = await page.evaluate(() => document.getElementById('work_search_other_tag_names').value)
    assert.equal(included, '')
  })

  test('submits nothing — the reader presses Sort and Filter', async () => {
    assert.equal(page.url(), 'about:blank')
  })
})
