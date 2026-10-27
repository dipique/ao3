import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { describeFilters, formatDay, TRACKED_TYPE_LABELS, utcToday } from '../../src/common/trackedLists.ts'
import { formatBytes } from '../../src/options_ui/model/buckets.ts'
import { CONFIRM_MS } from '../../src/options_ui/model/confirmInPlace.ts'
import { timeAgo } from '../../src/options_ui/model/moments.ts'
import { COPIED_MS, KIND_LABELS, LIST_REMOVAL, NOT_ARCHIVE_STOP_NOTE, TRACK_OFF } from '../../src/options_ui/model/savedListRows.ts'
import { storedLists } from './helpers.mjs'
import { figures, mentions, skip, startOptions, until } from './optionsPage.mjs'

const ARCHIVE = 'https://archiveofourown.org'
const TODAY = utcToday()
const HOUR = 60 * 60 * 1000

/** The saved lists' frame under Lists → Saved lists. */
const LIST = 'saved-lists'

/** A saved list's record, as the background files it for a tracked entry: its id, query and title. */
function recordOf({ id, kind, url, alias, type, entity, filter }) {
  return Object.fromEntries(Object.entries({ id, kind, url, title: alias, type, entity, filter }).filter(([, value]) => value !== undefined))
}

/** The two options as the background leaves them: the tracked entries, and every saved list's record. */
function listsSeed(entries, saved, extra = {}) {
  return {
    'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: entries, ...extra },
    'option.savedLists': { v: 1, lists: Object.fromEntries(saved.map(record => [record.id, record])) },
  }
}

/** Tracked and titled. */
const COFFEE = { id: 'c0ffee', kind: 'text-search', url: '/works/search?work_search%5Bquery%5D=coffee', alias: 'Coffee shop AUs', tracked: true, since: TODAY - 5 }
/** Saved, under its default title. */
const SERIES = { id: 'ser1es', kind: 'series-works', url: '/series/9991', title: 'Series: 9991' }
/** Saved and titled, with a copy of its search stored in two sort orders. */
const LATTE_ART = { id: 'l4tte', kind: 'text-search', url: '/works/search?work_search[query]=latte', title: 'Latte art', type: 'search', entity: 'latte' }
/** The record the background makes for a stored search nothing tracks: under the search's default title. */
const TEA = { id: 't3a', kind: 'text-search', url: '/works/search?work_search[query]=tea', title: 'Search: tea', type: 'search', entity: 'tea' }

const TEA_KEY = 'text-search:work_search%5Bquery%5D=tea'
const LATTE_KEYS = ['text-search:work_search%5Bquery%5D=latte', 'text-search:work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count']
/** A stored search the background hasn't given a record yet: a row of its own, by the title its record will take. */
const MARRIAGE_KEY = 'tag-works:marriage%20problems'

/** Enough of a blurb for a stored list to have a work in it. */
const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

/** A stored list read `hours` ago, from `listUrl`. */
const storedCopy = (sourceId, label, hours, listUrl, id) => ({
  version: 2,
  scrapedAt: Date.now() - hours * HOUR,
  blurbsHtml: [blurb(id)],
  descriptor: { sourceId, label, listUrl },
})
const searchCopy = (query, hours, listUrl, id) => storedCopy('text-search', `Works search — ${query}`, hours, listUrl, id)

