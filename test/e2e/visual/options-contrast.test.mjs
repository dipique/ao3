import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { storedLists } from '../helpers.mjs'
import { ARCHIVE, scriptBackground, skip, startOptions, stubArchive, until } from '../optionsPage.mjs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const TODAY = Math.floor(NOW / DAY)

const CATEGORIES = ['site-features-appearance', 'search', 'lists', 'reading', 'sync-backups', 'advanced']

const blurb = id => `<li class="work blurb group" id="work_${id}" role="article"><h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4></li>`
const works = (count, from) => Array.from({ length: count }, (_, i) => blurb(from + i))

const TAG = { id: 'h0rt', kind: 'tag-works', url: '/tags/Hurt%2FComfort/works', title: 'Hurt/Comfort, everything', type: 'freeform', entity: 'Hurt/Comfort' }
const TAG_KEY = 'tag-works:Hurt%2FComfort'
const TAG_COPY = { scrapedAt: NOW - 9 * DAY, blurbsHtml: works(12, 500), descriptor: { sourceId: 'tag-works', label: 'Tag: Hurt/Comfort', listUrl: `${ARCHIVE}/tags/Hurt%2FComfort/works` } }
const SERIES = { id: 's3ries', kind: 'series-works', url: '/series/77', title: 'Series: 77', type: 'series', entity: '77' }
const BROKEN = { id: 'br0ken', kind: 'tag-works', url: 'https://example.invalid/tags/Broken', title: 'Imported from another build' }

/**
 * An install with something in every place the page draws text: lists with
 * rows, a disabled rule and replacement, saved lists of every status, a job
 * stopped with works it couldn't fetch, the profile lists' tiles, a cached
 * work no list holds, sync on and backups to restore. So every destructive
 * control has something to delete, and can be armed.
 */
const SEED = {
  'option.user': { userId: 'reader' },
  'option.rules': {
    enabled: true,
    colors: {},
    filters: [
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight', color: '#7c3aed' },
      { target: 'R', value: 'Reader', matcher: 'contains' },
      { target: 'tag', value: 'Dead Dove: Do Not Eat', matcher: 'exact', behavior: 'none' },
    ],
  },
  'option.workMarks': {
    enabled: true,
    marks: {
      read: { icon: 'read', label: 'Read', color: '#6b7280', items: '1000,7', order: 0 },
      good: { icon: 'good', label: 'Good', color: '#2f8f4e', triggerAlias: 'read', items: '1000', order: 1 },
      // Over a kilobyte packed, so the frame's foot gives its figure.
      favorite: { icon: 'favorite', label: 'Favorite', color: '#c2185b', triggerAlias: 'read', items: Array.from({ length: 600 }).fill('1').join(','), order: 2 },
    },
  },
  'option.textReplacements': { enabled: true, tools: true, rules: [{ find: 'Y/N', replace: 'Alex', wholeWord: true }, { find: 'orbs', replace: 'eyes', disabled: true }] },
  'option.wordCountToolbar': { enabled: true, ranges: [{ from: null, to: 1000 }, { from: 1000, to: null }] },
  'option.searchWordCount': { enabled: true, from: 5000, to: null },
  'option.searchLanguage': { enabled: true, language: { label: 'English', value: 'en' } },
  'option.hideCrossovers': { enabled: true, maxFandoms: 5 },
  'option.trackedLists': { enabled: true, target: 40, reviewedThrough: TODAY - 9, lists: [{ ...TAG, alias: TAG.title, tracked: true, since: TODAY - 61 }, { ...BROKEN, alias: BROKEN.title, tracked: true, since: TODAY - 40 }] },
  'option.savedLists': { v: 1, lists: { [TAG.id]: TAG, [SERIES.id]: SERIES, [BROKEN.id]: BROKEN } },
  ...storedLists({
    [TAG_KEY]: TAG_COPY,
    'tracked-review': { scrapedAt: NOW - 20 * 60 * 1000, blurbsHtml: works(5, 900), descriptor: { sourceId: 'tracked-review', label: 'Tracked review', listUrl: `${ARCHIVE}/users/reader/readings#ao3e-tracked` } },
    'marked-for-later:reader': { scrapedAt: NOW - 3 * 3600_000, blurbsHtml: works(8, 700), descriptor: { sourceId: 'marked-for-later', label: 'Marked for Later — reader', listUrl: `${ARCHIVE}/users/reader/readings?show=to-read` } },
    'tag-works:Coffee%20Shop%20AU': { scrapedAt: NOW - 140 * DAY, blurbsHtml: works(3, 800) },
  }),
  'siteExportJob': {
    cacheKey: TAG_KEY,
    descriptor: TAG_COPY.descriptor,
    steps: ['caching'],
    queue: ['506', '507', '508', '509', '510', '511'],
    done: 6,
    total: 12,
    startedAt: NOW - 12 * 60_000,
    updatedAt: NOW - 2 * 60_000,
    errorCount: 2,
    errors: [{ workId: '501', title: 'Work 501', reason: 'Restricted to registered users' }, { workId: '502', title: 'Work 502', reason: 'HTTP 404' }],
  },
  'workTextIndex': { 99: { size: 120, updatedAt: 0, chapters: 1, words: 100, fetchedAt: NOW - 3 * 3600_000, v: 1 } },
  'sync.enabled': true,
  'sync.backupsEnabled': true,
  'sync.backupCount': 7,
  'sync.lastSyncAt': NOW - 42 * 60_000,
}

