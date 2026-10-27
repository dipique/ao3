import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { BUILD_CHECK_TIMEOUT_MS, SYNC_CONSISTENCY_WAIT_MS } from '../../src/common/constants.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { decode, encode, MANIFEST_KEY, SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { answerRefusedMessage, HELD_BACKUP_NOTE, staleBackgroundMessage, syncRefusalMessage } from '../../src/common/syncMessages.ts'
import { SEVERITY_WORDS } from '../../src/options_ui/model/severity.ts'
import { NOT_SYNCED_YET, syncStatusView, YOURS } from '../../src/options_ui/model/syncStatus.ts'
import { numbers } from '../facts.mjs'
import { bundleForPage } from '../siteExport/helpers.mjs'
import { rulesFixture } from '../sync/harness.mjs'
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
  backupFailed: false,
  loss: { rules: { removed: 348, of: 348 }, markedWorks: { removed: 267, of: 282 }, textReplacements: { removed: 0, of: 26 }, marks: [] },
}

/** The toast where an answer that replaces this browser's settings is refused, since their backup couldn't be saved. */
const UNBACKED = answerRefusedMessage('unbacked', 'accept')

/** The toast where an answer is refused, since another browser is still sending its settings. */
const SENDING = answerRefusedMessage('sending', 'keep')

/**
 * What the sync panel says of `input`, sync on unless it says otherwise, as
 * the page words it: the page is to show it.
 */
const panelFor = input => syncStatusView({ enabled: true, staleBuild: false, backgroundOutdated: false, ...input }, V)

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

