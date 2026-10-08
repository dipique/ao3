import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { BUILD_CHECK_TIMEOUT_MS } from '../../src/common/constants.ts'
import { SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { outlast } from './helpers.mjs'
import { scriptBackground, skip, startOptions, until } from './optionsPage.mjs'

/** This build's sync version, and a newer build's. */
const V = SYNC_SCHEMA_VERSION
const NEWER = V + 1
const OLDER = V - 1

const WIDE = { width: 1440, height: 900 }
const NARROW = { width: 390, height: 844 }

const HELD = {
  reason: 'held',
  g: 5,
  w: 'desktop.x',
  at: 0,
  backedUp: true,
  loss: { rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: { removed: 0, of: 26 }, marks: [] },
}

/** The word a screen reader hears for each severity's glyph. */
const WORDS = { destructive: 'Error:', warning: 'Warning:', success: 'Success:', neutral: 'Note:' }

/** Synced storage `percent` full of a 100 KB room. */
const usage = percent => ({ getSyncUsage: { used: percent * 1024, quota: 100 * 1024, overheadBytes: 0 } })

/**
 * In the page: each callout `selector` matches, as
 * - `severity`: its `data-callout`;
 * - `lead`: what comes before the message, which is the glyph's word;
 * - `message`: its first paragraph;
 * - `colour`: the message's colour, and `body`: the body colour, `default-fg`.
 */
function readCallouts(selector) {
  const squash = text => (text ?? '').replace(/\s+/g, ' ').trim()
  const body = `rgb(${getComputedStyle(document.body).getPropertyValue('--color-default-fg').trim().split(/\s+/).join(', ')})`
  return [...document.querySelectorAll(selector)].map((el) => {
    const message = el.querySelector('p')
    const text = squash(el.textContent)
    return {
      severity: el.dataset.callout ?? null,
      lead: text.slice(0, text.indexOf(squash(message?.textContent))).trim(),
      message: squash(message?.textContent),
      colour: message && getComputedStyle(message).color,
      body,
    }
  })
}

/**
 * In the page: the panel's status line, or null while the panel is the switch
 * alone. `chip` is the chip's state and what a screen reader reads of it: its
 * word alone, which says what the glyph's colour does. `detail` is the
 * sentence beside it, and `last` when sync last succeeded.
 */
function readStatus() {
  const squash = text => (text ?? '').replace(/\s+/g, ' ').trim()
  const panel = document.querySelector('[data-sync-panel]')
  const chip = panel.querySelector('[data-sync-chip]')
  if (!chip)
    return null
  return {
    chip: { state: chip.dataset.syncChip, text: squash(chip.textContent) },
    detail: squash(panel.querySelector('[data-sync-detail]')?.textContent) || null,
    last: squash(panel.querySelector('[data-sync-last]')?.textContent) || null,
  }
}

/** In the page: the usage bar's fill colour, and the colour of each token it may take. */
function readUsageBar() {
  const fill = document.querySelector('[data-sync-usage-bar]')
  const token = name => `rgb(${getComputedStyle(document.body).getPropertyValue(`--color-${name}`).trim().split(/\s+/).join(', ')})`
  return fill && {
    fill: getComputedStyle(fill).backgroundColor,
    tokens: { success: token('success'), warning: token('warning'), destructive: token('destructive') },
  }
}

/** In the page: the image the glyph inside `selector` is drawn from, or null if it has none. */
function glyphImage(selector) {
  const glyph = document.querySelector(selector)?.querySelector('[data-glyph]')
  if (!glyph)
    return null
  const style = getComputedStyle(glyph)
  return [style.maskImage, style.webkitMaskImage].find(image => image && image !== 'none') ?? null
}

/** In the page: each held answer's button, as `{ name, look, box }`, and its consequence. */
function readAnswers() {
  const squash = text => (text ?? '').replace(/\s+/g, ' ').trim()
  return [...document.querySelectorAll('[data-sync-answer]')].map((choice) => {
    const button = choice.querySelector('button')
    const style = getComputedStyle(button)
    const { top, bottom, left, right } = choice.getBoundingClientRect()
    return {
      answer: choice.dataset.syncAnswer,
      label: squash(button.textContent),
      consequence: squash((button.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' ')),
      look: [style.backgroundColor, style.color, style.borderColor, style.fontWeight, style.height].join(' '),
      box: { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) },
    }
  })
}

