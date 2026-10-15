import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { createDefaultMarks, markItems } from '../../src/common/workMarks.ts'
import { DIST, ensureBuilt, findChrome, installMock } from './helpers.mjs'
import { until } from './optionsPage.mjs'
import { openMenu, rerun, settled } from './trackedPages.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const WORK_ID = '79362971'
const WORK_URL = `https://archiveofourown.org/works/${WORK_ID}`

const FOOT = '#feedback ul.actions'
const FOOT_INDICATOR = `${FOOT} .AO3E--indicators`

function seed() {
  return {
    'option.workMarks': { enabled: true, marks: createDefaultMarks() },
    'option.markForLaterToolbar': true,
  }
}

/** AO3's `button_to` mark form, as it renders it. */
function markForm(action, label) {
  return `<form class="button_to" method="post" action="/works/${WORK_ID}/${action}"><input type="hidden" name="_method" value="patch"><button type="submit">${label}</button></form>`
}

/**
 * A work page in AO3's shape. A work on the reader's Marked for Later list
 * carries "Mark as Read" both in the header and in the feedback actions at the
 * bottom; any other work has "Mark for Later" in the header and an empty `<li>`
 * at the bottom where the button would go.
 */
function workPage({ saved }) {
  const top = saved ? markForm('mark_as_read', 'Mark as Read') : markForm('mark_for_later', 'Mark for Later')
  const bottom = saved ? markForm('mark_as_read', 'Mark as Read') : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>A work</title></head><body class="logged-in">
  <div id="header"><ul class="primary navigation"><li class="dropdown"></li></ul></div>
  <div id="main" class="works-show">
    <ul class="work navigation actions">
      <li class="mark">${top}</li>
    </ul>
    <div id="workskin">
      <div class="preface group"><h2 class="title heading">A finished one</h2></div>
      <div id="chapters"><div class="chapter" id="chapter-1"></div></div>
    </div>
    <div id="feedback" class="feedback">
      <ul class="actions">
        <li><a href="#main">&#8593; Top</a></li>
        <li><form id="new_kudo" action="/kudos" method="post"><input type="submit" value="Kudos ♥" id="kudo_submit"></form></li>
        <li>${bottom}</li>
        <li><a class="bookmark_form_placement_open" href="#bookmark-form">Bookmark</a></li>
      </ul>
    </div>
  </div>
</body></html>`
}

/**
 * The work's indicator, repeated beside the "Mark as Read" AO3 puts at the foot
 * of a work on your Marked for Later list — where you are when you finish it —
 * with the same menu the title opens.
 */
describe('the work indicator beside Mark as Read at the foot of a work', { skip }, () => {
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

  const open = async (body, store = seed()) => {
    const tab = await browser.newPage()
    await tab.setRequestInterception(true)
    tab.on('request', (req) => {
      if (req.url().startsWith('https://archiveofourown.org/'))
        void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body })
      else
        void req.abort()
    })
    await tab.evaluateOnNewDocument(installMock, store)
    await tab.goto(WORK_URL, { waitUntil: 'domcontentloaded' })
    // Record AO3's form submissions instead of letting them navigate, so the
    // page — and what it wrote — is still there to read afterwards. Bubble
    // phase, so the extension's own capture-phase listener has already run.
    await tab.evaluate(() => {
      window.__submitted = []
      window.addEventListener('submit', (e) => {
        window.__submitted.push(e.target.getAttribute('action'))
        e.preventDefault()
      })
    })
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await settled(tab)
    return tab
  }

  /** The last mark table the page wrote, or null. */
  const lastMarks = tab => tab.evaluate(() => {
    const writes = window.__writes ?? []
    for (let i = writes.length - 1; i >= 0; i--) {
      const marks = writes[i]['option.workMarks']?.marks
      if (marks)
        return marks
    }
    return null
  })

  test('the Marked for Later clock sits right after the button', async () => {
    const tab = await open(workPage({ saved: true }))
    const shown = await tab.evaluate((selector) => {
      const indicator = document.querySelectorAll(selector)
      const button = document.querySelector('#feedback ul.actions form[action$="/mark_as_read"]')
      return {
        count: indicator.length,
        saved: !!indicator[0]?.querySelector('.AO3E--indicator--mark-saved'),
        afterButton: button?.nextElementSibling === indicator[0],
      }
    }, FOOT_INDICATOR)
    await tab.close()
    assert.equal(shown.count, 1)
    assert.ok(shown.saved, 'it is the Marked for Later clock')
    assert.ok(shown.afterButton, 'beside the button, on its line')
  })

  test('clicking it opens the title\'s menu', async () => {
    const tab = await open(workPage({ saved: true }))
    await openMenu(tab, () => tab.click(`${FOOT_INDICATOR} .AO3E--indicator`))
    const labels = await tab.evaluate(() =>
      [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item .AO3E--menu--label')].map(el => el.textContent))
    await tab.close()
    assert.ok(labels.includes('Mark as favorite'), labels.join(' | '))
    assert.ok(labels.includes('Remove from Marked for Later'), labels.join(' | '))
  })

  test('a read mark chosen there records it and marks the work read on AO3', async () => {
    const tab = await open(workPage({ saved: true }))
    await openMenu(tab, () => tab.click(`${FOOT_INDICATOR} .AO3E--indicator`))
    await tab.evaluate(() => {
      const rows = [...document.querySelectorAll('.AO3E--menu .AO3E--menu--item')]
      rows.find(el => el.querySelector('.AO3E--menu--label')?.textContent === 'Mark as favorite').click()
    })
    await until('AO3\'s Mark as Read to be submitted', () =>
      tab.evaluate(() => window.__submitted.length > 0))
    await until('the mark to be written', async () => !!(await lastMarks(tab)))
    const submitted = await tab.evaluate(() => window.__submitted)
    const marks = await lastMarks(tab)
    await tab.close()

    assert.deepEqual(submitted, [`/works/${WORK_ID}/mark_as_read`], 'off the Marked for Later list, through AO3\'s own button')
    assert.ok(markItems(marks, 'favorite').has(WORK_ID), 'the mark is recorded')
    assert.ok(!markItems(marks, 'read').has(WORK_ID), 'and AO3\'s button did not flatten it to plain read')
  })

  test('the title keeps its own indicator', async () => {
    const tab = await open(workPage({ saved: true }))
    const title = await tab.evaluate(() =>
      !!document.querySelector('#workskin h2.title.heading .AO3E--indicators .AO3E--indicator--mark-saved'))
    await tab.close()
    assert.ok(title)
  })

  test('a work not on Marked for Later has nothing at the foot', async () => {
    const tab = await open(workPage({ saved: false }))
    const count = await tab.evaluate(selector => document.querySelectorAll(selector).length, FOOT_INDICATOR)
    await tab.close()
    assert.equal(count, 0)
  })

  test('a re-run leaves one indicator, not two', async () => {
    const store = seed()
    const tab = await open(workPage({ saved: true }), store)
    await rerun(tab, () => tab.evaluate(workMarks =>
      window.browser.storage.local.set({ 'option.workMarks': workMarks }), store['option.workMarks']))
    const count = await tab.evaluate(selector => document.querySelectorAll(selector).length, FOOT_INDICATOR)
    await tab.close()
    assert.equal(count, 1)
  })
})