const SEED = {
  ...listsSeed([COFFEE], [recordOf(COFFEE), SERIES, LATTE_ART, TEA], { reviewedThrough: TODAY - 9 }),
  ...storedLists({
    [TEA_KEY]: searchCopy('tea', 3, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`, 101),
    [LATTE_KEYS[0]]: searchCopy('latte', 5, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte`, 104),
    [LATTE_KEYS[1]]: searchCopy('latte', 4, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count`, 105),
    [MARRIAGE_KEY]: storedCopy('tag-works', 'Uncommon tag — marriage problems', 2, `${ARCHIVE}/tags/marriage%20problems`, 106),
  }),
}

/** Copy URL's clipboard, stood in for so a test can read what was put on it: `window.__copied`. */
function standInForClipboard() {
  window.__copied = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text) => {
        window.__copied.push(text)
        return Promise.resolve()
      },
    },
  })
}

/** Whether a switch is on. */
const isOn = handle => handle.evaluate(s => s.getAttribute('aria-checked') === 'true')

/** Whether a Remove is armed: pressed once, and asking to be pressed again. */
const armed = handle => handle.evaluate(el => el.dataset.armed === 'true')

/** What one part of a saved list's row says (`list`, `status`, `caching`, `actions`, `details`), its lines joined. */
// eslint-disable-next-line unicorn/prefer-dom-node-text-content
const part = (row, name) => row.$eval(`[data-saved-list-part="${name}"]`, el => el.innerText.replace(/\s+/g, ' ').trim())

/** How a saved list's row stands: tracked or saved, and what it is waiting on the reader for, if anything. */
const standing = row => row.$eval('[data-saved-list-part="status"]', el => ({ status: el.dataset.savedListStatus, pending: el.dataset.savedListPending ?? null }))

/** What a saved list's row has of its offline copy: `copy`, or `none`. */
const cached = row => row.$eval('[data-saved-list-part="caching"]', el => el.dataset.savedListCaching)

/** A copy of one work, none of it cached, as {@link cachedFigures} gives it. */
const ONE_WORK = [0, 1]
/** What a row's Caching cell counts of its copy: how many works are cached, and of how many. */
const cachedFigures = async row => figures(await row.$eval('[data-saved-list-caching-line]', el => el.textContent), formatBytes(0))

/** A copy's age, as a row says it: `hours` old. */
const aged = hours => timeAgo(Date.now() - hours * HOUR, Date.now())

/** What a row's details say of what removing does: `remove-copy` or `remove-list`. */
const removalNote = (row, what) => row.$eval(`[data-saved-list-note="${what}"]`, el => el.textContent)

/**
 * Lists → Saved lists: one row per saved list, tracked or not, and per stored
 * list no saved list is at yet. Its title is set, its tracking started and
 * stopped, and the list removed here, every one an options write: a title on a
 * list that isn't tracked is this browser's record alone, and only tracking
 * writes the entry that syncs. Nothing here reaches the archive.
 */
describe('options UI — saved lists', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: '#saved-lists', viewport: { width: 1440, height: 900 }, prepare: page => page.evaluateOnNewDocument(standInForClipboard) })
  }, { timeout: 180000 })

  after(() => session?.close())

  const writtenEntries = () => options.lastWrite('option.trackedLists')
  const writtenRecords = () => options.lastWrite('option.savedLists')
  const titleField = async id => options.control(await options.savedList(id), 'textbox')
  /** Press the control that does `action` on one row, opening the row's details first. */
  const pressInDetails = async (id, action) => options.press(await options.action(await options.savedListDetails(id), action))

  /**
   * Write something that has nothing to do with the lists, and wait for it:
   * the page saves every change waiting to be saved together, so anything a
   * test expects not to have been written by now would have been.
   */
  async function flush() {
    const prune = await options.control(await options.row('offline-reading-discard-unneeded-blurbs-automatically'), 'switch')
    const was = await options.lastWrite('option.pruneOrphanedBlurbs')
    await options.press(prune)
    await until('the other setting to be written', async () => await options.lastWrite('option.pruneOrphanedBlurbs') !== was)
  }

  test('every saved list is a row, by name, with what it is, its status and its offline copy', async () => {
    await until('the copies to be read', async () => JSON.stringify(await cachedFigures(await options.savedList('t3a'))) === JSON.stringify(ONE_WORK))
    assert.deepEqual(await options.savedListIds(), ['c0ffee', 'l4tte', 't3a', 'ser1es', `copy:${MARRIAGE_KEY}`])
    assert.deepEqual(figures(await options.listCount(LIST)), [1, 3, 5], '5 lists, 1 tracked, 3 cached')

    const coffee = await options.savedList('c0ffee')
    assert.equal(await (await titleField('c0ffee')).evaluate(el => el.value), 'Coffee shop AUs')
    assert.ok(mentions(await part(coffee, 'list'), KIND_LABELS['text-search']))
    assert.deepEqual(await standing(coffee), { status: 'tracked', pending: null })
    assert.ok(mentions(await part(coffee, 'status'), formatDay(TODAY - 5)), 'since the day it was tracked from')
    assert.equal(await isOn(await options.control(coffee, 'switch')), true)
    assert.equal(await cached(coffee), 'none')
    assert.equal(
      await (await options.action(coffee, 'open')).evaluate(a => a.getAttribute('href')),
      `${ARCHIVE}/works/search?work_search[query]=coffee#ao3e-open=c0ffee`,
      'its open URL, which keeps a copy as it opens',
    )
    assert.deepEqual(await options.actions(coffee, 'download'), [], 'nothing to download with no copy')

    const series = await options.savedList('ser1es')
    assert.deepEqual(await standing(series), { status: 'saved', pending: null })
    assert.equal(await isOn(await options.control(series, 'switch')), false)

    const tea = await options.savedList('t3a')
    assert.equal(await cached(tea), 'copy')
    assert.ok(mentions(await part(tea, 'caching'), aged(3)), await part(tea, 'caching'))
    assert.ok(await options.action(tea, 'download'))
    // Two sort orders of one search are copies of one list: the newest is its own.
    const latte = await part(await options.savedList('l4tte'), 'caching')
    assert.ok(mentions(latte, aged(4)) && !mentions(latte, aged(5)), latte)

    const marriage = await options.savedList(`copy:${MARRIAGE_KEY}`)
    assert.deepEqual(await options.controls(marriage, 'textbox'), [], 'with no record yet, it has no title to set')
    const what = await part(marriage, 'list')
    assert.ok(what.startsWith('Tag: marriage problems'), what)
    assert.ok(mentions(what, KIND_LABELS['tag-works']), what)
  })

  test('each list\'s View/Edit opens its own page on AO3, marked as being refined by its id, tracked or not', async () => {
    const link = async id => (await options.action(await options.savedList(id), 'view-edit')).evaluate(a => a.getAttribute('href'))
    assert.equal(await link('c0ffee'), `${ARCHIVE}/works/search?work_search[query]=coffee#ao3e-list=c0ffee`)
    assert.equal(await link('l4tte'), `${ARCHIVE}/works/search?work_search[query]=latte#ao3e-list=l4tte`)
    assert.equal(await link('t3a'), `${ARCHIVE}/works/search?work_search[query]=tea#ao3e-list=t3a`)
    assert.equal(await link('ser1es'), `${ARCHIVE}/series/9991#ao3e-list=ser1es`)
  })

  test('Copy URL puts the list\'s open URL on the clipboard, its own page on AO3 naming it by its id, and says so for a moment', async () => {
    const copy = await options.action(await options.savedList('l4tte'), 'copy-url')
    const copied = () => copy.evaluate(el => el.dataset.copied === 'true')
    await options.press(copy)
    await until('the copy to be said', copied)
    assert.deepEqual(await options.page.evaluate(() => window.__copied), [`${ARCHIVE}/works/search?work_search[query]=latte#ao3e-open=l4tte`])
    assert.ok(await copy.$('.i-tabler-check'), 'its glyph is a check')
    await until('the button to read Copy URL again', async () => !await copied(), COPIED_MS * 5)
  })

  test('the watermark reads as a date, not a number', async () => {
    const cell = await options.page.$('[data-review-cell="reviewed-through"]')
    assert.ok(mentions(await options.text(cell), formatDay(TODAY - 9)))
  })

  test('a title is saved as its field is left: a saved list\'s on its record alone, which never syncs', async () => {
    const input = await titleField('l4tte')
    await input.click({ clickCount: 3 })
    await input.type('Latte love ')
    await flush()
    assert.equal(await writtenRecords(), null, 'nothing is saved while it is being typed')

    await input.evaluate(el => el.blur())
    await until('the title to be written', async () => (await writtenRecords())?.lists.l4tte?.title === 'Latte love')
    assert.deepEqual((await writtenRecords()).lists.l4tte, { ...LATTE_ART, title: 'Latte love' }, 'the same list, retitled, trimmed')
    assert.equal(await writtenEntries(), null, 'nothing that syncs was written')
    assert.equal(await input.evaluate(el => el.value), 'Latte love')
  })

  test('Enter saves a tracked list\'s title, on its record and on its entry', async () => {
    const input = await titleField('c0ffee')
    await input.click({ clickCount: 3 })
    await input.type('Caffeine')
    await input.press('Enter')
    await until('the title to be written', async () => (await writtenEntries())?.lists[0]?.alias === 'Caffeine')

    assert.equal((await writtenEntries()).lists[0].url, COFFEE.url, 'the entry is the same one, retitled')
    assert.equal((await writtenRecords()).lists.c0ffee.title, 'Caffeine')
    await input.evaluate(el => el.blur())
    await until('the row to answer to its title', async () => mentions(await options.name(await options.control(await options.savedList('c0ffee'), 'switch')), 'Caffeine'))
  })

  test('a retitled list\'s anchor follows its new title, there and then', async () => {
    try {
      await options.goTo('#offline-reading')
      await options.goTo('#saved-lists-caffeine')
      assert.deepEqual(await options.shownCategories(), ['lists'])
      const row = await options.page.evaluate(() => {
        const el = document.getElementById('saved-lists-caffeine')
        const { top, bottom } = el?.getBoundingClientRect() ?? {}
        return el && { id: el.dataset.savedList, inView: top >= 0 && bottom <= window.innerHeight }
      })
      assert.deepEqual(row, { id: 'c0ffee', inView: true }, 'it lands on the row')
    }
    finally {
      // Back where the tests after it work, whatever this one found.
      await options.goTo('#saved-lists')
    }
  })

  test('the switch stops tracking, keeping the list saved; and tracks it again from today', async () => {
    const row = await options.savedList('c0ffee')
    await options.press(await options.control(row, 'switch'))
    await until('the entry to go', async () => (await writtenEntries()).lists.length === 0)
    assert.deepEqual((await writtenRecords()).lists.c0ffee, { ...recordOf(COFFEE), title: 'Caffeine' }, 'the record stays')
    await until('the row to say so', async () => (await standing(row)).status === 'saved')

    await options.press(await options.control(row, 'switch'))
    await until('the entry to come back', async () => (await writtenEntries()).lists.length === 1)
    // Tracking again doesn't pour back what went unreviewed in between.
    assert.deepEqual((await writtenEntries()).lists[0], { id: 'c0ffee', kind: 'text-search', url: COFFEE.url, alias: 'Caffeine', tracked: true, since: TODAY })
    await until('the row to say so', async () => (await standing(row)).status === 'tracked' && mentions(await part(row, 'status'), formatDay(TODAY)))
  })

  test('Stop tracking, in its details, asks nothing and keeps the list; Track this list tracks it again', async () => {
    await pressInDetails('c0ffee', 'stop-tracking')
    await until('the entry to go', async () => (await writtenEntries()).lists.length === 0)
    assert.ok((await writtenRecords()).lists.c0ffee, 'the record stays')

    await until('Track this list to be offered', async () => (await options.actions(await options.savedList('c0ffee'), 'track')).length === 1)
    await pressInDetails('c0ffee', 'track')
    await until('the entry to come back', async () => (await writtenEntries()).lists.length === 1)
    assert.equal((await writtenEntries()).lists[0].since, TODAY)
  })

  test('Remove list asks a second time in its place, then takes the record and every copy of its search', async () => {
    const row = await options.savedListDetails('l4tte')
    const remove = await options.action(row, 'remove-list')
    const note = await removalNote(row, 'remove-list')
    assert.ok(mentions(note, LIST_REMOVAL.forgets) && mentions(note, LIST_REMOVAL.copyGoes), note)
    await options.press(remove)
    await until('it to ask', async () => armed(remove))
    await flush()
    assert.ok((await options.lastWrite('option.savedLists')).lists.l4tte, 'the first press removes nothing')

    await options.press(remove)
    await until('the record to go', async () => !('l4tte' in (await writtenRecords()).lists))
    assert.deepEqual(Object.keys((await writtenRecords()).lists).sort(), ['c0ffee', 'ser1es', 't3a'])
    const stored = await options.stored('cache.searchLists')
    for (const key of LATTE_KEYS)
      assert.equal(key in stored, false, `${key} is gone with it`)
    assert.ok(TEA_KEY in stored, 'and only its copies')
    assert.deepEqual((await writtenEntries()).lists.map(entry => entry.id), ['c0ffee'], 'the tracked list is untouched')
    await until('its row to go', async () => !(await options.savedListIds()).includes('l4tte'))
  })

  test('an armed Remove goes back to asking nothing once its time is up', async () => {
    const row = await options.savedListDetails('ser1es')
    const remove = await options.action(row, 'remove-list')
    await options.press(remove)
    await until('it to ask', async () => armed(remove))
    await until('it to stop asking', async () => !await armed(remove), CONFIRM_MS * 4)
    assert.ok((await options.stored('option.savedLists')).lists.ser1es, 'nothing was removed')
  })

  test('switching on a stored search with no record yet tracks it, from today, under the title its record would take', async () => {
    const row = await options.savedList(`copy:${MARRIAGE_KEY}`)
    await options.press(await options.control(row, 'switch'))
    await until('the entry to be written', async () => (await writtenEntries()).lists.length === 2)

    const entry = (await writtenEntries()).lists.at(-1)
    assert.deepEqual({ ...entry, id: undefined }, { id: undefined, kind: 'tag-works', url: '/tags/marriage%20problems', alias: 'Tag: marriage problems', type: 'tag', entity: 'marriage problems', tracked: true, since: TODAY })
    assert.equal((await writtenRecords()).lists[entry.id].title, 'Tag: marriage problems', 'and its record with it')
    // The stored list is now that list's copy, so its row is the list's.
    await until('the list\'s row to take the copy\'s place', async () => {
      const ids = await options.savedListIds()
      return ids.includes(entry.id) && !ids.includes(`copy:${MARRIAGE_KEY}`)
    })
    assert.deepEqual(await cachedFigures(await options.savedList(entry.id)), ONE_WORK)
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/** Tracked, and narrowed in its search view: the copy of its page is stored under the page's own key. */
const SLOW_TEA = {
  id: 'sl0wt3a',
  kind: 'text-search',
  url: '/works/search?work_search[query]=tea',
  alias: 'Slow-burn tea',
  type: 'search',
  entity: 'tea',
  filter: { text: 'slow burn' },
  tracked: true,
  since: TODAY - 4,
}

/**
 * A list with a view filter and the copy of its page are one list: the copy is
 * stored at the list's address, which leaves the filter out. So there is one
 * row, the tracked list's, with the copy's figures.
 */
describe('options UI — a filtered tracked list and its stored list', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: {
        ...listsSeed([SLOW_TEA], [recordOf(SLOW_TEA)]),
        ...storedLists({ [TEA_KEY]: searchCopy('tea', 3, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`, 101) }),
      },
      hash: '#saved-lists',
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  test('are one row: the tracked list\'s, with the copy\'s figures, and nothing is written', async () => {
    await until('the copy to be read', async () => JSON.stringify(await cachedFigures(await options.savedList('sl0wt3a'))) === JSON.stringify(ONE_WORK))
    assert.deepEqual(await options.savedListIds(), ['sl0wt3a'])
    assert.equal((await standing(await options.savedList('sl0wt3a'))).status, 'tracked')
    assert.deepEqual(await options.page.evaluate(() => window.__writes.filter(w => 'option.trackedLists' in w || 'option.savedLists' in w)), [])
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * Four lists, three of them titled, two of those alike but for case — the pair a
 * sync can bring together from two browsers.
 */
const DRACO = { id: 'dr4c0', kind: 'works-filter', url: '/tags/Draco%20Malfoy/works', alias: 'Character: Draco Malfoy', type: 'character', entity: 'Draco Malfoy', tracked: true, since: TODAY - 2 }
const LATTE = { id: 'l4tte', kind: 'text-search', url: '/works/search?work_search[query]=latte', alias: 'coffee shop', tracked: true, since: TODAY - 2 }
const TWIN = { id: 'tw1n', kind: 'series-works', url: '/series/9991', alias: 'character: draco malfoy', type: 'series', entity: 'The Long Way Round', tracked: true, since: TODAY - 2 }
/** Saved, not tracked, under its default title. */
const MARRIAGE = { id: 'm4rr', kind: 'tag-works', url: '/tags/marriage%20problems', title: 'Tag: marriage problems' }

/**
 * What a row says about its list beyond its title — a badge for what it is,
 * however it's titled — and the rules titles keep: sorted by, unique, and a
 * pair that already shares one pointed out.
 */
describe('options UI — saved lists\' titles, badges and links', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: listsSeed([DRACO, LATTE, TWIN], [...[DRACO, LATTE, TWIN].map(recordOf), MARRIAGE]),
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const storedEntries = async () => (await options.lastWrite('option.trackedLists'))?.lists ?? null

  /** Each row, top to bottom: its title field and what the row shows of its list. */
  const rows = async () => Promise.all((await options.listRows(LIST)).map(async (row) => {
    const what = await row.$('[data-saved-list-part="list"]')
    const link = await what.$('[data-action="view-edit"]')
    return {
      id: await row.evaluate(el => el.dataset.savedList),
      title: await (await options.control(row, 'textbox')).evaluate(el => el.value),
      ...await what.evaluate(el => ({
        badge: el.querySelector('span[title]')?.textContent.trim() ?? null,
        badgeTitle: el.querySelector('span[title]')?.getAttribute('title') ?? null,
        shared: !!el.querySelector('[data-saved-list-shared-title]'),
        alert: el.querySelector('[role="alert"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      })),
      href: link ? await link.evaluate(a => a.getAttribute('href')) : null,
    }
  }))
  const rowFor = async id => (await rows()).find(row => row.id === id)

  test('rows sort by title', async () => {
    assert.deepEqual((await rows()).map(r => r.title), ['Character: Draco Malfoy', 'character: draco malfoy', 'coffee shop', 'Tag: marriage problems'])
  })

  test('each carries a badge for what it is, whatever it\'s titled', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.badge), [TRACKED_TYPE_LABELS.character, TRACKED_TYPE_LABELS.series, TRACKED_TYPE_LABELS.search, TRACKED_TYPE_LABELS.tag])
    // The badge's tooltip is the whole of it.
    assert.deepEqual(got.map(r => r.badgeTitle), ['Character: Draco Malfoy', 'Series: The Long Way Round', 'Search: latte', 'Tag: marriage problems'])
  })

  test('the two that share a title are pointed out, and only they are', async () => {
    assert.deepEqual((await rows()).map(r => r.shared), [true, true, false, false])
  })

  test('each list links to its own search on AO3, marked as being refined, tracked or not', async () => {
    assert.equal((await rowFor('dr4c0')).href, 'https://archiveofourown.org/tags/Draco%20Malfoy/works#ao3e-list=dr4c0')
    assert.equal((await rowFor('l4tte')).href, 'https://archiveofourown.org/works/search?work_search[query]=latte#ao3e-list=l4tte')
    assert.equal((await rowFor('m4rr')).href, 'https://archiveofourown.org/tags/marriage%20problems#ao3e-list=m4rr', 'a list that isn\'t tracked has one too')
  })

  test('a title another list has is refused, kept in the field, and the row says which list has it', async () => {
    const input = await options.control(await options.savedList('l4tte'), 'textbox')
    // All at once, the way a paste arrives.
    await input.evaluate((el) => {
      el.value = '  CHARACTER: Draco Malfoy '
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await input.press('Enter')
    await until('the refusal', async () => (await rowFor('l4tte')).alert)
    // A change to another setting is saved with whatever else is waiting to be,
    // so once it is written, the refused title would have been too.
    const works = await options.control(await options.page.$('[data-review-cell="works-per-review"]'), 'spinbutton')
    await works.click({ clickCount: 3 })
    await works.type('41')
    await works.press('Enter')
    await until('the other setting to be written', async () => (await options.lastWrite('option.trackedLists'))?.target === 41)
    assert.equal((await storedEntries()).find(l => l.id === 'l4tte').alias, 'coffee shop', 'nothing is saved')
    assert.equal(await options.lastWrite('option.savedLists'), null)

    const row = await rowFor('l4tte')
    assert.equal(row.title, '  CHARACTER: Draco Malfoy ', 'the field keeps what was typed')
    assert.ok(mentions(row.alert, DRACO.alias), `it names the list that has the title: ${row.alert}`)
  })

  test('(undo) puts the saved title back, and the refusal goes with it', async () => {
    const row = await options.savedList('l4tte')
    await options.press(await options.action(row, 'undo'))
    await until('the title to come back', async () => (await rowFor('l4tte')).title === 'coffee shop')
    assert.equal((await rowFor('l4tte')).alert, null)
    const focused = await options.page.evaluate(() => document.activeElement?.matches('[data-saved-list-title]') ? document.activeElement.closest('[data-saved-list]')?.dataset.savedList : null)
    assert.equal(focused, 'l4tte', 'the field has focus again')
    await options.page.evaluate(() => document.activeElement.blur())
  })

  test('a free title is saved, and the rows hold still until the field is left', async () => {
    const input = await options.control(await options.savedList('l4tte'), 'textbox')
    await input.click({ clickCount: 3 })
    await input.type('Aardvark AUs')
    await input.press('Enter')
    await until('the title to be written', async () => (await storedEntries()).find(l => l.id === 'l4tte').alias === 'Aardvark AUs')
    // Still in its old place while it has focus…
    assert.deepEqual((await rows()).map(r => r.title), ['Character: Draco Malfoy', 'character: draco malfoy', 'Aardvark AUs', 'Tag: marriage problems'])
    assert.equal((await rowFor('l4tte')).alert, null, 'and there is no refusal')

    // …and sorted once it hasn't.
    await input.evaluate(el => el.blur())
    await until('the rows to sort', async () => (await rows())[0].title === 'Aardvark AUs')
    assert.deepEqual((await rows()).map(r => r.title), ['Aardvark AUs', 'Character: Draco Malfoy', 'character: draco malfoy', 'Tag: marriage problems'])
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/** A custom search narrowed in its view: only the view filter to show, by name. */
const NARROWED = {
  id: 'n4rr0w',
  kind: 'tag-works',
  url: '/tags/marriage%20problems',
  alias: 'Tag: marriage problems',
  type: 'freeform',
  entity: 'marriage problems',
  filter: { facets: { characters: { ex: ['Draco Malfoy'] }, freeforms: { req: ['Fluff'] } }, words: [5000, null] },
  tracked: true,
  since: TODAY - 2,
}
/** A listing narrowed in its Sort & Filter sidebar: three filters, plus a sort and a relative date that aren't. */
const SIDEBAR = {
  id: 's1d3b4r',
  kind: 'works-filter',
  url: '/works?work_search[sort_column]=kudos_count&work_search[revised_at]=%3C+2+weeks&work_search[complete]=T&work_search[language_id]=en&exclude_work_search[character_ids][]=12&tag_id=Harry+Potter',
  alias: 'Fandom: Harry Potter',
  type: 'fandom',
  entity: 'Harry Potter',
  tracked: true,
  since: TODAY - 2,
}
/** Neither: a series as it comes. */
const WHOLE = { id: 'wh0l3', kind: 'series-works', url: '/series/9991', alias: 'Series: The Long Way Round', type: 'series', entity: 'The Long Way Round', tracked: true, since: TODAY - 2 }
/** Both, and more names than one line holds. */
const CROWDED = {
  id: 'cr0wd',
  kind: 'text-search',
  url: '/works/search?work_search[query]=coffee&work_search[complete]=T',
  alias: 'Search: coffee',
  type: 'search',
  entity: 'coffee',
  filter: { facets: { characters: { ex: ['Draco Malfoy', 'Ginny Weasley', 'Hermione Granger', 'Neville Longbottom', 'Ron Weasley'] } } },
  tracked: true,
  since: TODAY - 2,
}

/**
 * What each list filters by, in the line that says what it is: the archive's
 * filters counted, the view's by name, nothing for a list that has neither,
 * and one line however much there is to say.
 */
describe('options UI — what each saved list filters by', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      // Entries the background hasn't filed records for yet are lists all the same.
      seed: { 'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [SIDEBAR, CROWDED, WHOLE, NARROWED] } },
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Each row, top to bottom: its title, and its filters as they look, as they're read out, and how they're set. */
  const rows = async () => Promise.all((await options.listRows(LIST)).map(async (row) => {
    const title = await (await options.control(row, 'textbox')).evaluate(el => el.value)
    const filters = await row.evaluate((el) => {
      const line = el.querySelector('[data-saved-list-filters]')
      if (!line)
        return null
      const meta = line.parentElement
      const style = getComputedStyle(line)
      return {
        shown: (line.querySelector('[aria-hidden="true"]') ?? line).textContent.trim(),
        // What's left for a screen reader: everything not hidden from one.
        spoken: [...line.childNodes]
          .filter(node => !(node instanceof Element && node.getAttribute('aria-hidden') === 'true'))
          .map(node => node.textContent)
          .join('')
          .trim(),
        tooltip: line.getAttribute('title'),
        oneLine: getComputedStyle(meta).whiteSpace === 'nowrap' && line.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.5,
        withTheBadge: !!meta.querySelector('span[title]') && meta.contains(line),
        looksLikeIt: style.fontSize === getComputedStyle(meta).fontSize && style.color === getComputedStyle(meta).color,
      }
    })
    return { title, filters }
  }))
  /** The row for one of the seeded lists. */
  const row = async list => (await rows()).find(r => r.title === list.alias)

  test('rows come in title order, as ever', async () => {
    assert.deepEqual((await rows()).map(r => r.title), [SIDEBAR.alias, CROWDED.alias, WHOLE.alias, NARROWED.alias])
  })

  test('a view filter reads by name, as the list\'s filters are described', async () => {
    const { filters } = await row(NARROWED)
    const summary = describeFilters(NARROWED)
    assert.equal(summary.more, 0, 'it all fits')
    assert.equal(filters.shown, summary.full)
    assert.equal(filters.spoken, summary.full, 'a screen reader gets the same text')
    assert.equal(filters.tooltip, summary.full)
  })

  test('the archive\'s filters are counted, and the sort and relative date aren\'t among them', async () => {
    const { filters } = await row(SIDEBAR)
    assert.equal(filters.shown, describeFilters(SIDEBAR).text)
    assert.equal(filters.spoken, filters.shown)
    assert.deepEqual(figures(filters.shown), [3])
  })

  test('a list with neither says nothing', async () => {
    assert.equal((await row(WHOLE)).filters, null)
  })

  test('more than fits: what fits, and the rest in the tooltip and to a screen reader', async () => {
    const { filters } = await row(CROWDED)
    const summary = describeFilters(CROWDED)
    assert.ok(summary.more > 0, 'more than fits')
    assert.equal(filters.shown, summary.text)
    assert.equal(filters.tooltip, summary.full)
    assert.equal(filters.spoken, summary.full)
  })

  test('one muted line, with the badge and the link, in their type', async () => {
    for (const { title, filters } of (await rows()).filter(r => r.filters)) {
      assert.ok(filters.oneLine, `${title}: one line`)
      assert.ok(filters.withTheBadge, `${title}: on the line with the badge and the link`)
      assert.ok(filters.looksLikeIt, `${title}: the same size and colour as that line`)
    }
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/** Two lists searching one thing, one tracked, and their one copy. */
const MINE = { id: 'm1ne', kind: 'text-search', url: '/works/search?work_search[query]=tea', title: 'Mine' }
const THEIRS = { id: 'th3irs', kind: 'text-search', url: '/works/search?work_search[query]=tea', alias: 'Theirs', filter: { text: 'slow burn' }, tracked: true, since: TODAY - 1 }

/**
 * The frame the rows are in: its count; a filter and a sort, which show the
 * rows another way, write nothing and last only as long as the page; the
 * settings search, which finds lists by title and fills the filter; and what
 * it says while Tracked lists is off. Two lists at one address share their
 * copy, so removing one, or the copy, says what it does to the other.
 */
describe('options UI — the saved lists\' frame', { skip }, () => {
  let session
  let options

  const seed = {
    ...listsSeed([THEIRS, DRACO], [MINE, recordOf(THEIRS), recordOf(DRACO), SERIES, LATTE_ART]),
    ...storedLists({
      [TEA_KEY]: searchCopy('tea', 3, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`, 101),
      [LATTE_KEYS[0]]: searchCopy('latte', 1, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte`, 104),
      // An older sort order of the same search, behind the same row.
      [LATTE_KEYS[1]]: searchCopy('latte', 2, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count`, 105),
    }),
  }
  /** The header's count with every list shown: 5 lists, 2 tracked, 3 cached. */
  const ALL = [2, 3, 5]

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed, hash: '#saved-lists', viewport: { width: 1440, height: 900 } })
    await until('the copies to be read', async () => JSON.stringify(await cachedFigures(await options.savedList('m1ne'))) === JSON.stringify(ONE_WORK))
  }, { timeout: 180000 })

  after(() => session?.close())

  const filterBox = async () => {
    const box = await (await options.list(LIST)).$('[data-list-filter]')
    assert.ok(box, 'no filter')
    return box
  }
  const sortButton = async () => options.action(await options.list(LIST), 'sort')
  /** The sort the header shows. */
  const sorted = async () => (await sortButton()).evaluate(el => el.dataset.sort)
  /** Whether the header's count gives these figures. */
  const counts = async figuresWanted => JSON.stringify(figures(await options.listCount(LIST))) === JSON.stringify(figuresWanted)

  /** Choose a sort from the header's menu, and wait for the frame to show it. */
  async function sortBy(choice) {
    await options.press(await sortButton())
    await options.page.waitForSelector('[role="menuitemradio"]')
    await options.page.evaluate(value => document.querySelector(`[role="menuitemradio"][data-sort="${value}"]`).click(), choice)
    await until(`the sort to be ${choice}`, async () => await sorted() === choice)
  }

  /** Type into the filter, as a reader would, and wait for the count to give `count`. */
  async function filterBy(text, count) {
    const box = await filterBox()
    await box.click({ clickCount: 3 })
    if (text)
      await box.type(text)
    else
      await box.press('Backspace')
    await until(`the count to give ${count}`, async () => counts(count))
  }

  test('the header counts the lists, the tracked and the cached', async () => {
    assert.ok(await counts(ALL))
    assert.deepEqual(figures(await (await filterBox()).evaluate(el => el.placeholder)), [5], 'the filter says how many lists it searches')
    assert.equal(await sorted(), 'name')
    assert.deepEqual(await options.savedListIds(), ['dr4c0', 'l4tte', 'm1ne', 'ser1es', 'th3irs'])
  })

  test('two lists at one address share the copy, and each says which other searches the same', async () => {
    const sameSearch = async id => (await options.savedList(id)).$eval('[data-saved-list-same-search]', el => el.textContent)
    assert.ok(mentions(await sameSearch('m1ne'), 'Theirs'))
    assert.ok(mentions(await sameSearch('th3irs'), 'Mine'))
    assert.equal(await part(await options.savedList('th3irs'), 'caching'), await part(await options.savedList('m1ne'), 'caching'))
  })

  test('the filter finds lists by title, kind, and the tag or name they search, with how many it shows', async () => {
    await filterBy('mine', [1, 5])
    assert.deepEqual(await options.savedListIds(), ['m1ne'])
    await filterBy('works search', [3, 5])
    assert.deepEqual(await options.savedListIds(), ['l4tte', 'm1ne', 'th3irs'])
    await filterBy('malfoy', [1, 5])
    assert.deepEqual(await options.savedListIds(), ['dr4c0'])
    await filterBy('nothing like it', [0, 5])
    const empty = await (await options.list(LIST)).$('[data-saved-lists-empty="no-match"]')
    assert.ok(empty, 'it says nothing matches')
    assert.ok(mentions(await options.text(empty), 'nothing like it'), 'naming what was typed')

    // Escape empties it.
    await (await filterBox()).press('Escape')
    await until('every list to show again', async () => counts(ALL))
    assert.equal(await (await filterBox()).evaluate(el => el.value), '')
  })

  test('the clear button empties it too', async () => {
    await filterBy('tea', [2, 5])
    await options.press(await options.action(await options.list(LIST), 'clear'))
    await until('every list to show again', async () => (await options.savedListIds()).length === 5)
  })

  test('each sort orders the rows, and writes nothing', async () => {
    await sortBy('status')
    assert.deepEqual(await options.savedListIds(), ['dr4c0', 'th3irs', 'l4tte', 'm1ne', 'ser1es'], 'tracked, then saved, by name within each')
    await sortBy('refreshed')
    assert.deepEqual(await options.savedListIds(), ['l4tte', 'm1ne', 'th3irs', 'dr4c0', 'ser1es'], 'the newest copy first, and the lists with none last')
    await sortBy('name')
    assert.deepEqual(await options.savedListIds(), ['dr4c0', 'l4tte', 'm1ne', 'ser1es', 'th3irs'])
    assert.deepEqual(await options.page.evaluate(() => window.__writes.filter(w => 'option.trackedLists' in w || 'option.savedLists' in w)), [])
  })

  test('whatever the sort, a list retitled holds its place until its field is left', async () => {
    await sortBy('status')
    const order = await options.savedListIds()
    const input = await options.control(await options.savedList('ser1es'), 'textbox')
    await input.click({ clickCount: 3 })
    await input.type('Aaa')
    await input.press('Enter')
    await until('the title to be written', async () => (await options.lastWrite('option.savedLists'))?.lists.ser1es?.title === 'Aaa')
    assert.deepEqual(await options.savedListIds(), order, 'in its place')
    await input.evaluate(el => el.blur())
    await sortBy('name')
    assert.deepEqual(await options.savedListIds(), ['ser1es', 'dr4c0', 'l4tte', 'm1ne', 'th3irs'], 'and sorted once it is left')
  })

  test('a list retitled out of what the filter finds stays until its field is left', async () => {
    await filterBy('aaa', [1, 5])
    const input = await options.control(await options.savedList('ser1es'), 'textbox')
    await input.click({ clickCount: 3 })
    await input.type('Series: 9991')
    await input.press('Enter')
    await until('the title to be written', async () => (await options.lastWrite('option.savedLists'))?.lists.ser1es?.title === 'Series: 9991')
    assert.deepEqual(await options.savedListIds(), ['ser1es'], 'the filter keeps the row with focus')
    await input.evaluate(el => el.blur())
    await until('the filter to drop it', async () => (await options.savedListIds()).length === 0)
    await filterBy('', ALL)
  })

  test('a settings search finds lists by title, and fills the filter with what it found', async () => {
    const search = await options.page.$('[data-settings-search]')
    await search.type('theirs')
    await until('the filter to fill', async () => await (await filterBox()).evaluate(el => el.value) === 'theirs')
    assert.deepEqual(await options.savedListIds(), ['th3irs'])
    const counted = (await options.railItems()).find(item => item.id === 'saved-lists')
    assert.equal(counted?.count, 1, 'the rail counts the list it found')
    await options.press(await options.action(options.page, 'clear-search'))
    await until('the filter to empty', async () => await (await filterBox()).evaluate(el => el.value) === '')
  })

  test('Remove offline copy takes every copy of the list\'s search, an older sort order too, so the list is no longer cached', async () => {
    const row = await options.savedListDetails('l4tte')
    const remove = await options.action(row, 'remove-copy')
    await options.press(remove)
    await until('it to ask', async () => armed(remove))
    await options.press(remove)
    await until('the copies to go', async () => {
      const stored = await options.stored('cache.searchLists')
      return LATTE_KEYS.every(key => !(key in stored))
    })
    await until('the row to say it isn\'t cached', async () => await cached(await options.savedList('l4tte')) === 'none')
    assert.ok((await options.stored('option.savedLists')).lists.l4tte, 'the list stays')
    assert.ok(TEA_KEY in await options.stored('cache.searchLists'), 'and only its copies go')
  })

  test('Remove offline copy asks a second time, takes the copy from both lists at its address, and keeps both lists', async () => {
    const row = await options.savedListDetails('m1ne')
    assert.ok(mentions(await removalNote(row, 'remove-copy'), 'Theirs'), 'it says the other list loses the copy too')
    const remove = await options.action(row, 'remove-copy')
    await options.press(remove)
    await until('it to ask', async () => armed(remove))
    assert.ok(TEA_KEY in await options.stored('cache.searchLists'), 'the first press removes nothing')
    await options.press(remove)
    await until('the copy to go', async () => !(TEA_KEY in await options.stored('cache.searchLists')))
    const notCached = async id => await cached(await options.savedList(id)) === 'none'
    await until('both rows to say they aren\'t cached', async () => await notCached('m1ne') && await notCached('th3irs'))
    const records = await options.stored('option.savedLists')
    assert.ok(records.lists.m1ne && records.lists.th3irs, 'both lists stay')
  })

  test('Remove list on one of two lists at one address leaves the copy to the other', async () => {
    const lattes = { ...MINE, id: 'm2ne', url: LATTE_ART.url, title: 'Also latte' }
    const shared = await session.open({
      seed: {
        ...listsSeed([], [LATTE_ART, lattes]),
        ...storedLists({ [LATTE_KEYS[0]]: searchCopy('latte', 1, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte`, 104) }),
      },
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
    })
    try {
      const row = await shared.savedListDetails('m2ne')
      const note = await removalNote(row, 'remove-list')
      assert.ok(mentions(note, 'Latte art') && !mentions(note, LIST_REMOVAL.copyGoes), `the copy stays, with the list that searches the same: ${note}`)
      const remove = await shared.action(row, 'remove-list')
      await shared.press(remove)
      await until('it to ask', async () => armed(remove))
      await shared.press(remove)
      await until('the record to go', async () => {
        const records = await shared.lastWrite('option.savedLists')
        return !!records && !('m2ne' in records.lists)
      })
      assert.ok(LATTE_KEYS[0] in await shared.stored('cache.searchLists'), 'the copy stays, with Latte art')
      assert.deepEqual(shared.problems(), [])
    }
    finally {
      await shared.close()
    }
  })

  test('with Tracked lists off, the frame says so, and every switch is off with the reason; titles stay live', async () => {
    await options.press(await options.control(await options.row('review-tracked-lists'), 'switch'))
    await until('the switch to be written', async () => (await options.lastWrite('option.trackedLists'))?.enabled === false)
    await until('the frame to say so', async () => !!await (await options.list(LIST)).$('[data-saved-lists-band="review-off"]'))

    const toggle = await options.control(await options.savedList('th3irs'), 'switch')
    assert.equal(await toggle.evaluate(el => el.disabled), true)
    assert.ok(mentions(await options.description(toggle), TRACK_OFF.review))
    const track = await options.action(await options.savedListDetails('ser1es'), 'track')
    assert.equal(await track.evaluate(el => el.disabled), true)
    assert.ok(mentions(await track.evaluate(el => el.title), TRACK_OFF.review))
    assert.equal(await (await options.control(await options.savedList('ser1es'), 'textbox')).evaluate(el => el.disabled), false)
    assert.ok(await options.action(await options.savedList('th3irs'), 'view-edit'))

    await options.press(await options.control(await options.row('review-tracked-lists'), 'switch'))
    await until('the switch to be written', async () => (await options.lastWrite('option.trackedLists'))?.enabled === true)
    await until('the switch to come back', async () => !(await (await options.control(await options.savedList('th3irs'), 'switch')).evaluate(el => el.disabled)))
  })

  test('a reload goes back to Name, with the filter empty', async () => {
    await sortBy('refreshed')
    await filterBy('latte', [1, 5])
    await options.reload()
    assert.equal(await sorted(), 'name')
    assert.equal(await (await filterBox()).evaluate(el => el.value), '')
    assert.deepEqual(await options.savedListIds(), ['dr4c0', 'l4tte', 'm1ne', 'ser1es', 'th3irs'])
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/**
 * Tracked lists at addresses that aren't AO3's, as a sync or an old settings
 * file can bring them. Nothing can be reviewed from one, and while it is
 * tracked it syncs to every other browser; so it can be stopped, by its switch
 * or in its details, and stays a Saved list, pending. Once saved it can't be
 * tracked again.
 */
describe('options UI — a tracked list at an address that isn\'t AO3\'s', { skip }, () => {
  const BY_SWITCH = { id: 'br0k3n', kind: 'tag-works', url: 'https://example.com/tags/elsewhere', alias: 'Elsewhere', tracked: true, since: TODAY - 3 }
  const BY_DETAILS = { id: 'f4r', kind: 'tag-works', url: 'https://example.com/tags/far', alias: 'Far away', tracked: true, since: TODAY - 3 }
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: listsSeed([BY_SWITCH, BY_DETAILS], [recordOf(BY_SWITCH), recordOf(BY_DETAILS)]),
      hash: '#saved-lists',
      viewport: { width: 1440, height: 900 },
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const entryIds = async () => ((await options.stored('option.trackedLists'))?.lists ?? []).map(entry => entry.id)

  /** The row has stopped: saved, pending, its record kept, and its switch off with the reason it can't be tracked again. */
  async function stoppedAndKept(list) {
    const row = await options.savedList(list.id)
    await until('the row to say it is saved', async () => JSON.stringify(await standing(row)) === JSON.stringify({ status: 'saved', pending: 'not-archive' }))
    assert.deepEqual((await options.stored('option.savedLists')).lists[list.id], recordOf(list), 'the record stays as it was')
    const toggle = await options.control(row, 'switch')
    assert.equal(await isOn(toggle), false)
    assert.equal(await toggle.evaluate(el => el.disabled), true, 'and it can\'t be tracked again')
    assert.ok(mentions(await options.description(toggle), TRACK_OFF.notArchive))
  }

  test('its switch stops tracking it: the entry goes, so it no longer syncs, and the list stays saved', async () => {
    const row = await options.savedList(BY_SWITCH.id)
    assert.deepEqual(await standing(row), { status: 'tracked', pending: 'not-archive' })
    const toggle = await options.control(row, 'switch')
    assert.equal(await isOn(toggle), true)
    assert.equal(await toggle.evaluate(el => el.disabled), false, 'its switch is live while it is tracked')

    await options.press(toggle)
    await until('the entry to go', async () => !(await entryIds()).includes(BY_SWITCH.id))
    assert.deepEqual(await entryIds(), [BY_DETAILS.id], 'only its own')
    await stoppedAndKept(BY_SWITCH)
  })

  test('Stop tracking, in its details, does the same, and says it can\'t be tracked again', async () => {
    const details = await options.savedListDetails(BY_DETAILS.id)
    assert.ok(mentions(await part(details, 'details'), NOT_ARCHIVE_STOP_NOTE))
    await options.press(await options.action(details, 'stop-tracking'))
    await until('the entry to go', async () => (await entryIds()).length === 0)
    await stoppedAndKept(BY_DETAILS)
    assert.deepEqual(await options.actions(await options.savedListDetails(BY_DETAILS.id), 'track'), [], 'nothing offers to track it again')
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/** A fresh install: no lists, and the header keeps its place. */
describe('options UI — no saved lists yet', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  test('the frame says how lists get here, under a header that counts none', async () => {
    const options = await session.open({ hash: '#saved-lists' })
    try {
      await until('the stored lists to be read', async () => !!await (await options.list(LIST)).$('[data-saved-lists-empty="none"]'))
      const count = await options.listCount(LIST)
      assert.ok(count, 'the header keeps its count')
      assert.deepEqual(figures(count), [], 'with nothing to count')
      assert.ok(await (await options.list(LIST)).$('[data-list-filter]'), 'and its filter')
      assert.deepEqual(options.problems(), [])
    }
    finally {
      await options.close()
    }
  })
})

/**
 * A control that goes as it is pressed takes the keyboard's place on the page
 * with it, unless the page puts focus somewhere near: the control that takes
 * its place, the row's own controls, or, with the row gone, the row that takes
 * its place.
 */
describe('options UI — where focus goes when a saved list\'s control goes', { skip }, () => {
  let session
  let options

  /** Saved, with a copy each, in name order: Latte art, Search: tea, Series: 9991. */
  const seed = {
    ...listsSeed([], [LATTE_ART, TEA, SERIES]),
    ...storedLists({
      [TEA_KEY]: searchCopy('tea', 3, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`, 101),
      [LATTE_KEYS[0]]: searchCopy('latte', 1, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte`, 104),
      [MARRIAGE_KEY]: storedCopy('tag-works', 'Uncommon tag — marriage problems', 2, `${ARCHIVE}/tags/marriage%20problems`, 106),
    }),
  }

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed, hash: '#saved-lists', viewport: { width: 1440, height: 900 } })
    await until('the copies to be read', async () => JSON.stringify(await cachedFigures(await options.savedList('t3a'))) === JSON.stringify(ONE_WORK))
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Press the control with the keyboard, as a reader without a mouse does. */
  async function pressKey(control) {
    await control.focus()
    await options.page.keyboard.press('Enter')
  }
  /** What has focus now — what it does, or `title` for a list's title — and the saved list it is in. */
  const focused = () => options.page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body)
      return 'nothing: the page itself'
    return {
      what: el.dataset.action ?? (el.matches('[data-saved-list-title]') ? 'title' : el.tagName.toLowerCase()),
      list: el.closest('[data-saved-list]')?.dataset.savedList ?? null,
    }
  })

  test('Stop tracking hands focus to Track this list, and back', async () => {
    await options.press(await options.control(await options.savedList('t3a'), 'switch'))
    await until('the list to be tracked', async () => (await options.lastWrite('option.trackedLists'))?.lists.length === 1)
    await pressKey(await options.action(await options.savedListDetails('t3a'), 'stop-tracking'))
    await until('the entry to go', async () => (await options.lastWrite('option.trackedLists')).lists.length === 0)
    await until('Track this list to be offered', async () => (await options.actions(await options.savedList('t3a'), 'track')).length === 1)
    assert.deepEqual(await focused(), { what: 'track', list: 't3a' })

    await options.page.keyboard.press('Enter')
    await until('the entry to come back', async () => (await options.lastWrite('option.trackedLists')).lists.length === 1)
    await until('Stop tracking to be offered', async () => (await options.actions(await options.savedList('t3a'), 'stop-tracking')).length === 1)
    assert.deepEqual(await focused(), { what: 'stop-tracking', list: 't3a' })
  })

  test('Remove offline copy, with the list staying, hands focus to the row\'s details', async () => {
    const remove = await options.action(await options.savedListDetails('t3a'), 'remove-copy')
    await pressKey(remove)
    await until('it to ask', async () => armed(remove))
    await options.page.keyboard.press('Enter')
    await until('the copy to go', async () => !(TEA_KEY in await options.stored('cache.searchLists')))
    await until('the row to say it isn\'t cached', async () => await cached(await options.savedList('t3a')) === 'none')
    assert.deepEqual(await focused(), { what: 'details', list: 't3a' })
  })

  test('Remove list hands focus to the row that takes its place', async () => {
    const remove = await options.action(await options.savedListDetails('t3a'), 'remove-list')
    await pressKey(remove)
    await until('it to ask', async () => armed(remove))
    await options.page.keyboard.press('Enter')
    await until('its row to go', async () => !(await options.savedListIds()).includes('t3a'))
    assert.deepEqual(await options.savedListIds(), ['l4tte', 'ser1es', `copy:${MARRIAGE_KEY}`])
    assert.deepEqual(await focused(), { what: 'title', list: 'ser1es' })
  })

  test('the last row hands it back to the row before', async () => {
    const remove = await options.action(await options.savedListDetails(`copy:${MARRIAGE_KEY}`), 'remove-copy')
    await pressKey(remove)
    await until('it to ask', async () => armed(remove))
    await options.page.keyboard.press('Enter')
    await until('its row to go', async () => !(await options.savedListIds()).includes(`copy:${MARRIAGE_KEY}`))
    assert.deepEqual(await focused(), { what: 'title', list: 'ser1es' })
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})

/** Copy URL is small, grey type on a grey chip, and still has to read at AA in either theme. */
describe('options UI — Copy URL reads at AA', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  for (const theme of ['light', 'dark']) {
    test(theme, async () => {
      const options = await session.open({ seed: listsSeed([], [SERIES]), hash: '#saved-lists', theme })
      try {
        const copy = await options.action(await options.savedList('ser1es'), 'copy-url')
        const ratio = await options.contrast(copy)
        assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`)
      }
      finally {
        await options.close()
      }
    })
  }
})
