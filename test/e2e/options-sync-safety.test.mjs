import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { ensureBuilt, findChrome, installMock, serveDist, sleep } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const HELD = {
  reason: 'held',
  g: 5,
  w: 'desktop.x',
  at: 0,
  backedUp: true,
  loss: { rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: { removed: 0, of: 26 }, marks: [] },
}

/**
 * Stand in for the background: answer each API message from `replies` (keyed by
 * method name; `'never'` leaves the message unanswered, the way a background
 * too old to know the method does), and record what was sent.
 */
function scriptBackground(replies) {
  window.__sent = []
  const send = window.browser.runtime
  send.sendMessage = (message) => {
    const [name] = Object.keys(message ?? {})
    window.__sent.push({ name, args: message?.[name] })
    const reply = replies[name]
    if (reply === 'never')
      return new Promise(() => {})
    return Promise.resolve(reply)
  }
}

/**
 * The sync row's safety messages: a refused switch, a held update and its two
 * answers, and an out-of-date background. The engine behind them is covered by
 * the sync scenario tests; this is what the reader sees and what gets sent.
 */
describe('options UI — sync safety', { skip }, () => {
  let server
  let browser

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  async function open(seed, replies = {}) {
    const page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, seed)
    await page.evaluateOnNewDocument(scriptBackground, replies)
    await page.goto(`${server.url}/options_ui/options_ui.html#sync-backups`, { waitUntil: 'networkidle2' })
    await sleep(1200)
    return page
  }

  const text = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, selector)

  /** The "Sync settings across devices" switch, found through its row's label. */
  const syncSwitch = page => page.evaluateHandle(() => {
    const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('Sync settings across devices'))
    return document.getElementById(label?.getAttribute('for') ?? '')
  })

  test('turning sync on against a newer sync version is refused, and the switch goes back off', async () => {
    const page = await open({}, { setSyncEnabled: { ok: false, reason: 'newer-version', remoteVersion: 3, version: 2 } })
    try {
      const toggle = await syncSwitch(page)
      assert.ok(await toggle.evaluate(el => !!el), 'the sync switch is on the page')
      await toggle.evaluate(el => el.click())
      await sleep(400)

      assert.match(await text(page, '[data-sync-refusal]') ?? '', /^Can't turn on sync: .*sync version 3; this browser has 2\)/)
      assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'false')
      assert.deepEqual(await page.evaluate(() => window.__sent.filter(m => m.name === 'setSyncEnabled').map(m => m.args)), [[true]])
    }
    finally {
      await page.close()
    }
  })

  test('a held update says what it would remove and sends the reader\'s answer', async () => {
    const page = await open({ 'sync.enabled': true, 'sync.pause': HELD }, { resolveHeldSync: { resolved: true } })
    try {
      const message = await text(page, '[data-sync-pause="held"] p')
      assert.equal(message, 'Sync is on hold: an update from another browser would remove 348 of your 348 rules and 267 of your 282 marked works. A backup of this browser\'s settings was saved first.')

      await page.evaluate(() => document.querySelector('[data-sync-keep]').click())
      await sleep(300)
      assert.deepEqual(await page.evaluate(() => window.__sent.filter(m => m.name === 'resolveHeldSync').map(m => m.args)), [['keep']])

      await page.evaluate(() => document.querySelector('[data-sync-accept]').click())
      await sleep(300)
      assert.deepEqual(await page.evaluate(() => window.__sent.filter(m => m.name === 'resolveHeldSync').map(m => m.args[0])), ['keep', 'accept'])
    }
    finally {
      await page.close()
    }
  })

  test('a version pause explains itself without offering answers', async () => {
    const page = await open({ 'sync.enabled': true, 'sync.pause': { reason: 'newer-version', remoteVersion: 3 } })
    try {
      assert.match(await text(page, '[data-sync-pause="newer-version"] p') ?? '', /^Sync is paused: .*sync version 3; this browser has 2\)/)
      assert.equal(await page.$('[data-sync-keep]'), null)
    }
    finally {
      await page.close()
    }
  })

  test('a background that found itself out of date says sync is paused', async () => {
    const page = await open({ 'sync.enabled': true, 'sync.staleBuild': { running: 'old', onDisk: 'new' } })
    try {
      assert.match(await text(page, '[data-sync-stale]') ?? '', /Reload AO3 Enhancements .*Sync is paused until then\.$/)
    }
    finally {
      await page.close()
    }
  })

  test('a background answering with another build is called out of date', async () => {
    const page = await open({ 'sync.enabled': true }, { getBuildInfo: { buildId: 'some-other-build', syncVersion: 2 } })
    try {
      assert.match(await text(page, '[data-sync-stale]') ?? '', /Sync may not work until then\.$/)
    }
    finally {
      await page.close()
    }
  })

  test('a background that never answers is called out of date once the wait runs out', async () => {
    const page = await open({ 'sync.enabled': true }, { getBuildInfo: 'never' })
    try {
      assert.equal(await page.$('[data-sync-stale]'), null, 'not before the wait is up')
      await sleep(5500)
      assert.match(await text(page, '[data-sync-stale]') ?? '', /Sync may not work until then\.$/)
    }
    finally {
      await page.close()
    }
  }, { timeout: 30000 })

  test('a current background, or none at all, raises nothing', async () => {
    const page = await open({ 'sync.enabled': true })
    try {
      await sleep(5500)
      assert.equal(await page.$('[data-sync-stale]'), null)
    }
    finally {
      await page.close()
    }
  }, { timeout: 30000 })
})
