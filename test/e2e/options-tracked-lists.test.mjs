import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { formatDay, utcToday } from '../../src/common/trackedLists.ts'
import { storedLists } from './helpers.mjs'
import { skip, startOptions, until } from './optionsPage.mjs'

const ARCHIVE = 'https://archiveofourown.org'
const TODAY = utcToday()

/** The tracked lists, and the stored lists under Advanced → Site export. */
const TRACKED = 'tracked-lists'
const STORED = 'stored-lists'

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

/** The stored search nothing tracks yet: the row that offers **Track**. */
const TEA_KEY = 'text-search:work_search%5Bquery%5D=tea'
const LATTE_KEYS = ['text-search:work_search%5Bquery%5D=latte', 'text-search:work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count']

/** Enough of a blurb for a stored list to have a work in it. */
const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

/** A stored works search for `query`, read `hours` ago, from `listUrl`. */
const searchCopy = (query, hours, listUrl, id) => ({
  version: 2,
  scrapedAt: Date.now() - hours * 60 * 60 * 1000,
  blurbsHtml: [blurb(id)],
  descriptor: { sourceId: 'text-search', label: `Works search — ${query}`, listUrl },
})

const SEED = {
  ...listsSeed([COFFEE], [recordOf(COFFEE), SERIES, LATTE_ART, TEA], { reviewedThrough: TODAY - 9 }),
  ...storedLists({
    [TEA_KEY]: searchCopy('tea', 3, `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`, 101),
    [LATTE_KEYS[0]]: searchCopy('latte', 5, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte`, 104),
    [LATTE_KEYS[1]]: searchCopy('latte', 4, `${ARCHIVE}/works/search?work_search%5Bquery%5D=latte&work_search%5Bsort_column%5D=kudos_count`, 105),
    // The review's own window. A stored list like any other, and the one that
    // isn't read from a listing, so it can't be refreshed from here.
    'tracked-review': {
      version: 2,
      scrapedAt: Date.now() - 20 * 60 * 1000,
      blurbsHtml: [blurb(102), blurb(103)],
      descriptor: {
        sourceId: 'tracked-review',
        label: 'Tracked review',
        listUrl: `${ARCHIVE}/users/me/readings#ao3e-tracked`,
      },
    },
  }),
}

/** Whether a switch is on. */
const isOn = handle => handle.evaluate(s => s.getAttribute('aria-checked') === 'true' || s.dataset.state === 'checked')

/**
 * The options page's half of saved and tracked lists: the Search → Tracked
 * lists row, which lists every saved list — tracked or not — where one is
 * retitled, tracked, stopped and removed, and the **Track** action on a stored
 * list under Advanced → Site export, which is how a list the reader already has
 * becomes tracked without going back to AO3.
 *
 * Nothing here reaches the archive. Every one of these actions is an options
 * write, which is exactly why they belong on this page: a title on a list that
 * isn't tracked is this browser's record alone, and only tracking writes the
 * entry that syncs.
 */
