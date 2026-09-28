import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import puppeteer from 'puppeteer-core'

import { formatDay, utcToday } from '../../src/common/trackedLists.ts'
import { ensureBuilt, findChrome, installMock, serveDist, sleep, storedLists } from './helpers.mjs'

const chromePath = findChrome()
const skip = chromePath ? false : 'Chrome not found (set CHROME_PATH to a Chrome/Chromium binary)'

const ARCHIVE = 'https://archiveofourown.org'
const TODAY = utcToday()

/** The two entries the row is drawn from: one tracked and named, one paused and not. */
const COFFEE = { id: 'c0ffee', kind: 'text-search', url: '/works/search?work_search%5Bquery%5D=coffee', alias: 'Coffee shop AUs', tracked: true, since: TODAY - 5 }
const SERIES = { id: 'ser1es', kind: 'series-works', url: '/series/9991', alias: '', tracked: false, since: TODAY - 12 }

/** A list without an alias is called by its URL's tail, here short enough to be all of it. */
const SERIES_LABEL = '/series/9991'

/** Enough of a blurb for a stored list to have a work in it. */
const blurb = id => `<li class="work blurb group" id="work_${id}" role="article">
  <div class="header module"><h4 class="heading"><a href="/works/${id}">Work ${id}</a>
    by <a rel="author" href="/users/someone/pseuds/someone">someone</a></h4></div>
  <dl class="stats"><dt class="words">Words:</dt><dd class="words">1,000</dd></dl>
</li>`

