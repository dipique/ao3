import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { figures } from '../facts.mjs'
import { DIST, ensureBuilt, findChrome, installMock, launch } from './helpers.mjs'
import { settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/works?work_search[query]=x'

const MUTED_USER = 26223151

const RULES = {
  enabled: true,
  colors: {},
  filters: [
    { target: 'tag', value: 'Gone', matcher: 'exact', behavior: 'hide' },
    { target: 'tag', value: 'Folded', matcher: 'exact', behavior: 'collapse' },
  ],
}

function blurb(id, title, user, tag) {
  return `
      <li id="work_${id}" class="work blurb group work-${id} user-${user}" role="article">
        <div class="header module">
          <h4 class="heading"><a href="/works/${id}">${title}</a>
            <a href="/users/u${user}/pseuds/u${user}" rel="author">u${user}</a></h4>
        </div>
        <ul class="tags commas">
          <li class="freeforms"><a class="tag" href="/tags/${tag}/works">${tag}</a></li>
        </ul>
      </li>`
}

/**
 * A listing whose reader has muted one author on AO3. AO3 takes a muted
 * author's works off the page with a stylesheet of its own, one class per muted
 * user, carried by each of that user's blurbs — the rule below is the one it
 * writes. Two of the muted author's works are also ones the reader's rules hid,
 * one outright and one collapsed; the third is hidden by the mute alone.
 */
function listing() {
  return `<!doctype html>
<html><head><title>Works</title><style>
  li.blurb { display: block; border: 1px solid #ddd; padding: 0.429em 0.75em; }
</style><style>
  .user-32838, .user-${MUTED_USER} { display: none !important; visibility: hidden !important; }
</style></head><body class="logged-in works-index">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="works-index">
    <ol class="work index group">
      ${blurb(1, 'Muted and gone', MUTED_USER, 'Gone')}
      ${blurb(2, 'Muted and folded', MUTED_USER, 'Folded')}
      ${blurb(3, 'Only muted', MUTED_USER, 'Angst')}
      ${blurb(4, 'Plain', 5, 'Angst')}
    </ol>
  </div>
</body></html>`
}

/** The listing in a tab of its own, with the extension run over it under `seed`. */
async function openListing(seed) {
  ensureBuilt()
  const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
  const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
  const browser = await launch(chromePath)
  const tab = await browser.newPage()
  await tab.setRequestInterception(true)
  tab.on('request', (req) => {
    if (req.url().startsWith('https://archiveofourown.org/'))
      void req.respond({ status: 200, contentType: 'text/html', body: listing() })
    else
      void req.abort()
  })
  await tab.evaluateOnNewDocument(installMock, seed)
  await tab.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
  await tab.addStyleTag({ content: css })
  await tab.addScriptTag({ content: js })
  await settled(tab)
  return { browser, tab }
}

/** Whether the work is on screen: drawn, visible, and taking up room. */
const onScreen = (tab, id) => tab.evaluate((i) => {
  const li = document.getElementById(i)
  const style = getComputedStyle(li)
  return style.display !== 'none' && style.visibility === 'visible' && li.getBoundingClientRect().height > 0
}, id)

/** The peek pill, or null when the toolbar doesn't offer it: whether it is pressed, and its count. */
const pill = async (tab) => {
  const shown = await tab.evaluate(() => {
    const button = document.querySelector('.AO3E--filter-toolbar [data-ao3e-action="peek"]')
    return button && { pressed: button.getAttribute('aria-pressed') === 'true', text: button.textContent }
  })
  return shown && { pressed: shown.pressed, count: figures(shown.text) }
}

const clickPill = tab => tab.evaluate(() => document.querySelector('.AO3E--filter-toolbar [data-ao3e-action="peek"]').click())

/**
 * Peek shows every work kept off the page that the reader could want back:
 * the ones their own filters hid, and the ones AO3 hides because the reader
 * muted the author.
 */
describe('peeking at works by a muted author', { skip }, () => {
  let browser
  let tab

  before(async () => {
    ({ browser, tab } = await openListing({ 'option.filterToolbar': true, 'option.rules': RULES }))
  }, { timeout: 300000 })

  after(async () => {
    await browser?.close()
  })

  test('the mute keeps all three of the author\'s works off the page', async () => {
    assert.equal(await onScreen(tab, 'work_1'), false)
    assert.equal(await onScreen(tab, 'work_2'), false)
    assert.equal(await onScreen(tab, 'work_3'), false)
    assert.equal(await onScreen(tab, 'work_4'), true)
  })

  test('the pill counts each of them once, hidden by a rule or not', async () => {
    assert.deepEqual(await pill(tab), { pressed: false, count: [3] })
  })

  test('peeking shows all three', async () => {
    await clickPill(tab)
    assert.equal((await pill(tab)).pressed, true)
    assert.equal(await onScreen(tab, 'work_1'), true)
    assert.equal(await onScreen(tab, 'work_2'), true)
    assert.equal(await onScreen(tab, 'work_3'), true)
    assert.equal(await onScreen(tab, 'work_4'), true)
  })

  test('and turning peek off hides them again', async () => {
    await clickPill(tab)
    assert.equal((await pill(tab)).pressed, false)
    assert.equal(await onScreen(tab, 'work_1'), false)
    assert.equal(await onScreen(tab, 'work_2'), false)
    assert.equal(await onScreen(tab, 'work_3'), false)
    assert.equal(await onScreen(tab, 'work_4'), true)
  })
})

/**
 * Muting is a filter of its own, so the pill is there for it even when the
 * reader has no hiding of the extension's switched on.
 */
describe('peeking at a muted author\'s works with no hiding of our own', { skip }, () => {
  let browser
  let tab

  before(async () => {
    ({ browser, tab } = await openListing({ 'option.filterToolbar': true }))
  }, { timeout: 300000 })

  after(async () => {
    await browser?.close()
  })

  test('the pill offers the muted works', async () => {
    assert.deepEqual(await pill(tab), { pressed: false, count: [3] })
  })

  test('and peeking shows them', async () => {
    await clickPill(tab)
    assert.equal(await onScreen(tab, 'work_1'), true)
    assert.equal(await onScreen(tab, 'work_2'), true)
    assert.equal(await onScreen(tab, 'work_3'), true)
    await clickPill(tab)
    assert.equal(await onScreen(tab, 'work_3'), false)
  })
})
