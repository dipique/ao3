import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { storedLists } from './helpers.mjs'
import { scriptBackground, skip, startOptions, until } from './optionsPage.mjs'

const ARCHIVE = 'https://archiveofourown.org'
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
 * stopped with works it couldn't fetch, the profile lists' tiles, sync on and
 * backups to restore.
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
  'option.workMarks': { enabled: true, marks: { read: { icon: 'read', label: 'Read', color: '#6b7280', items: '1000,7', order: 0 }, good: { icon: 'good', label: 'Good', color: '#2f8f4e', triggerAlias: 'read', items: '1000', order: 1 } } },
  'option.textReplacements': { enabled: true, tools: true, rules: [{ find: 'Y/N', replace: 'Alex', wholeWord: true }, { find: 'orbs', replace: 'eyes', disabled: true }] },
  'option.wordCountToolbar': { enabled: true, ranges: [{ from: null, to: 1000 }, { from: 1000, to: null }] },
  'option.searchWordCount': { enabled: true, from: 5000, to: null },
  'option.searchLanguage': { enabled: true, language: { label: 'English', value: 'en' } },
  'option.hideCrossovers': { enabled: true, maxFandoms: 5 },
  'option.hideLanguages': { enabled: true, show: [{ label: 'English', value: 'en' }], applyToSearch: true },
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

/**
 * Drawn under AA on purpose: a row switched off, such as a disabled rule, fades
 * so it stands back from the rows that act; and a saved list whose job runs
 * wears the brand's tint, which takes its quieter words a shade under.
 */
const DRAWN_SO = '.list-row--off, .saved-list--job'

/**
 * Every word the page draws reads at WCAG's AA against what is behind it, in
 * both themes, placeholders included — but for a control that is switched
 * off, which AA leaves out.
 */
describe('options UI — text contrast', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const theme of ['light', 'dark']) {
    for (const category of CATEGORIES) {
      test(`${category}, ${theme}`, async () => {
        const options = await session.open({
          seed: SEED,
          theme,
          hash: `#${category}`,
          viewport: { width: 1440, height: 900 },
          prepare: page => page.evaluateOnNewDocument(scriptBackground, REPLIES),
        })
        try {
          if (category === 'lists') {
            await until('the saved lists and the job to be drawn', () => options.page.evaluate(() => !!document.querySelector('[data-saved-list] [data-job-state="stopped"]')))
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
          assert.deepEqual(await options.illegibleText('body', DRAWN_SO), [])
          if (category === 'lists') {
            const failures = await options.control(await options.savedList(TAG.id), 'button', /works could not be fetched/)
            assert.ok(await options.contrast(failures) >= 4.5, 'the job line’s failures read at AA')
          }
        }
        finally {
          await options.close()
        }
      })
    }
  }
})