const SEED = {
  'option.trackedLists': {
    enabled: true,
    target: 40,
    reviewedThrough: TODAY - 9,
    lists: [COFFEE, SERIES],
  },
  ...storedLists({
    // A stored search nothing tracks yet: the row that offers **Track**.
    'text-search:work_search%5Bquery%5D=tea': {
      version: 2,
      scrapedAt: Date.now() - 3 * 60 * 60 * 1000,
      blurbsHtml: [blurb(101)],
      descriptor: {
        sourceId: 'text-search',
        label: 'Works search — tea',
        listUrl: `${ARCHIVE}/works/search?work_search%5Bquery%5D=tea`,
      },
    },
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

/**
 * The options page's half of tracked lists: the Search → Tracked lists row,
 * where an entry is renamed, paused and dropped, and the **Track** action on a
 * stored list under Advanced → Site export, which is how a list the reader
 * already has becomes one of them without going back to AO3.
 *
 * Nothing here reaches the archive. Every one of these actions is an options
 * write, which is exactly why they belong on this page.
 */
describe('options UI — tracked lists', { skip }, () => {
  let server
  let browser
  let page
  const problems = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, SEED)
    page.on('console', m => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', e => problems.push(e.message))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** The last value written to a storage key, or null. */
  const lastWrite = key => page.evaluate(
    k => window.__writes.filter(w => k in w).map(w => w[k]).at(-1) ?? null,
    key,
  )

  const storedOption = () => lastWrite('option.trackedLists')

  /** One row per entry: the title field, what it says under it, and the switch. */
  const rows = () => page.evaluate(() => [...document.querySelectorAll('input[aria-label^="Title for "]')].map((input) => {
    const cell = input.closest('span')
    const toggle = [...document.querySelectorAll('[role="switch"]')]
      .find(s => s.getAttribute('aria-label') === `Track ${input.getAttribute('aria-label').slice('Title for '.length)}`)
    return {
      label: input.getAttribute('aria-label').slice('Title for '.length),
      alias: input.value,
      placeholder: input.placeholder,
      // The cell holds the field and, under it, the line that says what kind of
      // list it is and how it stands. Only the line has text in it.
      note: cell?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      tracked: toggle?.getAttribute('aria-checked') === 'true' || toggle?.dataset.state === 'checked',
    }
  }))

  /** Click a button by the text on it (a `sr-only` icon label counts). */
  const clickButton = text => page.evaluate((t) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.replace(/\s+/g, ' ').trim() === t)
    if (!button)
      throw new Error(`no button "${t}"`)
    button.click()
  }, text)

  const clickSwitch = label => page.evaluate((l) => {
    [...document.querySelectorAll('[role="switch"]')].find(s => s.getAttribute('aria-label') === l)?.click()
  }, label)

  /** The whole OptionRow for a title — its label and whatever sits under it. */
  const rowText = title => page.evaluate((t) => {
    const span = [...document.querySelectorAll('label span')].find(el => el.textContent.trim() === t)
    const row = span?.closest('label')?.parentElement
    return row?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  }, title)

  /** The text of every button inside the row with this title. */
  const rowButtons = title => page.evaluate((t) => {
    const span = [...document.querySelectorAll('label span')].find(el => el.textContent.trim() === t)
    const row = span?.closest('label')?.parentElement
    return [...(row?.querySelectorAll('button') ?? [])].map(b => b.textContent.replace(/\s+/g, ' ').trim())
  }, title)

  test('every entry gets a row, tracked or paused', async () => {
    const got = await rows()
    assert.deepEqual(got.map(r => r.label), ['Coffee shop AUs', SERIES_LABEL])
    assert.equal(got[0].alias, 'Coffee shop AUs')
    assert.equal(got[1].alias, '', 'no alias, so the field is empty')
    assert.equal(got[1].placeholder, SERIES_LABEL, 'and the URL tail stands in for one')
    assert.match(got[0].note, /Works search/)
    assert.match(got[0].note, new RegExp(`Tracking since ${formatDay(TODAY - 5)}`))
    assert.match(got[1].note, /Series/)
    assert.match(got[1].note, /Paused/)
    assert.equal(got[0].tracked, true)
    assert.equal(got[1].tracked, false)
  })

  test('the watermark reads as a date, not a number', async () => {
    assert.match(await rowText('Tracked lists'), new RegExp(`Reviewed through\\s*${formatDay(TODAY - 9)}`))
  })

  test('renaming a list writes the alias straight through', async () => {
    // The field's own label is the name it is showing, so the element is taken
    // once and then typed over: emptying it first would rename the row out from
    // under the selector.
    const input = await page.$('input[aria-label="Title for Coffee shop AUs"]')
    assert.ok(input, 'the title field is there to type into')
    await input.click({ clickCount: 3 })
    await input.type('Caffeine')
    await sleep(1200)

    const stored = await storedOption()
    assert.equal(stored.lists[0].alias, 'Caffeine')
    assert.equal(stored.lists[0].url, COFFEE.url, 'the entry is the same one, renamed')
    // The label follows the alias, so the rest of the row now answers to it.
    assert.deepEqual((await rows()).map(r => r.label), ['Caffeine', SERIES_LABEL])
  })

  test('the switch pauses a list, and resuming restarts the clock', async () => {
    await clickSwitch('Track Caffeine')
    await sleep(1000)
    let stored = await storedOption()
    assert.equal(stored.lists[0].tracked, false)
    assert.equal(stored.lists[0].since, TODAY - 5, 'pausing leaves the tracking date alone')
    assert.match((await rows())[0].note, /Paused/)

    await clickSwitch('Track Caffeine')
    await sleep(1000)
    stored = await storedOption()
    assert.equal(stored.lists[0].tracked, true)
    // A paused stretch is the reader saying "not these for now", so resuming
    // doesn't pour back what they chose to skip.
    assert.equal(stored.lists[0].since, TODAY, 'resuming tracks from today')
  })

  test('dropping a list asks first, and then takes only that one', async () => {
    await clickButton(`Remove ${SERIES_LABEL}`)
    await sleep(500)
    const asked = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null)
    assert.match(asked, /Remove this list\?/)
    assert.match(asked, new RegExp(SERIES_LABEL))

    await page.evaluate(() => {
      [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Remove list').click()
    })
    await sleep(1000)

    const stored = await storedOption()
    assert.deepEqual(stored.lists.map(entry => entry.id), ['c0ffee'])
    assert.deepEqual((await rows()).map(r => r.label), ['Caffeine'])
  })

  test('Track on a stored list makes it an entry, from today', async () => {
    await clickButton('Track')
    await sleep(1000)

    const stored = await storedOption()
    assert.equal(stored.lists.length, 2)
    const added = stored.lists.at(-1)
    assert.equal(added.kind, 'text-search')
    assert.equal(added.url, '/works/search?work_search[query]=tea', 'stored as a path, normalized')
    // Titled the way a list tracked from its own page is.
    assert.equal(added.alias, 'Search: tea')
    assert.equal(added.type, 'search')
    assert.equal(added.entity, 'tea')
    assert.equal(added.tracked, true)
    assert.equal(added.since, TODAY)
    assert.notEqual(added.id, 'c0ffee')

    // The entry and the stored list are now the same list, so the row says so
    // and stops offering to track it a second time.
    await sleep(500)
    assert.equal((await rowButtons('Search: tea')).includes('Track'), false)
    assert.match(await rowText('Search: tea'), /Tracked/)
  })

  test('the review\'s own window is a stored list that can\'t be refreshed', async () => {
    const buttons = await rowButtons('Tracked review window')
    // "Works" caches the work text, which is per work and works fine. "List"
    // would walk a listing, and there isn't one.
    assert.equal(buttons.includes('List'), false)
    assert.equal(buttons.includes('Works'), true)
    assert.equal(buttons.includes('Track'), false, 'the review is not itself trackable')

    const text = await rowText('Tracked review window')
    assert.match(text, /The range you are reviewing now/)
    assert.match(text, /2 works as of/)
    assert.match(text, /nothing to refresh here/)
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(problems, [])
  })
})

/**
 * Four lists, three of them titled, two of those alike but for case — the pair a
 * sync can bring together from two browsers.
 */
const DRACO = { id: 'dr4c0', kind: 'works-filter', url: '/tags/Draco%20Malfoy/works', alias: 'Character: Draco Malfoy', type: 'character', entity: 'Draco Malfoy', tracked: true, since: TODAY - 2 }
const LATTE = { id: 'l4tte', kind: 'text-search', url: '/works/search?work_search[query]=latte', alias: 'coffee shop', tracked: true, since: TODAY - 2 }
const TWIN = { id: 'tw1n', kind: 'series-works', url: '/series/9991', alias: 'character: draco malfoy', type: 'series', entity: 'The Long Way Round', tracked: true, since: TODAY - 2 }
const UNTITLED = { id: 'unt1t', kind: 'tag-works', url: '/tags/marriage%20problems', alias: '', tracked: false, since: TODAY - 2 }

/**
 * What the row says about each list beyond its title — a badge for what it is,
 * however it's titled — and the rules titles keep: sorted by, unique, and a
 * pair that already shares one pointed out. And the row's link, which is where
 * refining a list starts.
 */
describe('options UI — tracked lists\' titles, badges and links', { skip }, () => {
  let server
  let browser
  let page
  const problems = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, {
      'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [DRACO, LATTE, TWIN, UNTITLED] },
    })
    page.on('console', m => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', e => problems.push(e.message))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  const storedLists = () => page.evaluate(() => window.__writes.filter(w => 'option.trackedLists' in w).at(-1)?.['option.trackedLists']?.lists ?? null)

  /** Each row, top to bottom: its title field and everything the row says under it. */
  const rows = () => page.evaluate(() => [...document.querySelectorAll('input[aria-label^="Title for "]')].map((input) => {
    const cell = input.closest('span')
    const link = cell.querySelector('a[href]')
    return {
      title: input.value,
      badge: [...cell.querySelectorAll('span[title]')].map(el => el.textContent.trim())[0] ?? null,
      badgeTitle: [...cell.querySelectorAll('span[title]')].map(el => el.getAttribute('title'))[0] ?? null,
      text: cell.textContent.replace(/\s+/g, ' ').trim(),
      alert: cell.querySelector('[role="alert"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      href: link?.getAttribute('href') ?? null,
      linkTitle: link?.getAttribute('title') ?? null,
    }
  }))

  test('rows sort by title, and a list with none goes last', async () => {
    assert.deepEqual((await rows()).map(r => r.title), ['Character: Draco Malfoy', 'character: draco malfoy', 'coffee shop', ''])
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

  test('each links to its own search on AO3, marked as being refined', async () => {
    const got = await rows()
    assert.equal(got[0].href, 'https://archiveofourown.org/tags/Draco%20Malfoy/works#ao3e-list=dr4c0')
    assert.equal(got[2].href, 'https://archiveofourown.org/works/search?work_search[query]=latte#ao3e-list=l4tte')
    assert.equal(got[3].href, 'https://archiveofourown.org/tags/marriage%20problems#ao3e-list=unt1t')
    assert.equal(got[0].linkTitle, 'Open this list\'s search to refine it')
  })

  test('a title another list has is refused, and the row says which list has it', async () => {
    // All at once, the way a paste arrives.
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Title for coffee shop"]')
      input.value = '  CHARACTER: Draco Malfoy '
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(800)
    // Nothing may have been written at all, which is as good.
    const stored = await storedLists()
    assert.equal(stored?.find(l => l.id === 'l4tte')?.alias ?? LATTE.alias, 'coffee shop', 'nothing is saved')
    const row = (await rows()).find(r => r.badge === 'Search')
    assert.equal(row.title, '  CHARACTER: Draco Malfoy ', 'the field keeps what was typed')
    assert.match(row.alert, /Another list is already called “Character: Draco Malfoy”/)
    assert.match(row.alert, /isn't saved/)
  })

  test('a free title is saved, and the rows hold still until the field is left', async () => {
    const input = await page.$('input[aria-label="Title for coffee shop"]')
    await input.click({ clickCount: 3 })
    await input.type('Aardvark AUs')
    await sleep(1000)
    const stored = await storedLists()
    assert.equal(stored.find(l => l.id === 'l4tte').alias, 'Aardvark AUs')
    // Still in its old place while it's being typed in…
    assert.deepEqual((await rows()).map(r => r.title), ['Character: Draco Malfoy', 'character: draco malfoy', 'Aardvark AUs', ''])
    assert.equal((await rows())[2].alert, null, 'and the refusal is gone')

    // …and sorted once it isn't.
    await page.evaluate(() => document.activeElement.blur())
    await sleep(500)
    assert.deepEqual((await rows()).map(r => r.title), ['Aardvark AUs', 'Character: Draco Malfoy', 'character: draco malfoy', ''])
  })

  test('nothing threw along the way', () => {
    assert.deepEqual(problems, [])
  })
})

/** A custom search narrowed in its view: only the view filter to show, by name. */
const NARROWED = {
  id: 'n4rr0w',
  kind: 'tag-works',
  url: '/tags/marriage%20problems',
  alias: 'Additional tag: marriage problems',
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
  let server
  let browser
  let page
  const problems = []

  before(async () => {
    ensureBuilt()
    server = await serveDist()
    browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-first-run', '--no-default-browser-check'] })
    page = await browser.newPage()
    await page.evaluateOnNewDocument(installMock, {
      'option.trackedLists': { enabled: true, target: 40, reviewedThrough: 0, lists: [SIDEBAR, CROWDED, WHOLE, NARROWED] },
    })
    page.on('console', m => m.type() === 'error' && problems.push(m.text()))
    page.on('pageerror', e => problems.push(e.message))
    await page.goto(`${server.url}/options_ui/options_ui.html`, { waitUntil: 'networkidle2' })
    await sleep(1500)
  }, { timeout: 180000 })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** Each row, top to bottom: its title, and its filter line as it looks, as it's read out, and how it's set. */
  const rows = () => page.evaluate(() => [...document.querySelectorAll('input[aria-label^="Title for "]')].map((input) => {
    const cell = input.closest('span')
    const line = cell.querySelector('[data-tracked-filters]')
    if (!line)
      return { title: input.value, filters: null }
    const style = getComputedStyle(line)
    // The line with the badge, the kind and the link, for the look to match.
    const meta = cell.querySelector('a[href]').parentElement
    return {
      title: input.value,
      filters: {
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
      },
    }
  }))

  test('rows come in title order, as ever', async () => {
    assert.deepEqual((await rows()).map(r => r.title), [NARROWED.alias, SIDEBAR.alias, CROWDED.alias, WHOLE.alias])
  })

  test('a view filter reads by name, in the words an update uses', async () => {
    const { filters } = (await rows())[0]
    const line = 'Requires: Fluff · Excludes: Draco Malfoy · Word count: ≥ 5,000'
    assert.equal(filters.shown, line)
    assert.equal(filters.spoken, line, 'a screen reader gets the same text')
    assert.equal(filters.tooltip, line)
  })

  test('the archive\'s filters are counted, and the sort and relative date aren\'t among them', async () => {
    const { filters } = (await rows())[1]
    assert.equal(filters.shown, '3 search filters')
    assert.equal(filters.spoken, '3 search filters')
  })

  test('a list with neither says nothing', async () => {
    assert.equal((await rows())[3].filters, null)
  })

  test('more than fits: what fits, "+N more", and the rest in the tooltip and to a screen reader', async () => {
    const { filters } = (await rows())[2]
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
    assert.deepEqual(problems, [])
  })
})
