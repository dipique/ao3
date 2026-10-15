import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock } from './helpers.mjs'
import { settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * One rule of every shape the feature has to tell apart, plus the "always show"
 * that has to survive it:
 *
 * - `Omegaverse`  exact Additional Tags, no sidebar row  -> typed into the field
 * - `Fluff`       exact Additional Tags, sidebar row     -> its checkbox ticked
 * - `Explicit`    a rating, always a checkbox            -> its checkbox ticked
 * - `coffee`      a *contains* rule, no sidebar row      -> the matched tag typed in
 * - `Angst`       exact, but an always-show keeps a work carrying it -> left alone
 * - `Meh`         a *collapse* rule                      -> left alone
 * - `torture`     a *contains* rule matching several tags on one work -> only the first
 *
 * Each hidden work adds at most one exclusion: a work already covered by one an
 * earlier work added gets nothing more, and a work whose first match is off
 * limits falls back to its next.
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
      { target: 'F', value: 'torture', matcher: 'contains', behavior: 'hide' },
      { target: 'author', value: 'keeper', matcher: 'exact', behavior: 'invert' },
    ],
  },
}

const tagLink = t => `<a class="tag" href="https://archiveofourown.org/tags/${encodeURIComponent(t)}/works">${t}</a>`

function blurb(id, title, tags, { rating = 'General Audiences', author = 's', fandoms = ['A Fandom'], characters = [] } = {}) {
  const tagList = [
    ...characters.map(t => `<li class="characters">${tagLink(t)}</li>`),
    ...tags.map(t => `<li class="freeforms">${tagLink(t)}</li>`),
  ].join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <ul class="required-tags"><li><span class="rating">${rating}</span></li></ul>
        <h4 class="heading">
          <a href="https://archiveofourown.org/works/${id}">${title}</a> by
          <a rel="author" href="https://archiveofourown.org/users/${author}/pseuds/${author}">${author}</a>
        </h4>
        <h5 class="fandoms heading">
          <span class="landmark">Fandoms:</span>
          ${fandoms.map(tagLink).join(', ')}
          &nbsp;
        </h5>
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
    ${blurb(8, 'A dark one', ['Torture', 'Whump Torture'])}
    ${blurb(9, 'A dark omegaverse one', ['Dark Torture Themes', 'Omegaverse'])}
    ${blurb(10, 'A dark angsty one', ['Angst', 'Torture Mention'])}
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

/** The content script run over `html` in a fresh browser, with storage seeded from `seed`. */
async function openListing(seed, html) {
  ensureBuilt()
  const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const page = await browser.newPage()
  await page.goto('about:blank')
  await page.evaluate(installMock, seed)
  await page.evaluate((body) => {
    document.body.innerHTML = body
  }, html)
  await page.addScriptTag({ content: js })
  await settled(page)
  return { browser, page }
}

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
    ({ browser, page } = await openListing(SEED, PAGE))
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const excluded = () => page.evaluate(() => {
    const { value } = document.getElementById('work_search_excluded_tag_names')
    return value.split(',').map(name => name.trim()).filter(Boolean)
  })
  const checked = id => page.evaluate(sel => document.getElementById(sel).checked, id)

  test('types one tag per hidden work into the excluded tags field', async () => {
    assert.deepEqual(await excluded(), ['Omegaverse', 'Coffee Shop AU', 'Torture', 'Torture Mention'])
  })

  test('ticks the sidebar checkbox a tag already has, rather than re-typing it', async () => {
    assert.equal(await checked('ex_f_110'), true, 'the Fluff exclude checkbox should be ticked')
  })

  test('ticks a rating the same way', async () => {
    assert.equal(await checked('ex_r_13'), true, 'the Explicit exclude checkbox should be ticked')
    assert.equal(await checked('ex_r_9'), false, 'an unmatched rating should be left alone')
  })

  test('types the tag a contains rule matched', async () => {
    assert.ok((await excluded()).includes('Coffee Shop AU'))
  })

  test('adds only the first match when a rule matches several tags on one work', async () => {
    assert.ok(!(await excluded()).includes('Whump Torture'))
  })

  test('adds nothing for a work an earlier exclusion already covers', async () => {
    assert.ok(!(await excluded()).includes('Dark Torture Themes'))
  })

  test('falls back to the next match when the first is kept on screen', async () => {
    assert.ok((await excluded()).includes('Torture Mention'))
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

/**
 * Each work here carries the tag its rule hides *after* one no rule touches, in
 * its fandoms, its characters and its additional tags. Both fandoms are known by
 * id and listed in the sidebar, so either could be ticked.
 */
const MATCHED_SEED = {
  'option.autoExcludeHidden': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'f', value: 'Hide This Fandom', matcher: 'exact', behavior: 'hide' },
      { target: 'C', value: 'Hide This Character', matcher: 'exact', behavior: 'hide' },
      { target: 'F', value: 'Hide This Tag', matcher: 'exact', behavior: 'hide' },
    ],
  },
  'fandomCache.fandoms': {
    'other fandom': { id: 501, name: 'Other Fandom' },
    'hide this fandom': { id: 502, name: 'Hide This Fandom' },
  },
}

