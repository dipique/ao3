import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_URL = 'https://archiveofourown.org/works/1/chapters/107'

const SEED = {
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
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

/**
 * AO3's chapter dropdown. The `selected` attribute is server-rendered onto the
 * chapter actually being shown, and the option text carries the work's own
 * chapter number — the only place on the page it appears.
 */
function chapterIndex(selected) {
  const options = [1, 7, 9]
    .map(n => `<option value="10${n}"${n === selected ? ' selected="selected"' : ''}>${n}. Chapter ${n}</option>`)
    .join('')
  return `<ul id="chapter_index" class="actions"><li><form action="/works/1/navigate">
    <select id="selected_id" name="selected_id">${options}</select>
  </form></li></ul>`
}

/**
 * A work page. `chapters` is the markup inside `#chapters` — one `div.chapter`
 * for a single-chapter view (always `id="chapter-1"`, whichever chapter it is),
 * several when the whole work is shown.
 */
function workPage({ index = '', chapters = '<div class="chapter" id="chapter-1"></div>' } = {}) {
  return `<!doctype html>
<html><head><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="works-show">
    ${index}
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">A long one</h2></div>
      <dl class="stats">
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters"><a href="/works/1/navigate">9</a>/23</dd>
      </dl>
      <div id="chapters">${chapters}</div>
    </div>
  </div>
</body></html>`
}

/**
 * Marking a work ongoing from the work page itself. The chapter it offers must
 * be the one being read, not the one the work has got to — a distinction that
 * only shows up when the reader is behind, which is the entire population of
 * works this mark exists for.
 */
describe('the ongoing mark on a work page', { skip }, () => {
  let browser
  let css
  let js

  before(async () => {
    ensureBuilt()
    css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  /** Open the work menu on `body`, then the editor; report the rows and the field. */
  const inspect = async (body, seed = SEED) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, seed)
    await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1500)

    await tab.evaluate(() => {
      document.querySelector('#workskin > .preface.group > h2.title.heading').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
      )
    })
    await sleep(250)
    const labels = await tab.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item .AO3E--menu--label')]
        .map(el => el.textContent))

    await tab.evaluate(() => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      const row = rows.find(el =>
        el.querySelector('.AO3E--menu--label')?.textContent?.startsWith('Mark as ongoing'))
      if (row)
        row.click()
    })
    await sleep(250)
    const field = await tab.$eval('.AO3E--progress-editor--chapter', el => ({
      value: el.value,
      max: el.max,
    })).catch(() => null)
    await tab.close()
    return { labels, field }
  }

  test('reading chapter 7 of a 9-chapter work prefills 7, not 9', async () => {
    // What this replaces read `div.chapter`'s id — which is `chapter-1` on every
    // single-chapter view, so every mark made this way recorded chapter 1.
    const { field } = await inspect(workPage({ index: chapterIndex(7) }))
    assert.equal(field?.value, '7')
  })

  test('the field is still capped at what is published', async () => {
    const { field } = await inspect(workPage({ index: chapterIndex(7) }))
    assert.equal(field?.max, '9', 'you can record having read up to what exists')
  })

  test('viewing the whole work counts the chapters rendered', async () => {
    // Every chapter is on the page, so the ids do number the work and the
    // highest is where you would have read to.
    const chapters = [1, 2, 3].map(n => `<div class="chapter" id="chapter-${n}"></div>`).join('')
    const { field } = await inspect(workPage({ index: chapterIndex(1), chapters }))
    assert.equal(field?.value, '3')
  })

  test('an already-marked work offers both update rows, naming the right chapters', async () => {
    // The update rows only exist once there is progress to update; an unmarked
    // work gets the single "Mark as ongoing..." row instead. Work 1 is seeded at
    // chapter 3, behind both the chapter being read (7) and the latest (9).
    const marked = JSON.parse(JSON.stringify(SEED))
    marked['option.workMarks'].marks.continue.items = '1'
    marked['option.workMarks'].marks.continue.progress = '1:3'

    const { labels } = await inspect(workPage({ index: chapterIndex(7) }), marked)
    assert.ok(labels.includes('Update to latest chapter (9)'), labels.join(' | '))
    assert.ok(labels.includes('Update to current chapter (7)'), labels.join(' | '))
  })
})