describe('options UI — tracked lists', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: '#instant-search-views-tracked-lists' })
  }, { timeout: 180000 })

  after(() => session?.close())

  const writtenEntries = () => options.lastWrite('option.trackedLists')
  const writtenRecords = () => options.lastWrite('option.savedLists')

  /** One row per saved list: the title field, everything the row says, the switch and the link. */
  const rows = async () => Promise.all((await options.listRows(TRACKED)).map(async (row) => {
    const input = await options.control(row, 'textbox')
    return {
      id: await row.evaluate(el => el.dataset.listRow),
      label: (await options.name(input)).slice('Title for '.length),
      title: await input.evaluate(el => el.value),
      note: await options.text(row),
      tracked: await isOn(await options.control(row, 'switch')),
      links: (await options.controls(row, 'link')).length,
    }
  }))
  const rowFor = async id => (await rows()).find(row => row.id === id)

  /** Press a control in one of the two lists, by its role and name. */
  const pressIn = async (list, role, name) => options.press(await options.control(await options.list(list), role, name))

  /** The names of every button on one stored list's row. */
  const storedButtons = async key => Promise.all((await options.controls(await options.listRow(STORED, key), 'button')).map(b => options.name(b)))

  test('every saved list gets a row, tracked or not', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.label), ['Coffee shop AUs', 'Latte art', 'Search: tea', 'Series: 9991'], 'by title')

    const coffee = await rowFor('c0ffee')
    assert.match(coffee.note, /Works search/)
    assert.match(coffee.note, new RegExp(`Tracking since ${formatDay(TODAY - 5)}`))
    assert.equal(coffee.tracked, true)
    assert.equal(coffee.links, 1, 'a tracked list links to its search, to refine it')

    const series = await rowFor('ser1es')
    assert.equal(series.title, 'Series: 9991')
    assert.match(series.note, /Series/)
    assert.match(series.note, /Saved/)
    assert.doesNotMatch(series.note, /Paused/)
    assert.equal(series.tracked, false)
    assert.equal(series.links, 0)
  })

  test('the watermark reads as a date, not a number', async () => {
    assert.match(await options.text(await options.row('instant-search-views-tracked-lists')), new RegExp(`Reviewed through\\s*${formatDay(TODAY - 9)}`))
  })

  test('retitling a saved list writes only its record, which never syncs', async () => {
    const input = await options.control(await options.list(TRACKED), 'textbox', 'Title for Latte art')
    await input.click({ clickCount: 3 })
    await input.type('Latte love ')
    await until('the title to be written', async () => (await writtenRecords())?.lists.l4tte?.title === 'Latte love')

    const records = await writtenRecords()
    assert.equal(records.lists.l4tte.title, 'Latte love', 'trimmed')
    assert.deepEqual(records.lists.l4tte, { ...LATTE_ART, title: 'Latte love' }, 'the same list, retitled')
    assert.equal(await writtenEntries(), null, 'nothing that syncs was written')
    assert.equal(await input.evaluate(el => el.value), 'Latte love ', 'the field keeps what is being typed')
    await options.page.evaluate(() => document.activeElement.blur())
  })

  test('retitling a tracked list writes its record and its entry', async () => {
    // The field's own label is the name it is showing, so the element is taken
    // once and then typed over: emptying it first would rename the row out from
    // under the selector.
    const input = await options.control(await options.list(TRACKED), 'textbox', 'Title for Coffee shop AUs')
    await input.click({ clickCount: 3 })
    await input.type('Caffeine')
    await until('the title to be written', async () => (await writtenEntries())?.lists[0]?.alias === 'Caffeine')

    const entries = await writtenEntries()
    assert.equal(entries.lists[0].alias, 'Caffeine')
    assert.equal(entries.lists[0].url, COFFEE.url, 'the entry is the same one, retitled')
    assert.equal((await writtenRecords()).lists.c0ffee.title, 'Caffeine')
    await options.page.evaluate(() => document.activeElement.blur())
    // The label follows the title, so the rest of the row now answers to it.
    await until('the row to answer to its title', async () => (await rowFor('c0ffee'))?.label === 'Caffeine')
  })

  test('the switch stops tracking, keeping the list saved; and tracks it again from today', async () => {
    await pressIn(TRACKED, 'switch', 'Track Caffeine')
    await until('the entry to go', async () => (await writtenEntries()).lists.length === 0)
    assert.deepEqual((await writtenRecords()).lists.c0ffee, { ...recordOf(COFFEE), title: 'Caffeine' }, 'the record stays')
    assert.match((await rowFor('c0ffee')).note, /Saved/)

    await pressIn(TRACKED, 'switch', 'Track Caffeine')
    await until('the entry to come back', async () => (await writtenEntries()).lists.length === 1)
    const [entry] = (await writtenEntries()).lists
    // Tracking again doesn't pour back what went unreviewed in between.
    assert.deepEqual(entry, { id: 'c0ffee', kind: 'text-search', url: COFFEE.url, alias: 'Caffeine', tracked: true, since: TODAY })
    assert.match((await rowFor('c0ffee')).note, new RegExp(`Tracking since ${formatDay(TODAY)}`))
  })

  test('removing a list asks first, then takes its record and every copy of its search', async () => {
    await pressIn(TRACKED, 'button', 'Remove Latte love')
    const dialog = () => options.page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null)
    await until('the confirmation', async () => /Remove this list\?/.test(await dialog() ?? ''))
    const asked = await dialog()
    assert.match(asked, /Remove this list\?/)
    assert.match(asked, /Latte love/)
    assert.match(asked, /stored cop/)

    await options.page.evaluate(() => {
      [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Remove list').click()
    })
    await until('the record to go', async () => {
      const records = await writtenRecords()
      return !!records && !('l4tte' in records.lists)
    })

    assert.deepEqual(Object.keys((await writtenRecords()).lists).sort(), ['c0ffee', 'ser1es', 't3a'])
    const stored = await options.stored('cache.searchLists')
    for (const key of LATTE_KEYS)
      assert.equal(key in stored, false, `${key} is gone with it`)
    assert.ok(TEA_KEY in stored, 'and only its copies')
    assert.deepEqual((await writtenEntries()).lists.map(entry => entry.id), ['c0ffee'], 'the tracked list is untouched')
    assert.deepEqual((await rows()).map(r => r.id).sort(), ['c0ffee', 'ser1es', 't3a'])
  })

  test('Track on a stored list tracks the saved list it is, from today, under the search\'s title', async () => {
    await pressIn(STORED, 'button', 'Track')
    await until('the entry to be written', async () => (await writtenEntries()).lists.length === 2)

    const entries = (await writtenEntries()).lists
    assert.equal(entries.length, 2)
    // The saved list's own id: the stored list and the record were already one list.
    assert.deepEqual(entries.at(-1), { id: 't3a', kind: 'text-search', url: '/works/search?work_search[query]=tea', alias: 'Search: tea', type: 'search', entity: 'tea', tracked: true, since: TODAY })
    assert.equal((await writtenRecords()).lists.t3a.title, 'Search: tea', 'titled the way a list tracked from its page is')

    // The entry and the stored list are now the same list, so the row says so
    // and stops offering to track it a second time.
    await until('the stored row to stop offering Track', async () => !(await storedButtons(TEA_KEY)).includes('Track'))
    assert.match(await options.text(await options.listRow(STORED, TEA_KEY)), /Tracked/)
    assert.equal((await rowFor('t3a')).tracked, true)
  })

  test('the review\'s own window is a stored list that can\'t be refreshed', async () => {
    const buttons = await storedButtons('tracked-review')
    // "Works" caches the work text, which is per work and works fine. "List"
    // would walk a listing, and there isn't one.
    assert.equal(buttons.includes('List'), false)
    assert.equal(buttons.includes('Works'), true)
    assert.equal(buttons.includes('Track'), false, 'the review is not itself trackable')

    const text = await options.text(await options.listRow(STORED, 'tracked-review'))
    assert.match(text, /The range you are reviewing now/)
    assert.match(text, /2 works as of/)
    assert.match(text, /nothing to refresh here/)
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
 * stored at the list's address, which leaves the filter out. So the stored row
 * is the tracked list's, named by its title, and has nothing to track.
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
      hash: '#site-export',
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  test('are one list: the stored row is named by the list\'s title, offers no Track, and writes nothing', async () => {
    const row = await options.listRow(STORED, TEA_KEY)
    const buttons = await Promise.all((await options.controls(row, 'button')).map(b => options.name(b)))
    assert.equal(buttons.includes('Track'), false)
    assert.match(await options.text(await row.$('[data-row-part="title"]')), /^Slow-burn tea\b/)
    assert.match(await options.text(row), /Tracked/)
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
 * What the row says about each list beyond its title — a badge for what it is,
 * however it's titled — and the rules titles keep: sorted by, unique, and a
 * pair that already shares one pointed out. And a tracked list's link, which
 * is where refining it starts.
 */
describe('options UI — tracked lists\' titles, badges and links', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: listsSeed([DRACO, LATTE, TWIN], [...[DRACO, LATTE, TWIN].map(recordOf), MARRIAGE]),
      hash: '#instant-search-views-tracked-lists',
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  const storedEntries = async () => (await options.lastWrite('option.trackedLists'))?.lists ?? null

  const titleField = async title => options.control(await options.list(TRACKED), 'textbox', `Title for ${title}`)

  /** Each row, top to bottom: its title field and everything the row says. */
  const rows = async () => Promise.all((await options.listRows(TRACKED)).map(async (row) => {
    const [link] = await options.controls(row, 'link')
    return {
      title: await (await options.control(row, 'textbox')).evaluate(el => el.value),
      ...await row.evaluate((el) => {
        // The badge is the first thing on the row that explains itself on hover.
        const badge = el.querySelector('span[title]')
        return {
          badge: badge?.textContent.trim() ?? null,
          badgeTitle: badge?.getAttribute('title') ?? null,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
          alert: el.querySelector('[role="alert"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
        }
      }),
      href: link ? await link.evaluate(a => a.getAttribute('href')) : null,
      linkTitle: link ? await link.evaluate(a => a.getAttribute('title')) : null,
    }
  }))

  test('rows sort by title', async () => {
    assert.deepEqual((await rows()).map(r => r.title), ['Character: Draco Malfoy', 'character: draco malfoy', 'coffee shop', 'Tag: marriage problems'])
  })

  test('each carries a badge for what it is, whatever it\'s titled', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.badge), ['Character', 'Series', 'Search', 'Tag'])
    // The badge's tooltip is the whole of it.
    assert.deepEqual(got.map(r => r.badgeTitle), ['Character: Draco Malfoy', 'Series: The Long Way Round', 'Search: latte', 'Tag: marriage problems'])
  })

  test('the two that share a title are pointed out, and only they are', async () => {
    const got = await rows()
    const marked = got.map(r => /Another list has this title too/.test(r.text))
    assert.deepEqual(marked, [true, true, false, false])
  })

  test('each tracked list links to its own search on AO3, marked as being refined', async () => {
    const got = await rows()
    assert.equal(got[0].href, 'https://archiveofourown.org/tags/Draco%20Malfoy/works#ao3e-list=dr4c0')
    assert.equal(got[2].href, 'https://archiveofourown.org/works/search?work_search[query]=latte#ao3e-list=l4tte')
    assert.equal(got[3].href, null, 'a list that isn\'t tracked has none')
    assert.equal(got[0].linkTitle, 'Open this list\'s search to refine it')
  })

  test('a title another list has is refused, and the row says which list has it', async () => {
    // All at once, the way a paste arrives.
    await (await titleField('coffee shop')).evaluate((input) => {
      input.value = '  CHARACTER: Draco Malfoy '
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await until('the refusal', async () => (await rows()).find(r => r.badge === 'Search').alert)
    // A change to another setting is saved with whatever else is waiting to be,
    // so once it is written, the refused title would have been too.
    const works = await options.control(options.page, 'spinbutton', 'Works per review')
    await works.click({ clickCount: 3 })
    await works.type('41')
    await works.press('Enter')
    await until('the other setting to be written', async () => (await options.lastWrite('option.trackedLists'))?.target === 41)
    assert.equal((await storedEntries()).find(l => l.id === 'l4tte').alias, 'coffee shop', 'nothing is saved')
    assert.equal(await options.lastWrite('option.savedLists'), null)
    const row = (await rows()).find(r => r.badge === 'Search')
    assert.equal(row.title, '  CHARACTER: Draco Malfoy ', 'the field keeps what was typed')
    assert.match(row.alert, /Another list is already called “Character: Draco Malfoy”/)
    assert.match(row.alert, /isn't saved/)
  })

  test('a free title is saved, and the rows hold still until the field is left', async () => {
    const input = await titleField('coffee shop')
    await input.click({ clickCount: 3 })
    await input.type('Aardvark AUs')
    await until('the title to be written', async () => (await storedEntries()).find(l => l.id === 'l4tte').alias === 'Aardvark AUs')
    const stored = await storedEntries()
    assert.equal(stored.find(l => l.id === 'l4tte').alias, 'Aardvark AUs')
    // Still in its old place while it's being typed in…
    assert.deepEqual((await rows()).map(r => r.title), ['Character: Draco Malfoy', 'character: draco malfoy', 'Aardvark AUs', 'Tag: marriage problems'])
    assert.equal((await rows())[2].alert, null, 'and the refusal is gone')

    // …and sorted once it isn't.
    await options.page.evaluate(() => document.activeElement.blur())
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
 * The line under each list's title that says what it filters by: the archive's
 * filters counted, the view's by name, nothing for a list that has neither, and
 * one line however much there is to say.
 */
describe('options UI — what each tracked list filters by', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: { 'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [SIDEBAR, CROWDED, WHOLE, NARROWED] } },
      hash: '#instant-search-views-tracked-lists',
    })
  }, { timeout: 180000 })

  after(() => session?.close())

  /** Each row, top to bottom: its title, and its filter line as it looks, as it's read out, and how it's set. */
  const rows = async () => Promise.all((await options.listRows(TRACKED)).map(async (row) => {
    const title = await (await options.control(row, 'textbox')).evaluate(el => el.value)
    const [link] = await options.controls(row, 'link')
    // The line with the badge, the kind and the link, for the look to match.
    const meta = await link.evaluateHandle(a => a.parentElement)
    const filters = await row.evaluate((el, meta) => {
      const line = el.querySelector('[data-tracked-filters]')
      if (!line)
        return null
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
        oneLine: style.whiteSpace === 'nowrap' && line.getBoundingClientRect().height <= Number.parseFloat(style.lineHeight) * 1.5,
        afterMeta: (line.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
        looksLikeMeta: style.fontSize === getComputedStyle(meta).fontSize && style.color === getComputedStyle(meta).color,
      }
    }, meta)
    return { title, filters }
  }))
  /** The row for one of the seeded lists. */
  const row = async list => (await rows()).find(r => r.title === list.alias)

  test('rows come in title order, as ever', async () => {
    assert.deepEqual((await rows()).map(r => r.title), [SIDEBAR.alias, CROWDED.alias, WHOLE.alias, NARROWED.alias])
  })

  test('a view filter reads by name, in the words an update uses', async () => {
    const { filters } = await row(NARROWED)
    const line = 'Requires: Fluff · Excludes: Draco Malfoy · Word count: ≥ 5,000'
    assert.equal(filters.shown, line)
    assert.equal(filters.spoken, line, 'a screen reader gets the same text')
    assert.equal(filters.tooltip, line)
  })

  test('the archive\'s filters are counted, and the sort and relative date aren\'t among them', async () => {
    const { filters } = await row(SIDEBAR)
    assert.equal(filters.shown, '3 search filters')
    assert.equal(filters.spoken, '3 search filters')
  })

  test('a list with neither says nothing', async () => {
    assert.equal((await row(WHOLE)).filters, null)
  })

  test('more than fits: what fits, "+N more", and the rest in the tooltip and to a screen reader', async () => {
    const { filters } = await row(CROWDED)
    const full = '1 search filter · Excludes: Draco Malfoy, Ginny Weasley, Hermione Granger, Neville Longbottom, Ron Weasley'
    assert.equal(filters.shown, '1 search filter · Excludes: Draco Malfoy, Ginny Weasley +3 more')
    assert.equal(filters.tooltip, full)
    assert.equal(filters.spoken, full)
  })

  test('one muted line under the row\'s own, in its type', async () => {
    for (const { title, filters } of (await rows()).filter(r => r.filters)) {
      assert.ok(filters.oneLine, `${title}: one line`)
      assert.ok(filters.afterMeta, `${title}: under the line with the badge and the link`)
      assert.ok(filters.looksLikeMeta, `${title}: the same size and colour as that line`)
    }
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(options.problems(), [])
  })
})