/**
 * The Sync sub-section: a panel headed by the "Sync settings across devices"
 * switch, reporting on it. While sync is off the panel is the switch alone,
 * unless something bears on turning it on. Otherwise a chip names the state,
 * with when sync last succeeded beside it, callouts say what is wrong and what
 * to do, and a bar shows how full the synced storage is. A held update asks a
 * question: what it would remove, one line each, and two answers of equal
 * weight, each with its consequence. The engine behind it is covered by the
 * sync scenario tests, and the words by the status view's unit tests; this is
 * what the reader sees and what gets sent.
 *
 * Each message is a callout: a glyph, an edge and a tint in its severity's
 * colour, a word for the glyph, and the message in the body colour. A pause
 * draws a glyph of its own, the same on its chip and its callout.
 */
describe('options UI — the sync panel', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The options page at Sync, its background answering from `replies`. */
  const open = (seed, replies = {}, viewport = WIDE) => session.open({
    seed,
    hash: '#sync',
    viewport,
    prepare: page => page.evaluateOnNewDocument(scriptBackground, replies),
  })

  /** The "Sync settings across devices" switch, which heads the panel. Its row's description is part of its name. */
  const syncSwitch = async options => options.control(await options.page.$('[data-sync-panel]'), 'switch', /^Sync settings across devices/)

  /** The message `hook` marks is a callout of `severity`, led by its word, saying `message`. */
  async function assertCallout(options, hook, severity, message) {
    const [callout] = await options.page.evaluate(readCallouts, hook)
    assert.ok(callout, `nothing at ${hook}`)
    assert.equal(callout.severity, severity)
    assert.equal(callout.lead, WORDS[severity])
    assert.match(callout.message, message)
  }

  test('Sync & Backups has two sub-sections, Sync and Backups', async () => {
    const options = await open({})
    try {
      assert.deepEqual(await options.shownCategories(), ['sync-backups'])
      const subsections = (await options.railItems()).filter(item => item.kind === 'subsection')
      assert.deepEqual(subsections.map(s => [s.id, s.name]), [['sync', 'Sync'], ['backups', 'Backups']])
    }
    finally {
      await options.close()
    }
  })

  test('off, the panel is the switch alone', async () => {
    const options = await open({ 'sync.enabled': false, 'sync.lastSyncAt': Date.now() }, usage(68))
    try {
      const toggle = await syncSwitch(options)
      assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'false')
      assert.equal(await options.page.evaluate(readStatus), null)
      assert.deepEqual(await options.page.evaluate(readCallouts, '[data-sync-panel] [data-callout]'), [])
      assert.equal(await options.page.$('[data-sync-usage]'), null)
    }
    finally {
      await options.close()
    }
  })

  test('on and healthy: syncing, when it last synced, and how full the synced storage is', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.lastSyncAt': Date.now() - 60000 }, usage(68))
    try {
      const status = await options.page.evaluate(readStatus)
      assert.deepEqual(status.chip, { state: 'syncing', text: 'Syncing' })
      assert.equal(status.detail, null)
      assert.match(status.last, /^Last synced \S/)
      assert.deepEqual(await options.page.evaluate(readCallouts, '[data-sync-panel] [data-callout]'), [])

      const figure = await options.page.$('[data-sync-usage]')
      assert.match(await options.text(figure), /^Synced storage .*68\.0 KB of 100\.0 KB · 68%$/)
      assert.equal(await options.page.evaluate(glyphImage, '[data-sync-usage]'), null, 'no glyph below 70%')
    }
    finally {
      await options.close()
    }
  })

  test('before its first sync, says it hasn\'t synced yet', async () => {
    const options = await open({ 'sync.enabled': true })
    try {
      assert.equal((await options.page.evaluate(readStatus)).last, 'Not synced yet')
    }
    finally {
      await options.close()
    }
  })

  test('turning sync on against a newer sync version is refused: the switch goes back off and says why', async () => {
    const options = await open({}, { setSyncEnabled: { ok: false, reason: 'newer-version', remoteVersion: NEWER, version: V } })
    try {
      const toggle = await syncSwitch(options)
      await options.press(toggle)
      await options.page.waitForSelector('[data-sync-refusal]')

      await assertCallout(options, '[data-sync-refusal]', 'destructive', new RegExp(`^Can't turn on sync: .*sync version ${NEWER}; this browser has ${V}\\)`))
      assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'false')
      assert.deepEqual(await options.sent('setSyncEnabled'), [[true]])
      const status = await options.page.evaluate(readStatus)
      assert.deepEqual(status.chip, { state: 'off', text: 'Off' })
      assert.equal(status.last, null, 'nothing has synced while it is off')
    }
    finally {
      await options.close()
    }
  })

  describe('a held update', () => {
    test('asks: what it would remove, one line each, and two answers of equal weight with their consequences', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.lastSyncAt': Date.now(), 'sync.pause': HELD })
      try {
        const status = await options.page.evaluate(readStatus)
        assert.deepEqual(status.chip, { state: 'held', text: 'On hold' })
        assert.equal(status.detail, 'An update from another browser is waiting for your answer.')
        assert.match(status.last, /^Last synced /)

        await assertCallout(options, '[data-sync-pause="held"]', 'warning', /^An update from another browser would remove:$/)
        const callout = await options.page.$('[data-sync-pause="held"]')
        assert.deepEqual(await callout.$$eval('[data-sync-losses] li', items => items.map(li => li.textContent.replace(/\s+/g, ' ').trim())), [
          '348 of your 348 rules',
          '267 of your 282 marked works',
        ])
        assert.ok((await options.lines(callout)).includes('A backup of this browser\'s settings was saved first.'))

        const answers = await options.page.evaluate(readAnswers)
        assert.deepEqual(answers.map(a => [a.answer, a.label, a.consequence]), [
          ['keep', 'Keep this browser\'s settings', 'Sends this browser\'s settings to your other browsers. What the update had is kept as a backup first.'],
          ['accept', 'Accept the update', 'Replaces this browser\'s settings with the other browser\'s. Yours were backed up when sync held.'],
        ])
        assert.equal(answers[0].look, answers[1].look, 'neither answer is drawn as the one to pick')
        assert.equal(answers[0].box.top, answers[1].box.top, 'side by side')
        assert.ok(answers[1].box.left > answers[0].box.right, 'side by side')
      }
      finally {
        await options.close()
      }
    })

    test('sends the reader\'s answer', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.pause': HELD }, { resolveHeldSync: { resolved: true } })
      try {
        await options.press(await options.page.$('[data-sync-keep]'))
        await until('the answer to be sent', async () => (await options.sent('resolveHeldSync')).length === 1)
        assert.deepEqual(await options.sent('resolveHeldSync'), [['keep']])

        await options.press(await options.page.$('[data-sync-accept]'))
        await until('the second answer to be sent', async () => (await options.sent('resolveHeldSync')).length === 2)
        assert.deepEqual((await options.sent('resolveHeldSync')).map(args => args[0]), ['keep', 'accept'])
      }
      finally {
        await options.close()
      }
    })

    test('on a phone, stacks the two answers', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.pause': HELD }, {}, NARROW)
      try {
        const [keep, accept] = await options.page.evaluate(readAnswers)
        assert.ok(accept.box.top >= keep.box.bottom, `keep ends at ${keep.box.bottom}px, accept starts at ${accept.box.top}px`)
        assert.equal(keep.box.left, accept.box.left)
        assert.equal(keep.box.right, accept.box.right)
        const { scrollWidth, innerWidth } = await options.page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
        assert.ok(scrollWidth <= innerWidth, `the page is ${scrollWidth} px wide in a ${innerWidth} px window`)
      }
      finally {
        await options.close()
      }
    })
  })

  test('a version pause explains itself without offering answers', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.pause': { reason: 'newer-version', remoteVersion: NEWER } })
    try {
      await assertCallout(options, '[data-sync-pause="newer-version"]', 'warning', new RegExp(`^Your synced settings were saved by a newer version .*sync version ${NEWER}; this browser has ${V}\\)`))
      const status = await options.page.evaluate(readStatus)
      assert.deepEqual(status.chip, { state: 'newer-version', text: 'Paused' })
      assert.equal(status.detail, 'This browser is older than your synced settings. It lifts by itself once updated.')
      assert.equal(await options.page.$('[data-sync-keep]'), null)
      assert.equal(await options.page.$('[data-sync-answer]'), null)
    }
    finally {
      await options.close()
    }
  })

  test('older synced settings wait for this version to save them', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.pause': { reason: 'older-cloud', remoteVersion: OLDER } })
    try {
      await assertCallout(options, '[data-sync-pause="older-cloud"]', 'warning', new RegExp(`^Your synced settings were saved by an older version .*sync version ${OLDER}; this browser has ${V}\\)`))
      assert.deepEqual((await options.page.evaluate(readStatus)).chip, { state: 'older-cloud', text: 'Waiting' })
    }
    finally {
      await options.close()
    }
  })

  test('each pause draws a glyph of its own, the same on its chip and its callout', async () => {
    const glyphs = {}
    for (const [state, pause] of [['held', HELD], ['newer-version', { reason: 'newer-version', remoteVersion: NEWER }], ['older-cloud', { reason: 'older-cloud', remoteVersion: OLDER }]]) {
      const options = await open({ 'sync.enabled': true, 'sync.pause': pause })
      try {
        const chip = await options.page.evaluate(glyphImage, '[data-sync-chip]')
        const callout = await options.page.evaluate(glyphImage, `[data-sync-pause="${state}"]`)
        assert.ok(chip, `a glyph on the ${state} chip`)
        assert.equal(callout, chip, `the ${state} callout's glyph is its chip's`)
        glyphs[state] = chip
      }
      finally {
        await options.close()
      }
    }
    // A plain warning's glyph, on the usage figure at 75%.
    const options = await open({ 'sync.enabled': true }, usage(75))
    try {
      glyphs.warning = await options.page.evaluate(glyphImage, '[data-sync-usage]')
      assert.ok(glyphs.warning)
    }
    finally {
      await options.close()
    }
    assert.equal(new Set(Object.values(glyphs)).size, 4, 'held, newer-version, older-cloud and a plain warning each look different')
  }, { timeout: 60000 })

  test('the last sync error is shown as an error, in place of when it last synced', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.lastSyncAt': Date.now(), 'sync.lastError': 'QUOTA_BYTES quota exceeded' })
    try {
      await assertCallout(options, '[data-sync-error]', 'destructive', /^QUOTA_BYTES quota exceeded$/)
      const status = await options.page.evaluate(readStatus)
      assert.deepEqual(status.chip, { state: 'error', text: 'Couldn\'t sync' })
      assert.equal(status.detail, 'It will be tried again.')
      assert.equal(status.last, null)
    }
    finally {
      await options.close()
    }
  })

  test('a background that found itself out of date says sync is paused', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.staleBuild': { running: 'old', onDisk: 'new' } })
    try {
      await assertCallout(options, '[data-sync-stale]', 'destructive', /Reload AO3 Enhancements .*Sync is paused until then\.$/)
      assert.deepEqual((await options.page.evaluate(readStatus)).chip, { state: 'stale', text: 'Reload needed' })
    }
    finally {
      await options.close()
    }
  })

  test('a background answering with another build is called out of date', async () => {
    const options = await open({ 'sync.enabled': true }, { getBuildInfo: { buildId: 'some-other-build', syncVersion: V } })
    try {
      await assertCallout(options, '[data-sync-stale]', 'destructive', /Sync may not work until then\.$/)
    }
    finally {
      await options.close()
    }
  })

  test('a background that never answers is called out of date once the wait runs out', async () => {
    const options = await open({ 'sync.enabled': true }, { getBuildInfo: 'never' })
    try {
      assert.equal(await options.page.$('[data-sync-stale]'), null, 'not before the wait is up')
      await until('the background to be called out of date', () => options.page.$('[data-sync-stale]'))
      await assertCallout(options, '[data-sync-stale]', 'destructive', /Sync may not work until then\.$/)
    }
    finally {
      await options.close()
    }
  }, { timeout: 30000 })

  test('a current background, or none at all, raises nothing', async () => {
    const options = await open({ 'sync.enabled': true })
    try {
      // Past the wait, so a background that never answered would have been called out of date.
      await outlast(options.page, BUILD_CHECK_TIMEOUT_MS)
      assert.equal(await options.page.$('[data-sync-stale]'), null)
    }
    finally {
      await options.close()
    }
  }, { timeout: 30000 })

  test('on a phone, the switch sits beside the title, and the description runs under both', async () => {
    const options = await open({ 'sync.enabled': true }, {}, NARROW)
    try {
      const boxes = await options.page.evaluate(() => {
        const head = document.querySelector('[data-sync-panel] [id="sync-sync-settings-across-devices"]')
        const box = (selector) => {
          const { top, bottom, left, right } = head.querySelector(selector).getBoundingClientRect()
          return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) }
        }
        return { title: box('[data-row-part="title"]'), description: box('[data-row-part="description"]'), control: box('[data-row-part="control"]') }
      })
      const layout = JSON.stringify(boxes)
      assert.ok(boxes.control.top < boxes.title.bottom && boxes.control.bottom > boxes.title.top, `the switch beside the title: ${layout}`)
      assert.ok(boxes.description.top >= Math.max(boxes.title.bottom, boxes.control.bottom) - 1, `the description under both: ${layout}`)
      assert.ok(boxes.description.right > boxes.control.left, `and across the switch's column: ${layout}`)
    }
    finally {
      await options.close()
    }
  })

  test('states stack: the chip names the most severe, and the callouts follow in severity order', async () => {
    const options = await open({
      'sync.enabled': true,
      'sync.lastError': 'QUOTA_BYTES quota exceeded',
      'sync.pause': { reason: 'newer-version', remoteVersion: NEWER },
    }, usage(94))
    try {
      assert.equal((await options.page.evaluate(readStatus)).chip.state, 'error')
      const callouts = await options.page.evaluate(readCallouts, '[data-sync-panel] [data-callout]')
      assert.deepEqual(callouts.map(c => c.severity), ['destructive', 'warning'])
    }
    finally {
      await options.close()
    }
  })

  // Dark is the theme that tells the body colour apart: there, the page's own
  // text is a shade off it.
  for (const theme of ['light', 'dark']) {
    test(`every message is in the body colour, ${theme}`, async () => {
      const options = await open({
        'option.theme': { chosen: theme, current: 'light' },
        'sync.enabled': true,
        'sync.lastError': 'QUOTA_BYTES quota exceeded',
        'sync.pause': { reason: 'newer-version', remoteVersion: NEWER },
        'sync.staleBuild': { running: 'old', onDisk: 'new' },
      })
      try {
        const callouts = await options.page.evaluate(readCallouts, '[data-callout]')
        assert.equal(callouts.length, 3, 'the error, the pause and the stale background')
        for (const callout of callouts)
          assert.equal(callout.colour, callout.body, `"${callout.message}"`)
      }
      finally {
        await options.close()
      }
    })
  }

  test('the usage bar fills in the colour of how full sync is, gains a glyph at 70%, and advises at 90%', async () => {
    const levels = [[50, 'success'], [75, 'warning'], [95, 'destructive']]
    for (const [percent, token] of levels) {
      const options = await open({ 'sync.enabled': true }, usage(percent))
      try {
        const bar = await options.page.evaluate(readUsageBar)
        assert.ok(bar, `no usage bar at ${percent}%`)
        assert.equal(bar.fill, bar.tokens[token], `${percent}% fills in ${token}`)

        const figure = await options.page.$('[data-sync-usage]')
        const text = await options.text(figure)
        if (percent >= 70)
          assert.ok(text.includes(`${WORDS[token]} ${percent}.0 KB of 100.0 KB · ${percent}%`), `the figure at ${percent}% read "${text}"`)
        assert.equal(!!(await options.page.evaluate(glyphImage, '[data-sync-usage]')), percent >= 70, `a glyph at ${percent}%`)

        const advice = await options.page.$('[data-sync-advice]')
        if (percent >= 90) {
          assert.ok(advice, `advice at ${percent}%`)
          assert.match(await options.text(advice), /^Error:\s*You're close to the sync storage limit\./)
        }
        else {
          assert.equal(advice, null, `no advice at ${percent}%`)
        }
        assert.deepEqual(await options.page.evaluate(readCallouts, '[data-sync-usage] [data-callout]'), [], 'the advice is a note under the bar, not a callout')
      }
      finally {
        await options.close()
      }
    }
  }, { timeout: 60000 })
})
