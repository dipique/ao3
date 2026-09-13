import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/**
 * Everything that fills AO3's filter in on its own: a default language and word
 * count, and an auto-excluded rating. `Crossover Fandom` is known by id (as the
 * learned cache would have it) but has no row in the sidebar, so excluding it
 * means injecting a checkbox.
 */
const SEED = {
  'option.tagToolbar': true,
  'option.fandomToolbar': true,
  'option.autoExcludeHidden': true,
  'option.searchLanguage': { enabled: true, language: { value: 'en', label: 'English' } },
  'option.searchWordCount': { enabled: true, from: 1000, to: null },
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [{ target: 'r', value: 'Explicit', matcher: 'exact', behavior: 'hide' }],
  },
  'fandomCache.fandoms': { 'crossover fandom': { id: 4242, name: 'Crossover Fandom' } },
}

function blurb(id, title, { rating = 'General Audiences', fandoms = ['A Fandom'], tags = [] } = {}) {
  const fandomLinks = fandoms
    .map(f => `<a class="tag" href="https://archiveofourown.org/tags/${encodeURIComponent(f)}/works">${f}</a>`)
    .join(', ')
  const tagList = tags
    .map(t => `<li class="freeforms"><a class="tag" href="https://archiveofourown.org/tags/${encodeURIComponent(t)}/works">${t}</a></li>`)
    .join('')
  return `
    <li class="work blurb group" id="work_${id}">
      <div class="header module">
        <ul class="required-tags"><li><span class="rating">${rating}</span></li></ul>
        <h4 class="heading"><a href="https://archiveofourown.org/works/${id}">${title}</a></h4>
        <h5 class="fandoms heading">${fandomLinks}</h5>
      </div>
      <ul class="tags commas">${tagList}</ul>
    </li>`
}

/** A listing and the slice of its Sort & Filter form the fillers touch. */
const PAGE = `
<div id="main">
  <ol class="work index group">
    ${blurb(1, 'A crossover', { fandoms: ['A Fandom', 'Crossover Fandom'], tags: ['Fluff'] })}
    ${blurb(2, 'An explicit one', { rating: 'Explicit' })}
  </ol>

  <form id="work-filters" method="get" action="#">
    <select name="work_search[language_id]" id="work_search_language_id">
      <option value=""></option>
      <option value="en">English</option>
      <option value="fr">Français</option>
    </select>
    <input type="text" name="work_search[words_from]" id="work_search_words_from">
    <input type="text" name="work_search[words_to]" id="work_search_words_to">
    <input id="work_search_other_tag_names" name="work_search[other_tag_names]" type="text" value="">
    <input id="work_search_excluded_tag_names" name="work_search[excluded_tag_names]" type="text" value="">
    <dd id="exclude_fandom_tags" class="expandable fandom tags">
      <ul>
        <li><label for="ex_fd_1"><input type="checkbox" name="exclude_work_search[fandom_ids][]" id="ex_fd_1" value="1"><span class="indicator"></span><span>A Fandom (40)</span></label></li>
      </ul>
    </dd>
    <dd id="exclude_ratings" class="rating tags">
      <ul>
        <li><label for="ex_r_13"><input type="checkbox" name="exclude_work_search[rating_ids][]" id="ex_r_13" value="13"><span class="indicator"></span><span>Explicit (34)</span></label></li>
      </ul>
    </dd>
  </form>
</div>
`

/**
 * Any menu row that saves a setting — a rule, a mark — re-runs every unit on the
 * page. The reader may be halfway through setting up a search when that happens,
 * and nothing they've picked but not yet submitted may be lost or overruled.
 */
describe('a settings re-run keeps the pending search', { skip }, () => {
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
    await page.goto('about:blank')
    await page.evaluate(installMock, SEED)
    await page.evaluate((html) => {
      document.body.innerHTML = html
      window.__submits = 0
      document.getElementById('work-filters').addEventListener('submit', (e) => {
        e.preventDefault()
        window.__submits++
      })
    }, PAGE)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Right-click the link with this text and pick the row whose label starts with `label`. */
  const pick = async (linkText, label) => {
    await page.keyboard.press('Escape')
    await sleep(100)
    const link = await page.evaluateHandle(text =>
      [...document.querySelectorAll('#work_1 a.tag')].find(a => a.textContent.trim() === text), linkText)
    await link.click({ button: 'right' })
    await sleep(200)
    const picked = await page.evaluate((l) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => el.querySelector('.AO3E--menu--label').textContent.startsWith(l))
      row?.click()
      return !!row
    }, label)
    assert.ok(picked, `no "${label}" row on ${linkText}`)
    await sleep(200)
  }

  /** Long enough for the options listener's debounce and the re-run behind it. */
  const waitForRerun = () => sleep(1500)

  const form = () => page.evaluate(() => ({
    language: document.getElementById('work_search_language_id').value,
    wordsFrom: document.getElementById('work_search_words_from').value,
    explicit: document.getElementById('ex_r_13').checked,
    injected: [...document.querySelectorAll('input[name="exclude_work_search[fandom_ids][]"][value="4242"]')]
      .map(input => input.checked),
    submits: window.__submits,
  }))

  test('fills the filter in on page load', async () => {
    const state = await form()
    assert.equal(state.language, 'en')
    assert.equal(state.wordsFrom, '1000')
    assert.equal(state.explicit, true, 'the hidden Explicit work should have been auto-excluded')
  })

  test('the reader changes it, then picks a rule — and the filter stays as they left it', async () => {
    await pick('Crossover Fandom', 'Exclude')
    assert.deepEqual((await form()).injected, [true], 'excluding an unlisted fandom injects a checked box')

    await page.evaluate(() => {
      document.getElementById('work_search_language_id').value = ''
      document.getElementById('work_search_words_from').value = ''
      document.getElementById('ex_r_13').checked = false
    })

    await pick('Fluff', 'Highlight')
    await waitForRerun()
    assert.ok(
      await page.$('#work_1 .AO3E--indicator--highlight'),
      'the highlight should be drawn, i.e. the re-run happened',
    )

    // One comparison, so a regression reports every field it broke at once.
    assert.deepEqual(await form(), {
      language: '', // not defaulted again
      wordsFrom: '', // not defaulted again
      explicit: false, // not auto-excluded again
      injected: [true], // the unlisted fandom's exclusion survived the cleanup
      submits: 0,
    })
  })

  test('the surviving fandom checkbox is still the one its menu drives', async () => {
    await pick('Crossover Fandom', 'Exclude')
    assert.deepEqual((await form()).injected, [false], 'toggling off should reuse the box, not inject another')
    await pick('Crossover Fandom', 'Exclude')
    assert.deepEqual((await form()).injected, [true])
  })

  test('changing the default itself still reaches the open page', async () => {
    await page.evaluate(() => browser.storage.local.set({
      'option.searchLanguage': { enabled: true, language: { value: 'fr', label: 'Français' } },
    }))
    await waitForRerun()
    assert.equal((await form()).language, 'fr')
  })
})
