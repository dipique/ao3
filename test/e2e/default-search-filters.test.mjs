import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { DIST, ensureBuilt, findChrome, installMock, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const SEED = {
  'option.searchCompletion': { enabled: true, completion: 'complete' },
  'option.searchCrossovers': { enabled: true, crossovers: 'exclude' },
}

/** One of AO3's three-way radio filters, spelled as its Sort & Filter sidebar spells it. */
function radios(field, values, checked) {
  return values.map(value => `
    <label for="work_search_${field}_${value.toLowerCase()}">
      <input type="radio" value="${value}" name="work_search[${field}]" id="work_search_${field}_${value.toLowerCase()}"${value === checked ? ' checked="checked"' : ''}>
    </label>`).join('')
}

/** A listing's filter form, with whatever completion and crossover choice the page arrived with. */
const page = ({ complete = '', crossover = '' } = {}) => `
<div id="main">
  <ol class="work index group"></ol>
  <form id="work-filters" method="get" action="#">
    ${radios('crossover', ['', 'F', 'T'], crossover)}
    ${radios('complete', ['', 'T', 'F'], complete)}
    <input type="submit" name="commit" value="Sort and Filter">
  </form>
</div>
`

/**
 * The completion and crossover defaults fill AO3's own radios the way the
 * language and word-count defaults fill theirs: only when the page arrived with
 * nothing chosen, and without running the search.
 */
describe('default completion and crossover filters', { skip }, () => {
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

  /** A fresh tab holding `html`, with the content script run over it. */
  const open = async (html) => {
    const tab = await browser.newPage()
    await tab.goto('about:blank')
    await tab.evaluate(installMock, SEED)
    await tab.evaluate((body) => {
      document.body.innerHTML = body
      window.__submits = 0
      document.getElementById('work-filters').addEventListener('submit', (e) => {
        e.preventDefault()
        window.__submits++
      })
    }, html)
    await tab.addStyleTag({ content: css })
    await tab.addScriptTag({ content: js })
    await sleep(1500)
    return tab
  }

  const form = tab => tab.evaluate(() => ({
    complete: document.querySelector('input[name="work_search[complete]"]:checked')?.value ?? null,
    crossover: document.querySelector('input[name="work_search[crossover]"]:checked')?.value ?? null,
    submits: window.__submits,
  }))

  /** The pending-search prompt's message, or null when it isn't up. */
  const prompt = tab => tab.evaluate(() => {
    for (const el of document.body.children) {
      const toast = [...el.shadowRoot?.querySelectorAll('.toast') ?? []]
        .find(t => t.querySelector('.action')?.textContent.startsWith('Update results'))
      if (toast && toast.style.visibility !== 'hidden')
        return toast.querySelector('.message').textContent
    }
    return null
  })

  test('a blank filter takes both defaults, and the reader is told the results are out of date', async () => {
    const tab = await open(page())
    assert.deepEqual(await form(tab), { complete: 'T', crossover: 'F', submits: 0 })
    assert.ok(await prompt(tab), 'the pending-search prompt is up')
  })

  test('a choice the page arrived with is left alone', async () => {
    const tab = await open(page({ complete: 'F', crossover: 'T' }))
    assert.deepEqual(await form(tab), { complete: 'F', crossover: 'T', submits: 0 })
    assert.equal(await prompt(tab), null)
  })

  test('each says what it did', async () => {
    const tab = await open(page({ crossover: 'T' }))
    assert.equal(await prompt(tab), 'Completion filter set to completed works only.')

    const other = await open(page({ complete: 'T' }))
    assert.equal(await prompt(other), 'Crossover filter set to no crossovers.')
  })
})
