import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/tags/A%20Fandom/works'

/**
 * The shipped mark table, spelled out: storage falls back per *key*, not per
 * field, so a seed with `enabled` and no `marks` would hand the content script
 * an undefined table. `markForLaterToolbar` is left off, so nothing here reaches
 * the network — the ongoing mark's "also save it for later" step is a no-op
 * without it.
 */
const SEED = {
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
      favorite: { icon: 'favorite', label: 'Favorite', color: '#c2185b', triggerAlias: 'read', items: '' },
      continue: {
        icon: 'continue',
        label: 'Ongoing',
        color: '#0369a1',
        triggerAlias: 'read',
        tracksProgress: true,
        hideSearchResult: true,
        items: '',
        progress: '',
      },
      saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
    },
  },
}

/** A blurb whose `dd.chapters` cell is given verbatim, so all three shapes appear. */
function blurb(id, title, chapters) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">${title}</a></h4>
      </div>
      <dl class="stats">
        <dt class="words">Words:</dt>
        <dd class="words">7,150</dd>
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters">${chapters}</dd>
      </dl>
    </li>`
}

/**
 * The three shapes `dd.chapters` comes in: a multi-chapter work (whose total is
 * rendered *outside* the anchor, which is exactly why the count is parsed from
 * the text rather than from `data-ao3e-original`), an open-ended one, and a
 * one-shot with no anchor at all.
 *
 * Served from the archive's own origin rather than about:blank, because a blank
 * document has no base URL and `/works/:id` can't be resolved against it — so
 * the work menu would never find a work to be about.
 */
const PAGE = `<!doctype html>
<html><head><title>Works</title></head>
<body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" style="padding-bottom: 200vh">
    <ol class="work index group">
      ${blurb(1, 'A long one', '<a href="/works/1/navigate">9</a>/23')}
      ${blurb(2, 'An open-ended one', '<a href="/works/2/navigate">4</a>/?')}
      ${blurb(3, 'A one-shot', '1/1')}
    </ol>
  </div>
