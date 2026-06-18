import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'
const SEED = { 'option.hideTags': { enabled: true, filters: [] } }

describe('options UI — hide-by-tags filter dialog', { skip }, () => {
  let server
  let browser
  let page
  const consoleMsgs = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    page.on('console', m => consoleMsgs.push({ type: m.type(), text: m.text() }))
    page.on('pageerror', e => consoleMsgs.push({ type: 'pageerror', text: e.message }))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1200)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  // --- helpers bound to the live page ---
  const openAddTagDialog = async () => {
    for (const b of await page.$$('[i-mdi-plus-box]')) {
      await b.evaluate(el => (el.closest('button') || el).click())
      await sleep(400)
      const isTag = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]')
        return !!(d && d.querySelector('[i-codicon-regex]') && d.querySelector('[i-codicon-whole-word]'))
      })
      if (isTag) return true
      await page.keyboard.press('Escape'); await sleep(200)
    }
    return false
  }
  const openEditTagDialog = async () => {
    for (const e of await page.$$('[i-codicon-edit]')) {
      await e.evaluate(el => (el.closest('button,a,[role="button"]') || el).click())
      await sleep(400)
      if (await page.$('[role="dialog"]')) return true
    }
    return false
  }
  const clickInDialog = sel => page.evaluate((s) => {
    const el = document.querySelector('[role="dialog"]')?.querySelector(s)
    if (!el) return false
    ;(el.closest('button,a,[role="button"]') || el).click(); return true
  }, sel)
  const saveDialog = () => page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    const b = [...(d?.querySelectorAll('button') || [])].find(x => x.textContent.trim() === 'Save')
    if (!b) return false
    b.click(); return true
  })
  const lastHideTags = () => page.evaluate(() => {
    const w = window.__writes.filter(x => 'option.hideTags' in x).map(x => x['option.hideTags'])
    return w.at(-1) ?? null
  })
  const closeDialog = async () => { await page.keyboard.press('Escape'); await sleep(250) }

  test('matcher icons render (codicon collection loaded)', async () => {
    assert.ok(await openAddTagDialog(), 'the Add-tag-filter dialog should open')
    const styles = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      const read = (sel) => {
        const el = d.querySelector(sel)
        if (!el) return null
        const s = getComputedStyle(el)
        return { mask: s.maskImage || s.webkitMaskImage || '', bg: s.backgroundImage || '' }
      }
      return { regex: read('[i-codicon-regex]'), contains: read('[i-codicon-whole-word]') }
    })
    const renders = s => s && (/url\(/.test(s.mask) || /url\(/.test(s.bg))
    assert.ok(renders(styles.regex), `regex icon should render an image, got ${JSON.stringify(styles.regex)}`)
    assert.ok(renders(styles.contains), `contains icon should render an image, got ${JSON.stringify(styles.contains)}`)
    await closeDialog()
  })

  test('creating a filter with the Regex matcher persists', async () => {
    assert.ok(await openAddTagDialog(), 'the Add-tag-filter dialog should open')
    await page.waitForSelector('[role="dialog"] input[type="text"]', { timeout: 5000 })
    await page.focus('[role="dialog"] input[type="text"]')
    await page.type('[role="dialog"] input[type="text"]', 'e2e-regex')
    assert.ok(await clickInDialog('[i-codicon-regex]'), 'the Regex toggle should be present')
    await sleep(300)
    assert.ok(await saveDialog(), 'the Save button should be present')
    await sleep(1000)
    const stored = await lastHideTags()
    assert.ok(
      stored?.filters?.some(f => f.name === 'e2e-regex' && f.matcher === 'regex'),
      `expected a persisted {name:'e2e-regex', matcher:'regex'} filter, got ${JSON.stringify(stored)}`,
    )
  })

  test('editing a filter to the Contains matcher persists', async () => {
    assert.ok(await openEditTagDialog(), 'the Edit-tag-filter dialog should open')
    await sleep(300)
    assert.ok(await clickInDialog('[i-codicon-whole-word]'), 'the Contains toggle should be present')
    await sleep(300)
    assert.ok(await saveDialog(), 'the Save button should be present')
    await sleep(1000)
    const stored = await lastHideTags()
    assert.ok(
      stored?.filters?.some(f => f.name === 'e2e-regex' && f.matcher === 'contains'),
      `expected the filter's matcher updated to 'contains', got ${JSON.stringify(stored)}`,
    )
  })

  test('dialogs declare an accessible description (no reka warning)', () => {
    const a11y = consoleMsgs.filter(m => /aria-describedby|Description` or|DialogContent/i.test(m.text))
    assert.equal(a11y.length, 0, `unexpected DialogContent a11y warnings: ${JSON.stringify(a11y)}`)
  })
})