const MATCHED_PAGE = `
<div id="main">
  <ol class="work index group">
    ${blurb(1, 'A crossover', [], { fandoms: ['Other Fandom', 'Hide This Fandom'] })}
    ${blurb(2, 'An ensemble', [], { characters: ['Other Character', 'Hide This Character'] })}
    ${blurb(3, 'A tagged one', ['Other Tag', 'Hide This Tag'])}
  </ol>

  <form id="work-filters" action="/tags/x/works">
    <dd>
      <input id="work_search_other_tag_names" name="work_search[other_tag_names]" type="text" value="">
    </dd>
    <dd>
      <input id="work_search_excluded_tag_names" name="work_search[excluded_tag_names]" type="text" value="">
    </dd>
    <dd id="exclude_fandom_tags" class="expandable fandom tags">
      <ul>
        <li><label for="exclude_work_search_fandom_ids_501"><input type="checkbox" name="exclude_work_search[fandom_ids][]" id="exclude_work_search_fandom_ids_501" value="501"><span class="indicator"></span><span>Other Fandom (20)</span></label></li>
        <li><label for="exclude_work_search_fandom_ids_502"><input type="checkbox" name="exclude_work_search[fandom_ids][]" id="exclude_work_search_fandom_ids_502" value="502"><span class="indicator"></span><span>Hide This Fandom (3)</span></label></li>
      </ul>
    </dd>
  </form>
</div>
`

describe('auto-excluding the tag the rule matched, not the first one listed', { skip }, () => {
  let browser
  let page

  before(async () => {
    ({ browser, page } = await openListing(MATCHED_SEED, MATCHED_PAGE))
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  const excluded = () => page.evaluate(() => {
    const { value } = document.getElementById('work_search_excluded_tag_names')
    return value.split(',').map(name => name.trim()).filter(Boolean)
  })
  const excludedFandoms = () => page.evaluate(() =>
    [...document.querySelectorAll('input[name="exclude_work_search[fandom_ids][]"]')]
      .filter(input => input.checked)
      .map(input => input.value))

  test('ticks the fandom the rule hid, not the one listed before it', async () => {
    assert.deepEqual(await excludedFandoms(), ['502'])
  })

  test('types the character and the additional tag the rules hid, not the ones listed before them', async () => {
    assert.deepEqual(await excluded(), ['Hide This Character', 'Hide This Tag'])
  })
})

/**
 * AO3 merges many fandoms that aren't one — a subreddit, a podcast — into
 * Original Work as synonyms, so their own tag pages redirect there and the id
 * learned for them is Original Work's. Excluding that id would take every
 * original work out of the search; the work's own tag, typed in by name, takes
 * out only the works that carry it.
 */
const ORIGINAL_WORK_ID = 2692
const MERGED_FANDOM = 'GoneWildAudio (r/gonewildaudio)'

const MERGED_SEED = {
  'option.autoExcludeHidden': true,
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [{ target: 'f', value: MERGED_FANDOM, matcher: 'exact', behavior: 'hide' }],
  },
  'fandomCache.fandoms': {
    'original work': { id: ORIGINAL_WORK_ID, name: 'Original Work' },
    [MERGED_FANDOM.toLowerCase()]: { id: ORIGINAL_WORK_ID, name: MERGED_FANDOM },
  },
}

const MERGED_PAGE = `
<div id="main">
  <ol class="work index group">
    ${blurb(1, 'An audio script', [], { fandoms: ['Other Fandom', MERGED_FANDOM] })}
  </ol>

  <form id="work-filters" action="/tags/x/works">
    <dd>
      <input id="work_search_other_tag_names" name="work_search[other_tag_names]" type="text" value="">
    </dd>
    <dd>
      <input id="work_search_excluded_tag_names" name="work_search[excluded_tag_names]" type="text" value="">
    </dd>
    <dd id="exclude_fandom_tags" class="expandable fandom tags">
      <ul>
        <li><label for="exclude_work_search_fandom_ids_${ORIGINAL_WORK_ID}"><input type="checkbox" name="exclude_work_search[fandom_ids][]" id="exclude_work_search_fandom_ids_${ORIGINAL_WORK_ID}" value="${ORIGINAL_WORK_ID}"><span class="indicator"></span><span>Original Work (20)</span></label></li>
      </ul>
    </dd>
  </form>
</div>
`

describe('auto-excluding a fandom AO3 merged into Original Work', { skip }, () => {
  let browser
  let page

  before(async () => {
    ({ browser, page } = await openListing(MERGED_SEED, MERGED_PAGE))
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('leaves Original Work itself alone', async () => {
    const checked = await page.evaluate(id => document.getElementById(`exclude_work_search_fandom_ids_${id}`).checked, ORIGINAL_WORK_ID)
    assert.equal(checked, false)
  })

  test('types the merged fandom\'s own name into the excluded tags field instead', async () => {
    const value = await page.evaluate(() => document.getElementById('work_search_excluded_tag_names').value)
    assert.equal(value, MERGED_FANDOM)
  })
})
