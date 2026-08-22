import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { packIds, packProgress } from '../../src/common/workMarks.ts'
import { READINESS_COLORS, todayEpochDays } from '../../src/common/workProgress.ts'
import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const LISTING_URL = 'https://archiveofourown.org/tags/A%20Fandom/works'
const MARK_COLOR = '#0369a1'

/**
 * Three works, one per readiness state, against a published count of 9. The
 * wait-until date is built from today at run time — a baked epoch day would make
 * this suite start failing on whatever date it happened to be written for.
 */
function seed() {
  const today = todayEpochDays()
  return {
    'option.workMarks': {
      enabled: true,
      marks: {
        read: { icon: 'read', label: 'Read', color: '#6b7280', hideSearchResult: false, items: '' },
        continue: {
          icon: 'continue',
          label: 'Ongoing',
          color: MARK_COLOR,
          triggerAlias: 'read',
          tracksProgress: true,
          // Off, so all three stay visible and this suite measures colour only —
          // the hiding itself is covered by ongoing-mark.test.mjs.
          hideSearchResult: false,
          items: packIds(['1', '2', '3']),
          progress: packProgress([
            ['1', { chapter: 4 }],                      // behind, no date -> ready
            ['2', { chapter: 4, waitUntil: today + 30 }], // behind, parked -> waiting
            ['3', { chapter: 9 }],                      // level with published -> caught up
          ]),
        },
        saved: { icon: 'saved', label: 'Marked for later', color: '#2f8f4e' },
      },
    },
  }
}

function blurb(id) {
  return `
    <li class="blurb work" id="work_${id}">
      <div class="header module">
        <h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4>
      </div>
      <dl class="stats">
        <dt class="chapters">Chapters:</dt>
        <dd class="chapters"><a href="/works/${id}/navigate">9</a>/23</dd>
      </dl>
    </li>`
}

const PAGE = `<!doctype html>
<html><head><title>Works</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main">
    <ol class="work index group">${[1, 2, 3].map(blurb).join('')}</ol>
  </div>
</body></html>`

/** `#rrggbb` as the `rgb(r, g, b)` string getComputedStyle reports. */
function rgb(hex) {
  const [, r, g, b] = hex.match(/^#(..)(..)(..)$/)
  return `rgb(${Number.parseInt(r, 16)}, ${Number.parseInt(g, 16)}, ${Number.parseInt(b, 16)})`
}

/**
 * The ongoing indicator's colour. The calendar means three different things
 * depending on the work it sits on — "open this now", "parked until a date", and
 * "nothing new yet" — and in the Marked-for-Later view all three are on screen
 * together, so they have to be tellable apart without hovering each one.
 */
describe('the ongoing indicator colour', { skip }, () => {
  let browser
  let colors

  before(async () => {
    ensureBuilt()
    const css = await readFile(join(DIST, 'content_script', 'content_script.css'), 'utf8')
    const js = await readFile(join(DIST, 'content_script', 'content_script.js'), 'utf8')

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check'],
    })
    const page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html', body: PAGE })
      else
        void req.abort()
    })
    await page.evaluateOnNewDocument(installMock, seed())
    await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
    await sleep(1500)

    colors = await page.evaluate(() => Object.fromEntries([1, 2, 3].map((id) => {
      const el = document.querySelector(`#work_${id} .AO3E--indicator--mark-continue`)
      return [id, el ? getComputedStyle(el).color : null]
    })))
    await page.close()
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
  })

  test('a ready work keeps the mark colour', () => {
    assert.equal(colors[1], rgb(MARK_COLOR))
  })

  test('a work parked behind a future date goes amber', () => {
    assert.equal(colors[2], rgb(READINESS_COLORS.waiting))
    assert.notEqual(colors[2], colors[1], 'and is not the ready colour')
  })

  test('a caught-up work goes muted', () => {
    assert.equal(colors[3], rgb(READINESS_COLORS.caughtUp))
    assert.notEqual(colors[3], colors[1], 'and is not the ready colour')
  })

  test('all three states are visually distinct', () => {
    assert.equal(new Set(Object.values(colors)).size, 3, JSON.stringify(colors))
  })
})