const REPLIES = {
  getSyncUsage: { used: 71_400, quota: 102_400, overheadBytes: 4_096 },
  listBackups: [
    { key: 'backup.1', createdAt: NOW - 4 * 3600_000, date: '2026-09-08', kind: 'daily', label: 'Today' },
    { key: 'backup.2', createdAt: NOW - 2 * DAY, date: '2026-09-06', kind: 'sync-held', label: 'Before a held sync update' },
  ],
}

const THEMES = ['light', 'dark']
const VIEWPORT = { width: 1440, height: 900 }

/** The install with nothing running: so a job can be started, one at a time. */
const IDLE = Object.fromEntries(Object.entries(SEED).filter(([key]) => key !== 'siteExportJob'))

/** How much of the element its own and its ancestors' opacity leave drawn. */
function opacityOf(handle) {
  return handle.evaluate((el) => {
    let opacity = 1
    for (let at = el; at; at = at.parentElement)
      opacity *= Number(getComputedStyle(at).opacity)
    return opacity
  })
}

/**
 * Every word the page draws reads at WCAG's AA against what is behind it, in
 * both themes, placeholders included — but for a control that is switched
 * off, which AA leaves out. That holds in a row switched off, such as a
 * disabled rule, whose glyphs and controls fade; under a job's tint, with the
 * pointer on its row or not; while a destructive control asks whether it
 * should; and in the work-mark dialog while it says why a name can't be saved.
 */
