import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

/** Nothing that fills the form in on load, so the page starts in step with it. */
const SEED = {
  'option.tagToolbar': true,
}

const PAGE = `
<div id="main">
  <a id="elsewhere" href="#nowhere">A link outside the filter</a>
  <ol class="work index group">
    <li class="work blurb group" id="work_1">
      <div class="header module">
        <h4 class="heading"><a href="https://archiveofourown.org/works/1">A work</a></h4>
      </div>
      <ul class="tags commas">
        <li class="freeforms"><a class="tag" href="https://archiveofourown.org/tags/Fluff/works">Fluff</a></li>
      </ul>
    </li>
  </ol>

  <form id="work-filters" method="get" action="#">
    <select name="work_search[language_id]" id="work_search_language_id">
      <option value=""></option>
      <option value="en">English</option>
    </select>
    <input id="work_search_other_tag_names" name="work_search[other_tag_names]" type="text" value="">
    <input id="work_search_excluded_tag_names" name="work_search[excluded_tag_names]" type="text" value="">
    <input type="submit" name="commit" value="Sort and Filter">
  </form>
</div>
`

/**
 * Whatever the extension writes into AO3's filter form without submitting it
 * leaves the listing out of step with the form. The reader is told so, once,
 * and can run the search from the prompt or with Ctrl+Enter.
 */
describe('the pending-search prompt', { skip }, () => {
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

  /** The prompt's message and button, or null when it isn't up. */
  const prompt = () => page.evaluate(() => {
    for (const el of document.body.children) {
      const toast = [...el.shadowRoot?.querySelectorAll('.toast') ?? []]
        .find(t => t.querySelector('.action')?.textContent.startsWith('Update results'))
      if (toast && toast.style.visibility !== 'hidden')
        return { message: toast.querySelector('.message').textContent, action: toast.querySelector('.action').textContent }
    }
    return null
  })

  const submits = () => page.evaluate(() => window.__submits)

  /** Right-click Fluff and pick the row whose label starts with `label`. */
  const pick = async (label) => {
    await page.keyboard.press('Escape')
    await sleep(100)
    await page.click('#work_1 a.tag', { button: 'right' })
    await sleep(200)
    const picked = await page.evaluate((l) => {
      const row = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
        .find(el => el.querySelector('.AO3E--menu--label').textContent.startsWith(l))
      row?.click()
      return !!row
    }, label)
    assert.ok(picked, `no "${label}" row on Fluff`)
    // Past the toast's own hide transition.
    await sleep(300)
  }

  test('says nothing while the form still matches the results', async () => {
    assert.equal(await prompt(), null)
  })

  test('appears when a menu pick changes the filter, and goes when it is undone', async () => {
    await pick('Exclude')
    const shown = await prompt()
    assert.equal(shown?.message, 'Your search filters have changed.')
    assert.match(shown.action, /Update results \((Ctrl|⌘)\+Enter\)/)

    await pick('Exclude')
    assert.equal(await prompt(), null, 'excluding and un-excluding leaves the search as it was')
    assert.equal(await submits(), 0, 'nothing is submitted on its own')
  })

  test('a default set from another tab says what it did', async () => {
    await page.evaluate(() => browser.storage.local.set({
      'option.searchLanguage': { enabled: true, language: { value: 'en', label: 'English' } },
    }))
    await sleep(1500)
    assert.equal((await prompt())?.message, 'Language filter set to English.')
  })

  test('Ctrl+Enter on a link outside the filter is left to the link', async () => {
    await page.focus('#elsewhere')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    await sleep(100)
    assert.equal(await submits(), 0)
    assert.ok(await prompt(), 'the prompt is still up')
  })

  test('Ctrl+Enter runs the search and takes the prompt down', async () => {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    await sleep(300)
    assert.equal(await submits(), 1)
    assert.equal(await prompt(), null)
  })

  test('the prompt\'s own button runs the search too', async () => {
    // "Require", not "Include": this is AO3's own sidebar, which ANDs the tags
    // it is told to include.
    await pick('Require')
    assert.ok(await prompt())
    await page.evaluate(() => {
      for (const el of document.body.children)
        el.shadowRoot?.querySelector('.toast .action')?.click()
    })
    await sleep(300)
    assert.equal(await submits(), 2)
    assert.equal(await prompt(), null)
  })
})
