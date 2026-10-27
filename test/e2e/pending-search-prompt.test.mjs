import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { SEARCH_PROMPT_TIMEOUT } from '../../src/common/constants.ts'
import { DIST, ensureBuilt, findChrome, hurryTimers, installMock, launch, outlast } from './helpers.mjs'
import { menuClosed, openMenu, pickRow, runs, settled } from './trackedPages.mjs'

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

    browser = await launch(chromePath)
    page = await browser.newPage()
    // The prompt's fade, cut to a second: long enough to read it, short enough to wait out.
    await page.evaluateOnNewDocument(hurryTimers, { [SEARCH_PROMPT_TIMEOUT]: 1000 })
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
    await settled(page)
    // Registered after the content script's own, on the same node and phase, so
    // by the time it counts an Enter the extension has done what it does with it.
    await page.evaluate(() => {
      window.__enters = 0
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
          window.__enters++
      })
    })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** In the page: the prompt's message, and whether it offers its button, or null when it isn't up. */
  const findPrompt = () => {
    for (const el of document.body.children) {
      const toast = [...el.shadowRoot?.querySelectorAll('.toast') ?? []]
        .find(t => t.dataset.ao3eToast === 'pending-search')
      if (toast && toast.style.visibility !== 'hidden')
        return { message: toast.querySelector('.message').textContent, button: !!toast.querySelector('.action') }
    }
    return null
  }

  /**
   * The prompt that is up, or null. A toast that goes is hidden at once and
   * taken out of the page a moment later; until then {@link findPrompt} would
   * find it ahead of a new one, so this waits for it to be gone.
   */
  const prompt = async () => {
    await page.waitForFunction(() => [...document.body.children]
      .every(el => ![...el.shadowRoot?.querySelectorAll('.toast') ?? []].some(t => t.style.visibility === 'hidden')))
    return page.evaluate(findPrompt)
  }

  const submits = () => page.evaluate(() => window.__submits)

  /** Right-click Fluff and pick the row that does `action`. */
  const pick = async (action) => {
    await page.keyboard.press('Escape')
    await menuClosed(page)
    await openMenu(page, () => page.click('#work_1 a.tag', { button: 'right' }))
    assert.ok(await pickRow(page, action), `no ${action} row on Fluff`)
    await menuClosed(page)
  }

  /** Press Ctrl+Enter, and wait until the page has handled it. */
  const ctrlEnter = async () => {
    const seen = await page.evaluate(() => window.__enters)
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    await page.waitForFunction(n => window.__enters > n, {}, seen)
  }

  test('says nothing while the form still matches the results', async () => {
    assert.equal(await prompt(), null)
  })

  test('appears when a menu pick changes the filter, and goes when it is undone', async () => {
    await pick('exclude')
    const shown = await prompt()
    assert.ok(shown?.message, 'the prompt says the filter changed')
    assert.ok(shown.button, 'and offers to run the search')

    await pick('exclude')
    assert.equal(await prompt(), null, 'excluding and un-excluding leaves the search as it was')
    assert.equal(await submits(), 0, 'nothing is submitted on its own')
  })

  test('a default set from another tab says what it did', async () => {
    const before = await runs(page)
    await page.evaluate(() => browser.storage.local.set({
      'option.searchLanguage': { enabled: true, language: { value: 'en', label: 'English' } },
    }))
    // Checked the moment it arrives: it fades on its own soon after.
    // It names the language it set, the fixture's own.
    await page.waitForFunction(`(${findPrompt})()?.message.toLowerCase().includes('english')`, { timeout: 5000 })
    await settled(page, before)
  })

  test('Ctrl+Enter on a link outside the filter is left to the link', async () => {
    await page.focus('#elsewhere')
    await ctrlEnter()
    assert.equal(await submits(), 0)
    assert.ok(await prompt(), 'the prompt is still up')
  })

  test('Ctrl+Enter runs the search and takes the prompt down', async () => {
    await page.evaluate(() => document.activeElement?.blur())
    await ctrlEnter()
    assert.equal(await submits(), 1)
    assert.equal(await prompt(), null)
  })

  test('the prompt\'s own button runs the search too', async () => {
    // "Require", not "Include": this is AO3's own sidebar, which ANDs the tags
    // it is told to include.
    await pick('require')
    assert.ok(await prompt())
    await page.evaluate(() => {
      for (const el of document.body.children)
        el.shadowRoot?.querySelector('.toast .action')?.click()
    })
    assert.equal(await submits(), 2)
    assert.equal(await prompt(), null)
  })

  /**
   * Long enough that the prompt would have faded, were it going to: past the
   * timeout it started when it was last shown or let go of.
   */
  const outlastPrompt = () => outlast(page, SEARCH_PROMPT_TIMEOUT)

  const FAB = '.AO3E--filter-toolbar--fab'

  const toggleToolbar = async () => {
    const was = await page.$eval(FAB, fab => fab.getAttribute('aria-expanded'))
    await page.click(FAB)
    await page.waitForFunction((fab, w) => document.querySelector(fab).getAttribute('aria-expanded') !== w, {}, FAB, was)
  }

  test('fades by itself after a few seconds', async () => {
    await pick('exclude')
    assert.ok(await prompt())
    await outlastPrompt()
    assert.equal(await prompt(), null)
  })

  test('opening the toolbar brings it back, and it stays while the toolbar is open', async () => {
    await toggleToolbar()
    assert.ok(await prompt(), 'the prompt is back')
    await outlastPrompt()
    assert.ok(await prompt(), 'still up with the toolbar open')
  })

  test('closing the toolbar lets it fade again', async () => {
    await toggleToolbar()
    assert.ok(await prompt(), 'not taken down at once, so a click on it still lands')
    await outlastPrompt()
    assert.equal(await prompt(), null)
  })

  test('opening the toolbar raises nothing when the form matches the results', async () => {
    // Put the form back as the page arrived.
    await page.evaluate(() => {
      for (const id of ['work_search_language_id', 'work_search_other_tag_names', 'work_search_excluded_tag_names'])
        document.getElementById(id).value = ''
      document.getElementById('work_search_language_id').dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(await prompt(), null)
    await toggleToolbar()
    assert.equal(await prompt(), null)
    await toggleToolbar()
  })
})