/** The status line `view`, from {@link panelFor}, has the page show. */
function statusOf(view) {
  return {
    chip: { state: view.chip.state, text: view.chip.word },
    detail: view.chip.detail ?? null,
    last: view.lastSynced ?? null,
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

/**
 * In the page, before it loads: the background's sync half, bundled as
 * `SyncBackground` (`syncBackgroundEntry.ts`), listening and answering as the
 * background does. Its engine and backups work over the page's storage mock,
 * whose `storage.sync` holds the synced copy.
 */
function routeToSyncBackground() {
  const background = window.SyncBackground
  window.browser.storage.onChanged.addListener(background.onStorageChanged)
  const send = window.browser.runtime.sendMessage
  window.browser.runtime.sendMessage = async (message) => {
    const [name] = Object.keys(message ?? {})
    const args = message?.[name] ?? []
    if (name === 'setSyncEnabled')
      return background.setSyncEnabled(...args)
    if (name === 'resolveHeldSync')
      return background.resolveHeldSync(...args)
    if (name === 'replaceSyncedCopy')
      return { replaced: await background.replaceSyncedCopy(...args) }
    return send(message)
  }
}

let syncBackgroundBundle
/** The background's sync half, bundled once for every page that runs it. */
function syncBackground() {
  syncBackgroundBundle ??= bundleForPage('test/e2e/syncBackgroundEntry.ts', 'SyncBackground')
  return syncBackgroundBundle
}

/** In the page: every backup stored, newest first, as its kind and the settings of it a test tells apart. */
async function readBackups() {
  const stored = await window.browser.storage.local.get(null)
  return Object.entries(stored)
    .filter(([key]) => key.startsWith('backup.'))
    .map(([, backup]) => backup)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(backup => ({ kind: backup.kind, wordsPerMinute: backup.options.wordsPerMinute, rules: backup.options.rules.filters.length }))
}

/** In the page: the synced copy's items, its manifest under `manifestKey`, as `storage.sync` holds them. */
async function readSyncedItems(manifestKey) {
  const stored = await window.browser.storage.sync.get(null)
  return Object.fromEntries(Object.entries(stored).filter(([key]) => key === manifestKey || /^o\d+$/.test(key)))
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

  /** How long these tests let the page wait for the background's build. */
  const BUILD_CHECK_HURRIED_MS = 1500

  /**
   * The options page at Sync, its background answering from `replies`. The
   * time the page gives the background to say which build it runs is cut to
   * what a test's own steps need: a background that never answers is a wait,
   * not a result.
   */
  const open = (seed, replies = {}, viewport = WIDE) => session.open({
    seed,
    hash: '#sync',
    viewport,
    hurry: { [BUILD_CHECK_TIMEOUT_MS]: BUILD_CHECK_HURRIED_MS },
    prepare: page => page.evaluateOnNewDocument(scriptBackground, replies),
  })

  /** The "Sync settings across devices" switch, which heads the panel: the panel's one switch. */
  const syncSwitch = async options => options.control(await options.page.$('[data-sync-panel]'), 'switch')

  /** The message `hook` marks is a callout of `severity`, led by its word, saying `message`. */
  async function assertCallout(options, hook, severity, message) {
    const [callout] = await options.page.evaluate(readCallouts, hook)
    assert.ok(callout, `nothing at ${hook}`)
    assert.equal(callout.severity, severity)
    assert.equal(callout.lead, SEVERITY_WORDS[severity])
    assert.equal(callout.message, message)
  }

  /** The panel shows the status line, and the first callout's message, that `view` (from {@link panelFor}) gives. */
  async function assertPanel(options, view, hook) {
    const status = await options.page.evaluate(readStatus)
    const expected = statusOf(view)
    assert.deepEqual(status.chip, expected.chip)
    assert.equal(status.detail, expected.detail)
    // A moment sync last succeeded is read as the page draws it.
    assert.equal(!!status.last, !!expected.last, 'when it last synced, or that it hasn\'t')
    if (expected.last === NOT_SYNCED_YET)
      assert.equal(status.last, NOT_SYNCED_YET)
    if (hook)
      await assertCallout(options, hook, view.callouts[0].severity, view.callouts[0].text)
  }

  /** What the held question's answers are called and say, as `view` (from {@link panelFor}) gives them. */
  const answersOf = view => view.callouts.find(callout => callout.decision).decision.answers.map(a => [a.choice, a.label, a.consequence])

  test('Sync & Backups has two sub-sections, Sync and Backups', async () => {
    const options = await open({})
    try {
      assert.deepEqual(await options.shownCategories(), ['sync-backups'])
      const subsections = (await options.railItems()).filter(item => item.kind === 'subsection')
      assert.deepEqual(subsections.map(s => s.id), ['sync', 'backups'])
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
      assert.equal(status.chip.state, 'syncing')
      assert.equal(status.detail, null)
      assert.ok(status.last, 'when it last synced')
      assert.deepEqual(await options.page.evaluate(readCallouts, '[data-sync-panel] [data-callout]'), [])

      const figure = await options.page.$('[data-sync-usage]')
      assert.deepEqual(numbers(await options.text(figure)), [68, 100, 68], 'used, of how much, and the share')
      assert.equal(await options.page.evaluate(glyphImage, '[data-sync-usage]'), null, 'no glyph below 70%')
    }
    finally {
      await options.close()
    }
  })

  test('before its first sync, says it hasn\'t synced yet', async () => {
    const options = await open({ 'sync.enabled': true })
    try {
      assert.equal((await options.page.evaluate(readStatus)).last, NOT_SYNCED_YET)
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

      await assertCallout(options, '[data-sync-refusal]', 'destructive', syncRefusalMessage({ ok: false, reason: 'newer-version', remoteVersion: NEWER, version: V }))
      assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'false')
      assert.deepEqual(await options.sent('setSyncEnabled'), [[true]])
      const status = await options.page.evaluate(readStatus)
      assert.equal(status.chip.state, 'off')
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
        const view = panelFor({ lastSyncAt: Date.now(), pause: HELD })
        await assertPanel(options, view, '[data-sync-pause="held"]')
        const callout = await options.page.$('[data-sync-pause="held"]')
        const losses = await callout.$$eval('[data-sync-losses] li', items => items.map(li => li.textContent.replace(/\s+/g, ' ').trim()))
        assert.deepEqual(losses.map(numbers), [[348, 348], [267, 282]], 'one line for each collection it would take from')
        assert.deepEqual(losses, view.callouts[0].decision.lines)
        assert.ok((await options.lines(callout)).includes(HELD_BACKUP_NOTE))

        const answers = await options.page.evaluate(readAnswers)
        assert.deepEqual(answers.map(a => [a.answer, a.label, a.consequence]), answersOf(view))
        assert.ok(answers[1].consequence.includes(YOURS.backedUp), 'accepting says yours are backed up')
        assert.equal(answers[0].look, answers[1].look, 'neither answer is drawn as the one to pick')
        assert.equal(answers[0].box.top, answers[1].box.top, 'side by side')
        assert.ok(answers[1].box.left > answers[0].box.right, 'side by side')
      }
      finally {
        await options.close()
      }
    })

    /**
     * With no backup of this browser's settings to point to, accepting says
     * so where the hold's backup failed. An older build held with no backup
     * where daily backups were off, which has no bearing now that accepting
     * backs up as it applies: it says only what it replaces. Today's
     * daily-backups switch says neither.
     */
    const NO_BACKUP = [
      ['its backup failed', { ...HELD, backedUp: false, backupFailed: true }, false, true],
      ['an older build held it with daily backups off', (({ backupFailed, ...older }) => ({ ...older, backedUp: false }))(HELD), true, false],
    ]
    for (const [why, pause, backupsEnabled, failed] of NO_BACKUP) {
      test(`with no backup because ${why}, accepting says what it replaces${failed ? ', and that yours aren\'t backed up' : ''}`, async () => {
        const options = await open({ 'sync.enabled': true, 'sync.backupsEnabled': backupsEnabled, 'sync.pause': pause })
        try {
          const callout = await options.page.$('[data-sync-pause="held"]')
          assert.equal((await options.lines(callout)).includes(HELD_BACKUP_NOTE), false)
          const accept = (await options.page.evaluate(readAnswers)).find(a => a.answer === 'accept')
          assert.equal(accept.consequence, answersOf(panelFor({ pause })).find(([choice]) => choice === 'accept')[2])
          assert.equal(accept.consequence.includes(YOURS.failed), failed)
          assert.equal(accept.consequence.includes(YOURS.backedUp), false)
        }
        finally {
          await options.close()
        }
      })
    }

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

    test('accepting it, refused because this browser\'s backup can\'t be saved, says so', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.pause': HELD }, { resolveHeldSync: { resolved: false, refused: 'unbacked' } })
      try {
        await options.press(await options.page.$('[data-sync-accept]'))
        await until('the refusal', async () => (await options.toasts()).includes(UNBACKED))
        assert.deepEqual(await options.sent('resolveHeldSync'), [['accept']])
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

  /**
   * Turning sync on over synced settings that differ from this browser's own
   * asks which to keep, drawn as a held update is. Here the background's sync
   * half runs in the page, so what is asserted is what it stores: this
   * browser's settings, its backups, and the synced copy.
   */
  describe('turning sync on over synced settings that differ', () => {
    /** This browser's settings, and the synced ones: rules and a reading speed apiece. */
    const OWN = { rules: rulesFixture(3), wordsPerMinute: 320 }
    const SYNCED = { rules: rulesFixture(2), wordsPerMinute: 250 }
    /** What the question asked as sync turns on says, with this browser's settings backed up. */
    const ASKED = panelFor({ pause: { reason: 'first-sync', g: 3, w: 'laptop.1', at: 0, backedUp: true, backupFailed: false, loss: null } })

    let background
    before(async () => {
      background = await syncBackground()
    }, { timeout: 60000 })

    /**
     * The options page at Sync, with sync off and daily backups off, over this
     * browser's settings and a synced copy another browser wrote; the copy's
     * manifest beside it. This browser's saved lists are past their migration,
     * as an installed build's are, so nothing changes its settings unasked.
     */
    async function openOverCopy() {
      const { chunks, manifest } = await encode({ ...structuredClone(OPTION_DEFAULTS), ...structuredClone(SYNCED) }, OPTION_DEFAULTS, 3, 'laptop.1')
      const options = await session.open({
        seed: { 'option.rules': OWN.rules, 'option.wordsPerMinute': OWN.wordsPerMinute, 'option.savedLists': { v: 1, lists: {} }, 'sync.backupsEnabled': false, [MANIFEST_KEY]: manifest, ...chunks },
        hash: '#sync',
        viewport: WIDE,
        prepare: async (page) => {
          await page.evaluateOnNewDocument(background)
          await page.evaluateOnNewDocument(routeToSyncBackground)
        },
      })
      return { options, manifest }
    }

    /** Turn sync on, and wait for the question. */
    async function turnOn(options) {
      await options.press(await syncSwitch(options))
      await options.page.waitForSelector('[data-sync-pause="first-sync"]')
    }

    test('asks which to keep, backed up first, and changes nothing until answered', async () => {
      const { options, manifest } = await openOverCopy()
      try {
        await turnOn(options)
        assert.equal((await options.stored('sync.pause')).reason, 'first-sync')
        assert.equal(await options.stored('option.wordsPerMinute'), OWN.wordsPerMinute)
        assert.deepEqual(await options.stored(MANIFEST_KEY), manifest, 'nothing sent')
        assert.deepEqual(await options.page.evaluate(readBackups), [{ kind: 'pre-sync', wordsPerMinute: 320, rules: 3 }], 'backed up with daily backups off')

        await assertPanel(options, ASKED, '[data-sync-pause="first-sync"]')
        const callout = await options.page.$('[data-sync-pause="first-sync"]')
        assert.ok((await options.lines(callout)).includes(HELD_BACKUP_NOTE))
        assert.deepEqual(await callout.$$('[data-sync-losses] li'), [])

        const answers = await options.page.evaluate(readAnswers)
        assert.deepEqual(answers.map(a => [a.answer, a.label, a.consequence]), answersOf(ASKED))
        assert.ok(answers[1].consequence.includes(YOURS.backedUp), 'using the synced settings says yours are backed up')
        assert.equal(answers[0].look, answers[1].look, 'neither answer is drawn as the one to pick')
        assert.equal(answers[0].box.top, answers[1].box.top, 'side by side')
      }
      finally {
        await options.close()
      }
    })

    test('using the synced settings replaces this browser\'s, held by the backup taken as it asked: nothing changed since, so none is taken again', async () => {
      const { options, manifest } = await openOverCopy()
      try {
        await turnOn(options)
        await options.press(await options.page.$('[data-sync-accept]'))
        await until('the answer to be applied', async () => (await options.stored('sync.pause')) === null)

        assert.equal(await options.stored('sync.enabled'), true)
        assert.equal(await options.stored('option.wordsPerMinute'), SYNCED.wordsPerMinute)
        assert.deepEqual(await options.stored('option.rules'), SYNCED.rules)
        assert.deepEqual(await options.stored(MANIFEST_KEY), manifest, 'nothing sent')
        assert.deepEqual(await options.page.evaluate(readBackups), [
          { kind: 'pre-sync', wordsPerMinute: 320, rules: 3 },
        ])
        await until('the question to go', async () => !(await options.page.$('[data-sync-pause]')))
      }
      finally {
        await options.close()
      }
    })

    /**
     * A backup due as the synced settings are used, here for an edit made
     * while it asked, that can't be saved: the first press applies nothing,
     * says so in a toast, and the question then says this browser's settings
     * aren't backed up. A second press uses them anyway.
     */
    test('using the synced settings when their backup can\'t be saved: the first press changes nothing and says so, the question that yours aren\'t backed up, and a second uses them', async () => {
      const { options, manifest } = await openOverCopy()
      try {
        await turnOn(options)
        await options.page.evaluate(() => window.browser.storage.local.set({ 'option.wordsPerMinute': 330 }))
        await until('the edit to be in', async () => (await options.stored('option.wordsPerMinute')) === 330)
        await options.page.evaluate(() => {
          const local = window.browser.storage.local
          const set = local.set
          local.set = items => Object.keys(items).some(key => key.startsWith('backup.'))
            ? Promise.reject(new Error('storage.local could not be written'))
            : set(items)
        })

        await options.press(await options.page.$('[data-sync-accept]'))
        await until('the refusal', async () => (await options.toasts()).includes(UNBACKED))
        assert.equal((await options.stored('sync.pause'))?.backupFailed, true)
        assert.equal((await options.stored('sync.pause')).backedUp, false)
        assert.equal(await options.stored('option.wordsPerMinute'), 330, 'nothing applied')
        await until('the answer to say so', async () => (await options.page.evaluate(readAnswers)).find(a => a.answer === 'accept')?.consequence.includes(YOURS.failed))
        assert.ok(!(await options.lines(await options.page.$('[data-sync-pause="first-sync"]'))).includes(HELD_BACKUP_NOTE))

        await options.press(await options.page.$('[data-sync-accept]'))
        await until('the answer to be applied', async () => (await options.stored('sync.pause')) === null)
        assert.equal(await options.stored('option.wordsPerMinute'), SYNCED.wordsPerMinute)
        assert.deepEqual(await options.stored('option.rules'), SYNCED.rules)
        assert.deepEqual(await options.stored(MANIFEST_KEY), manifest, 'nothing sent')
        assert.deepEqual(await options.page.evaluate(readBackups), [{ kind: 'pre-sync', wordsPerMinute: 320, rules: 3 }])
      }
      finally {
        await options.close()
      }
    })

    test('keeping this browser\'s replaces the synced settings, kept as a backup first', async () => {
      const { options, manifest } = await openOverCopy()
      try {
        await turnOn(options)
        await options.press(await options.page.$('[data-sync-keep]'))
        await until('the answer to be applied', async () => (await options.stored('sync.pause')) === null)

        assert.equal(await options.stored('option.wordsPerMinute'), OWN.wordsPerMinute)
        assert.notEqual((await options.stored(MANIFEST_KEY)).w, manifest.w, 'this browser\'s settings were sent')
        const synced = await decode(await options.page.evaluate(readSyncedItems, MANIFEST_KEY))
        assert.equal(synced.ok, true)
        assert.equal(synced.options.wordsPerMinute, OWN.wordsPerMinute)
        assert.deepEqual(synced.options.rules, OWN.rules)
        assert.deepEqual(await options.page.evaluate(readBackups), [
          { kind: 'sync-declined', wordsPerMinute: 250, rules: 2 },
          { kind: 'pre-sync', wordsPerMinute: 320, rules: 3 },
        ])
        await until('the question to go', async () => !(await options.page.$('[data-sync-pause]')))
      }
      finally {
        await options.close()
      }
    })

    test('turning sync off before answering changes nothing', async () => {
      const { options, manifest } = await openOverCopy()
      try {
        await turnOn(options)
        await options.press(await syncSwitch(options))
        await until('sync to be off with nothing asked', async () => (await options.stored('sync.enabled')) === false && (await options.stored('sync.pause')) === null)

        assert.equal(await options.stored('option.wordsPerMinute'), OWN.wordsPerMinute)
        assert.deepEqual(await options.stored(MANIFEST_KEY), manifest)
        assert.deepEqual((await options.page.evaluate(readBackups)).map(backup => backup.kind), ['pre-sync'])
        await until('the question to go', async () => !(await options.page.$('[data-sync-pause]')))
      }
      finally {
        await options.close()
      }
    })
  })

  /**
   * A synced copy under another ID, one another browser started, arriving
   * while sync is on: asked about as turning sync on asks, through the
   * background's own sync half in the page.
   */
  describe('a synced copy another browser started, arriving while sync is on', () => {
    const OWN = { rules: rulesFixture(3), wordsPerMinute: 320 }
    const THEIRS = { rules: rulesFixture(2), wordsPerMinute: 250 }
    const withSettings = update => ({ ...structuredClone(OPTION_DEFAULTS), ...structuredClone(update) })

    test('is asked about, backed up first, and keeping this browser\'s settings sends them under its ID', async () => {
      const own = await encode(withSettings(OWN), OPTION_DEFAULTS, 3, 'desktop.1', V, 'desktop-copy')
      const theirs = await encode(withSettings(THEIRS), OPTION_DEFAULTS, 4, 'laptop.1', V, 'laptop-copy')
      const background = await syncBackground()
      const options = await session.open({
        seed: {
          'option.rules': OWN.rules,
          'option.wordsPerMinute': OWN.wordsPerMinute,
          'option.savedLists': { v: 1, lists: {} },
          'sync.enabled': true,
          'sync.backupsEnabled': false,
          'sync.meta': { g: 3, h: own.manifest.h, w: own.manifest.w, i: 'desktop-copy' },
          [MANIFEST_KEY]: own.manifest,
          ...own.chunks,
        },
        hash: '#sync',
        viewport: WIDE,
        prepare: async (page) => {
          await page.evaluateOnNewDocument(background)
          await page.evaluateOnNewDocument(routeToSyncBackground)
        },
      })
      try {
        await options.page.evaluate(items => window.browser.storage.sync.set(items), { ...theirs.chunks, [MANIFEST_KEY]: theirs.manifest })
        await options.page.waitForSelector('[data-sync-pause="first-sync"]')

        const pause = await options.stored('sync.pause')
        assert.deepEqual([pause.reason, pause.otherCopy, pause.g, pause.w], ['first-sync', true, 4, 'laptop.1'])
        assert.equal(await options.stored('option.wordsPerMinute'), OWN.wordsPerMinute, 'nothing replaced')
        assert.deepEqual(await options.page.evaluate(readBackups), [{ kind: 'sync-held', wordsPerMinute: 320, rules: 3 }], 'backed up with daily backups off')

        const status = await options.page.evaluate(readStatus)
        const view = panelFor({ pause })
        assert.deepEqual([status.chip, status.detail], [statusOf(view).chip, statusOf(view).detail], 'the chip says the settings came from another browser')
        await assertCallout(options, '[data-sync-pause="first-sync"]', 'warning', view.callouts[0].text)

        await options.press(await options.page.$('[data-sync-keep]'))
        await until('the answer to be applied', async () => (await options.stored('sync.pause')) === null)
        const sent = await options.stored(MANIFEST_KEY)
        assert.equal(sent.i, 'laptop-copy', 'under the copy\'s ID')
        assert.notEqual(sent.w, theirs.manifest.w, 'this browser\'s settings were sent')
        const synced = await decode(await options.page.evaluate(readSyncedItems, MANIFEST_KEY))
        assert.equal(synced.options.wordsPerMinute, OWN.wordsPerMinute)
        assert.deepEqual(synced.options.rules, OWN.rules)
        assert.equal((await options.stored('sync.meta')).i, 'laptop-copy', 'agreed on')
        assert.deepEqual(await options.page.evaluate(readBackups), [
          { kind: 'sync-declined', wordsPerMinute: 250, rules: 2 },
          { kind: 'sync-held', wordsPerMinute: 320, rules: 3 },
        ])
      }
      finally {
        await options.close()
      }
    })
  })

  /**
   * A synced copy that can't be read whole: within the wait another browser
   * is taken to be still sending it, and keeping this browser's settings, which
   * backs the synced ones up first, is refused; past the wait the panel says
   * the synced settings are inconsistent and offers to replace them.
   */
  describe('synced settings that can\'t be read whole', () => {
    const OWN = { rules: rulesFixture(3), wordsPerMinute: 320 }
    const THEIRS = { rules: rulesFixture(2), wordsPerMinute: 250 }
    const withSettings = update => ({ ...structuredClone(OPTION_DEFAULTS), ...structuredClone(update) })
    /** The upload `openOverPartial` leaves partial: its manifest's generation and writer token. */
    const PARTIAL_UPLOAD = { g: 4, w: 'laptop.1' }
    /** Past the wait on that upload, with this browser's own settings able to stand in. */
    const overdue = () => ({ since: Date.now() - SYNC_CONSISTENCY_WAIT_MS, overdue: true, replaceable: true, upload: PARTIAL_UPLOAD })

    /**
     * The options page at Sync, sync on over `seed`, with the background's sync
     * half in the page. The synced store holds the manifest of another
     * browser's upload, with the part of this browser's own copy it was
     * written over: it can't be read whole.
     */
    async function openOverPartial(seed) {
      const own = await encode(withSettings(OWN), OPTION_DEFAULTS, 3, 'desktop.1', V, 'desktop-copy')
      const theirs = await encode(withSettings(THEIRS), OPTION_DEFAULTS, PARTIAL_UPLOAD.g, PARTIAL_UPLOAD.w, V, 'laptop-copy')
      const background = await syncBackground()
      const options = await session.open({
        seed: {
          'option.rules': OWN.rules,
          'option.wordsPerMinute': OWN.wordsPerMinute,
          'option.savedLists': { v: 1, lists: {} },
          'sync.enabled': true,
          'sync.backupsEnabled': false,
          'sync.meta': { g: 3, h: own.manifest.h, w: own.manifest.w, i: 'desktop-copy' },
          [MANIFEST_KEY]: theirs.manifest,
          ...own.chunks,
          ...seed,
        },
        hash: '#sync',
        viewport: WIDE,
        prepare: async (page) => {
          await page.evaluateOnNewDocument(background)
          await page.evaluateOnNewDocument(routeToSyncBackground)
        },
      })
      return { options, partial: theirs.manifest }
    }

    test('past the wait: says they are inconsistent, and offers to replace them with this browser\'s settings', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.lastSyncAt': Date.now(), 'sync.inconsistent': overdue() }, { replaceSyncedCopy: { replaced: true } })
      try {
        const view = panelFor({ lastSyncAt: Date.now(), inconsistent: overdue() })
        await assertPanel(options, view, '[data-sync-inconsistent]')

        const answers = await options.page.evaluate(readAnswers)
        assert.deepEqual(answers.map(a => [a.answer, a.label, a.consequence]), answersOf(view))
        assert.deepEqual(answers.map(a => a.answer), ['replace'])
        await options.press(await options.page.$('[data-sync-replace]'))
        await until('the offer to be taken', async () => (await options.sent('replaceSyncedCopy')).length === 1)
      }
      finally {
        await options.close()
      }
    })

    for (const theme of ['light', 'dark']) {
      test(`its callout and offer read at AA, ${theme}`, async () => {
        const options = await open({ 'option.theme': { chosen: theme, current: theme }, 'sync.enabled': true, 'sync.inconsistent': overdue() })
        try {
          await options.page.waitForSelector('[data-sync-replace]')
          await options.calm()
          assert.deepEqual(await options.illegibleText('[data-sync-panel]'), [])
        }
        finally {
          await options.close()
        }
      })
    }

    test('on a phone, the offer\'s label stays inside its button', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.inconsistent': overdue() }, {}, NARROW)
      try {
        await options.page.waitForSelector('[data-sync-replace]')
        const { label, inside } = await options.page.evaluate(() => {
          const button = document.querySelector('[data-sync-replace]')
          const style = getComputedStyle(button)
          const box = button.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(button)
          const text = range.getBoundingClientRect()
          const inset = side => Number.parseFloat(style[`border${side}Width`]) + Number.parseFloat(style[`padding${side}`])
          const inside = { left: Math.round(box.left + inset('Left')), right: Math.round(box.right - inset('Right')), top: Math.round(box.top), bottom: Math.round(box.bottom) }
          return { label: { left: Math.round(text.left), right: Math.round(text.right), top: Math.round(text.top), bottom: Math.round(text.bottom) }, inside }
        })
        const layout = JSON.stringify({ label, inside })
        assert.ok(label.left >= inside.left && label.right <= inside.right, `the label within the button's padding: ${layout}`)
        assert.ok(label.top >= inside.top && label.bottom <= inside.bottom, `and within its height: ${layout}`)
      }
      finally {
        await options.close()
      }
    })

    test('within the wait, says nothing of it', async () => {
      const options = await open({ 'sync.enabled': true, 'sync.lastSyncAt': Date.now(), 'sync.inconsistent': { since: Date.now(), overdue: false, replaceable: false } })
      try {
        assert.equal((await options.page.evaluate(readStatus)).chip.state, 'syncing')
        assert.equal(await options.page.$('[data-sync-inconsistent]'), null)
      }
      finally {
        await options.close()
      }
    })

    test('the offer sends this browser\'s settings as the synced copy, under a new ID', async () => {
      const { options, partial } = await openOverPartial({ 'sync.inconsistent': overdue() })
      try {
        await options.press(await options.page.$('[data-sync-replace]'))
        await until('the synced copy to be replaced', async () => (await options.stored(MANIFEST_KEY)).w !== partial.w)

        const sent = await options.stored(MANIFEST_KEY)
        assert.equal(typeof sent.i, 'string')
        assert.ok(!['laptop-copy', 'desktop-copy'].includes(sent.i), `a new ID, not ${sent.i}`)
        assert.ok(sent.g > partial.g, 'past the copy it replaces')
        const synced = await decode(await options.page.evaluate(readSyncedItems, MANIFEST_KEY))
        assert.equal(synced.ok, true, 'whole again')
        assert.equal(synced.options.wordsPerMinute, OWN.wordsPerMinute)
        assert.deepEqual(synced.options.rules, OWN.rules)
        assert.equal((await options.stored('sync.meta')).i, sent.i, 'agreed on')
        assert.equal(await options.stored('sync.inconsistent'), null)
        assert.equal(await options.stored('option.wordsPerMinute'), OWN.wordsPerMinute, 'this browser\'s settings untouched')
        await until('the callout to go', async () => !(await options.page.$('[data-sync-inconsistent]')))
      }
      finally {
        await options.close()
      }
    })

    test('keeping this browser\'s settings over it is refused, saying another browser is still sending its settings', async () => {
      const question = { reason: 'first-sync', g: 3, w: 'laptop.0', at: Date.now(), backedUp: true, backupFailed: false, loss: null }
      const { options, partial } = await openOverPartial({ 'sync.meta': { g: 0, h: '', w: '', i: 'desktop-copy' }, 'sync.pause': question })
      try {
        await options.press(await options.page.$('[data-sync-keep]'))
        await until('the refusal', async () => (await options.toasts()).includes(SENDING))

        assert.deepEqual(await options.stored('sync.pause'), question, 'nothing cleared')
        assert.deepEqual(await options.stored(MANIFEST_KEY), partial, 'nothing sent')
        assert.deepEqual(await options.page.evaluate(readBackups), [], 'nothing backed up')
        const record = await options.stored('sync.inconsistent')
        assert.deepEqual([record?.overdue, typeof record?.since], [false, 'number'], 'waited on from now')
        assert.equal(await options.page.$('[data-sync-inconsistent]'), null)
      }
      finally {
        await options.close()
      }
    })

    test('using the synced settings over it is refused too, saying another browser is still sending its settings', async () => {
      const question = { reason: 'first-sync', g: 3, w: 'laptop.0', at: Date.now(), backedUp: true, backupFailed: false, loss: null }
      const { options, partial } = await openOverPartial({ 'sync.meta': { g: 0, h: '', w: '', i: 'desktop-copy' }, 'sync.pause': question })
      try {
        await options.press(await options.page.$('[data-sync-accept]'))
        await until('the refusal', async () => (await options.toasts()).includes(SENDING))

        assert.deepEqual(await options.stored('sync.pause'), question, 'nothing cleared')
        assert.equal(await options.stored('option.wordsPerMinute'), OWN.wordsPerMinute, 'nothing applied')
        assert.deepEqual(await options.stored(MANIFEST_KEY), partial, 'nothing sent')
        assert.deepEqual(await options.page.evaluate(readBackups), [], 'nothing backed up')
        assert.ok(await options.page.$('[data-sync-pause="first-sync"]'), 'still asked')
      }
      finally {
        await options.close()
      }
    })
  })

  test('a version pause explains itself without offering answers', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.pause': { reason: 'newer-version', remoteVersion: NEWER } })
    try {
      await assertPanel(options, panelFor({ pause: { reason: 'newer-version', remoteVersion: NEWER } }), '[data-sync-pause="newer-version"]')
      const [callout] = await options.page.evaluate(readCallouts, '[data-sync-pause="newer-version"]')
      assert.ok(numbers(callout.message).includes(NEWER) && numbers(callout.message).includes(V), 'it gives both sync versions')
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
      await assertPanel(options, panelFor({ pause: { reason: 'older-cloud', remoteVersion: OLDER } }), '[data-sync-pause="older-cloud"]')
      const [callout] = await options.page.evaluate(readCallouts, '[data-sync-pause="older-cloud"]')
      assert.ok(numbers(callout.message).includes(OLDER) && numbers(callout.message).includes(V), 'it gives both sync versions')
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
      await assertCallout(options, '[data-sync-error]', 'destructive', 'QUOTA_BYTES quota exceeded')
      await assertPanel(options, panelFor({ lastSyncAt: Date.now(), lastError: 'QUOTA_BYTES quota exceeded' }))
      assert.equal((await options.page.evaluate(readStatus)).last, null)
    }
    finally {
      await options.close()
    }
  })

  test('a background that found itself out of date says sync is paused', async () => {
    const options = await open({ 'sync.enabled': true, 'sync.staleBuild': { running: 'old', onDisk: 'new' } })
    try {
      await assertCallout(options, '[data-sync-stale]', 'destructive', staleBackgroundMessage(true))
      assert.equal((await options.page.evaluate(readStatus)).chip.state, 'stale')
    }
    finally {
      await options.close()
    }
  })

  test('a background answering with another build is called out of date', async () => {
    const options = await open({ 'sync.enabled': true }, { getBuildInfo: { buildId: 'some-other-build', syncVersion: V } })
    try {
      await assertCallout(options, '[data-sync-stale]', 'destructive', staleBackgroundMessage(false))
    }
    finally {
      await options.close()
    }
  })

  test('a background that never answers is called out of date once the wait runs out', async () => {
    const options = await open({ 'sync.enabled': true }, { getBuildInfo: 'never' })
    try {
      // What shows before the wait is up can only be read off a page that
      // opened inside it: on a busy machine the wait can run out while the page
      // is still opening. The wait starts after the page does, so a page open
      // for less than the wait can't have seen it run out.
      const early = await options.page.evaluate(() => ({ stale: !!document.querySelector('[data-sync-stale]'), openFor: performance.now() }))
      if (early.openFor < BUILD_CHECK_HURRIED_MS)
        assert.equal(early.stale, false, 'not before the wait is up')
      await until('the background to be called out of date', () => options.page.$('[data-sync-stale]'))
      await assertCallout(options, '[data-sync-stale]', 'destructive', staleBackgroundMessage(false))
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
        assert.deepEqual(numbers(text), [percent, 100, percent], `the figure at ${percent}% read "${text}"`)
        assert.equal(text.includes(SEVERITY_WORDS[token]), percent >= 70, `the glyph's word at ${percent}%`)
        assert.equal(!!(await options.page.evaluate(glyphImage, '[data-sync-usage]')), percent >= 70, `a glyph at ${percent}%`)

        const advice = await options.page.$('[data-sync-advice]')
        if (percent >= 90) {
          assert.ok(advice, `advice at ${percent}%`)
          const said = await options.text(advice)
          assert.ok(said.startsWith(SEVERITY_WORDS.destructive) && said.length > SEVERITY_WORDS.destructive.length, `led by the glyph's word: "${said}"`)
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