describe('options UI — text contrast', { skip }, () => {
  let session
  let release
  /** Every work page a job asks for waits on this, so the job runs for as long as a test reads it. */
  const held = new Promise((resolve) => {
    release = resolve
  })

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => {
    release()
    return session?.close()
  })

  /** The options page in `theme`, opened at `hash`, with the background's replies scripted. */
  const open = (theme, hash, { seed = SEED, prepare } = {}) => session.open({
    seed,
    theme,
    hash,
    viewport: VIEWPORT,
    prepare: async (page) => {
      await page.evaluateOnNewDocument(scriptBackground, REPLIES)
      await prepare?.(page)
    },
  })

  const jobDrawn = options => until('the saved lists and the job to be drawn', () => options.page.evaluate(() => !!document.querySelector('[data-saved-list] [data-job-state="stopped"]')))

  for (const theme of THEMES) {
    for (const category of CATEGORIES) {
      test(`${category}, ${theme}`, async () => {
        const options = await open(theme, `#${category}`)
        try {
          if (category === 'lists') {
            await jobDrawn(options)
            await options.savedListDetails(TAG.id)
          }
          if (category === 'search') {
            // A bound that can't be saved, so the row says why.
            const [lowest] = await options.controls(await options.row('filter-defaults-default-word-count'), 'textbox')
            await lowest.click({ clickCount: 3 })
            await lowest.type('-5')
            await until('the default word count to say why', async () => (await options.text(await options.row('filter-defaults-default-word-count'))).includes('whole numbers'))
          }
          if (category === 'sync-backups')
            await until('the backups to be listed', async () => (await options.listRows('backups')).length === REPLIES.listBackups.length)
          await options.calm()
          assert.deepEqual(await options.illegibleText(), [])

          if (category === 'reading') {
            const foot = await (await options.list('work-marks')).$('[data-list-foot]')
            assert.ok(foot, 'Work marks’ foot was there to be read')
            assert.match(await options.text(foot), /100 KB sync budget/, 'with its figure')

            // A field's words are its value, which is no text node, so the sweep reads past them.
            const off = await options.listRow('text-replacements', 1)
            for (const field of await options.controls(off, 'textbox')) {
              const name = await options.name(field)
              assert.equal(await opacityOf(field), 1, `the switched-off replacement's ${name} field is drawn unfaded`)
              assert.ok(await options.contrast(field) >= 4.5, `the switched-off replacement's ${name} field reads at AA`)
            }
          }
          if (category === 'lists') {
            const job = await options.savedList(TAG.id)
            await (await job.$('[data-saved-list-part="caching"]')).hover()
            assert.ok(await job.evaluate(el => el.matches(':hover')), 'the pointer is on the job’s row')
            await options.calm()
            assert.deepEqual(await options.illegibleText(), [], 'with the pointer on the job’s row')
          }
        }
        finally {
          await options.close()
        }
      })
    }

    test(`This review while its job runs, ${theme}`, async () => {
      const options = await open(theme, '#review', {
        seed: IDLE,
        prepare: page => stubArchive(page, async () => {
          await held
          return { status: 404 }
        }),
      })
      try {
        const cell = await options.page.$('[data-review-cell="this-review"]')
        await options.press(await options.control(cell, 'button', 'Cache works'))
        await until('the review’s job to run', () => cell.evaluate(el => el.querySelector('[data-job-state]')?.dataset.jobState === 'running'))
        await options.calm()
        assert.deepEqual(await options.illegibleText(), [])
      }
      finally {
        await options.close()
      }
    })

    test(`the work-mark dialog saying why a name can't be saved, ${theme}`, async () => {
      const options = await open(theme, '#marks-status')
      try {
        const dialog = await options.openDialog(await options.control(await options.list('work-marks'), 'button', 'Add mark'))
        await (await dialog.$('input[name="mark-name"]')).type('read')
        await until('the dialog to say why', async () => !!(await dialog.$('[role="alert"]')))
        await options.calm()
        assert.deepEqual(await options.illegibleText('[role="dialog"]'), [])
      }
      finally {
        await options.close()
      }
    })

    test(`each destructive control, armed, ${theme}`, async () => {
      const options = await open(theme, '#saved-lists')
      try {
        /** What reads under AA while each control asks, by the control. */
        const unread = {}
        /**
         * Arm `control` with a press of the pointer, which stays on it as a
         * reader's does, and read the page while it asks `asks`. It asks for
         * a few seconds only, so it is checked to be asking still once read.
         */
        async function arm(what, control, asks) {
          await control.evaluate(el => el.scrollIntoView({ block: 'center' }))
          await control.click()
          await until(`${what} to ask`, async () => asks.test(await options.text(control)))
          await options.calm()
          unread[what] = await options.illegibleText()
          assert.match(await options.text(control), asks, `${what} still asking once read`)
        }

        await jobDrawn(options)
        const tag = await options.savedListDetails(TAG.id)
        await arm('Remove offline copy', await options.control(tag, 'button', /^Remove offline copy/), /^Remove it\?$/)
        await arm('Remove list', await options.control(tag, 'button', /^Remove list/), /^Remove it\?$/)

        const cache = await options.row('offline-reading-cached-work-text')
        const discard = await options.control(cache, 'button', 'Discard orphans')
        await until('Discard orphans to have something to discard', () => discard.evaluate(el => !el.disabled))
        await arm('Discard orphans', discard, /^Discard [\d,]+\?$/)
        await arm('Delete cached text', await options.control(cache, 'button', 'Delete cached text'), /^Delete it all\?$/)

        const more = await options.control(await options.tile('marked-for-later'), 'button', 'More for Marked for Later')
        await more.focus()
        await options.page.keyboard.press('Enter')
        await until('the tile’s menu to open', async () => (await options.controls(options.page, 'menuitem')).length > 0)
        await arm('Remove Marked for Later’s offline copy', await options.control(options.page, 'menuitem', /^Remove offline copy/), /^Remove offline copy\?/)
        await options.page.keyboard.press('Escape')
        await until('the tile’s menu to close', async () => (await options.controls(options.page, 'menuitem')).length === 0)

        await options.goTo('#backups')
        await until('the backups to be listed', async () => (await options.listRows('backups')).length === REPLIES.listBackups.length)
        await arm('Restore', await options.control(await options.listRow('backups', 'backup.1'), 'button'), /^Restore\?$/)

        await options.goTo('#marks-status')
        await arm('Clear Read marks', await options.control(await options.listRow('work-marks', 'read'), 'button', /^Clear /), /^Clear 2\?$/)

        assert.deepEqual(unread, Object.fromEntries(Object.keys(unread).map(what => [what, []])))
      }
      finally {
        await options.close()
      }
    })
  }
})