</body></html>`

describe('the ongoing mark', { skip }, () => {
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
    // Every archive request is answered from the fixture; nothing leaves the machine.
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: PAGE })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, SEED)
    await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Right-click a work's title to open its menu, and read the rows back. */
  const openWorkMenu = async (id) => {
    await page.evaluate((workId) => {
      document.querySelector(`#work_${workId} h4.heading a`).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    }, id)
    await sleep(300)
    return page.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')].map(el => ({
        label: el.querySelector('.AO3E--menu--label').textContent,
        disabled: el.disabled,
      })))
  }

  const clickRow = async (prefix) => {
    await page.evaluate((p) => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      rows.find(el => el.textContent.startsWith(p)).click()
    }, prefix)
    await sleep(250)
  }

  /** The ongoing mark as the last `option.workMarks` write left it, or null. */
  const lastMarks = () => page.evaluate(() => {
    const writes = window.__writes.filter(w => 'option.workMarks' in w)
    return writes.length ? writes[writes.length - 1]['option.workMarks'].marks.continue : null
  })

  test('an unmarked work offers one row, and it opens the editor', async () => {
    const labels = (await openWorkMenu(1)).map(i => i.label)
    assert.ok(labels.includes('Mark as ongoing…'), labels.join(' | '))
    assert.ok(!labels.some(l => l.startsWith('Update to')), 'nothing to update yet')
    assert.ok(!labels.includes('Unmark as ongoing'), labels.join(' | '))
  })

  test('the editor prefills the published count, not the author\'s target', async () => {
    await clickRow('Mark as ongoing…')
    const value = await page.$eval('.AO3E--progress-editor--chapter', el => el.value)
    // 9 of a stated 23: the right-hand number is a guess and counts nothing.
    assert.equal(value, '9')
  })

  test('it takes focus, so the keyboard reaches it', async () => {
    const focused = await page.evaluate(() => document.activeElement?.className ?? '')
    assert.match(focused, /progress-editor--input/)
  })

  test('and survives a scroll, which would dismiss an ordinary popover', async () => {
    // The one that actually breaks a form in a popover: focusing an off-screen
    // field scrolls it into view, and a mobile keyboard opening fires resize.
    await page.evaluate(() => window.scrollBy(0, 300))
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await sleep(250)
    assert.notEqual(await page.$('.AO3E--progress-editor'), null, 'the editor must still be open')
  })

  test('saving writes the mark and its progress in one option write', async () => {
    await page.evaluate(() => {
      document.querySelector('.AO3E--progress-editor--chapter').value = '9'
      document.querySelector('.AO3E--progress-editor--save').click()
    })
    await sleep(300)
    const mark = await lastMarks()
    assert.notEqual(mark, null, 'no option.workMarks write was made')
    // Work 1, delta-encoded from 0, chapter 9 in base 36 — and no trailing
    // colon, because no wait-until date was set.
    assert.equal(mark.items, '1')
    assert.equal(mark.progress, '1:9')
  })

  test('the editor closes itself on save', async () => {
    assert.equal(await page.$('.AO3E--progress-editor'), null)
  })

  test('a caught-up work collapses, naming why', async () => {
    // The re-run is debounced 500ms after the option write.
    await sleep(1500)
    const hiddenBy = await page.evaluate(() => document.getElementById('work_1')?.dataset.ao3eHiddenBy ?? null)
    assert.equal(hiddenBy, 'marks')
    const reason = await page.evaluate(() =>
      document.getElementById('work_1')?.querySelector('.AO3E--hide-works--reasons')?.textContent ?? '')
    assert.match(reason, /Ongoing \(No unread chapters\): A long one/)
  })

  test('the hover text says what is unread and what the date does', async () => {
    const title = await page.evaluate(() =>
      document.getElementById('work_1')?.querySelector('.AO3E--hide-works--reason-value')?.title ?? '')
    assert.equal(title, 'No unread chapters\nReady (no Wait Until date set)')
  })

  test('a marked work offers the update rows, with the current one inert', async () => {
    const items = await openWorkMenu(1)
    const labels = items.map(i => i.label)
    assert.ok(labels.includes('Update to latest chapter (9)'), labels.join(' | '))
    assert.ok(labels.includes('Set wait-until date…'), labels.join(' | '))
    assert.ok(labels.includes('Unmark as ongoing'), labels.join(' | '))
    assert.ok(!labels.includes('Mark as ongoing…'), 'the marked work does not offer the first-time row')
    // This is a listing, not a work page, so there is no "current chapter".
    assert.ok(!labels.some(l => l.startsWith('Update to current')), labels.join(' | '))
    const latest = items.find(i => i.label.startsWith('Update to latest'))
    assert.equal(latest.disabled, true, 'already on chapter 9 — the row states where you are')
    await page.keyboard.press('Escape')
    await sleep(200)
  })

  test('an open-ended work reads its published count, ignoring the "?"', async () => {
    const labels = (await openWorkMenu(2)).map(i => i.label)
    assert.ok(labels.includes('Mark as ongoing…'), labels.join(' | '))
    await clickRow('Mark as ongoing…')
    const value = await page.$eval('.AO3E--progress-editor--chapter', el => el.value)
    assert.equal(value, '4')
    await page.evaluate(() => document.querySelector('.AO3E--progress-editor--cancel').click())
    await sleep(200)
  })

  test('updating to the latest chapter writes without opening a dialog', async () => {
    // A one-shot with no anchor at all in its dd.chapters — the third shape.
    await openWorkMenu(3)
    await clickRow('Mark as ongoing…')
    await page.evaluate(() => {
      document.querySelector('.AO3E--progress-editor--chapter').value = '0'
      document.querySelector('.AO3E--progress-editor--save').click()
    })
    await sleep(1500)

    await openWorkMenu(3)
    await clickRow('Update to latest chapter (1)')
    assert.equal(await page.$('.AO3E--progress-editor'), null, 'no dialog for a one-click update')
    const mark = await lastMarks()
    // Works 1 and 3 both marked: deltas 1 and 2, chapters 9 and 1.
    assert.equal(mark.items, '1,2')
    assert.equal(mark.progress, '1:9,2:1')
  })
})
