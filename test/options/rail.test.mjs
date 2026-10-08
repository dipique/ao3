import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildRail, landingCategory, markedSubsection, nextHold, subsectionInView } from '../../src/options_ui/model/rail.ts'

const SITE = 'Site features & appearance'

const ROWS = [
  { category: SITE, subsection: 'Link menus', title: 'Right-click menus', subtitle: 'Menus on tags, fandoms and authors.' },
  { category: SITE, subsection: 'Link menus', title: 'Menu on tags', subtitle: 'Open a menu on any tag.' },
  { category: SITE, subsection: 'Appearance', title: 'Extension theme', subtitle: 'Light, dark, or as AO3 shows.' },
  { category: 'Reading', subsection: 'Marks & status', title: 'Work marks', subtitle: 'Your own marks on works.' },
  { category: 'Reading', subsection: 'Work text', title: 'Reader mode', subtitle: 'Strips the page down to the work text.' },
  { category: 'Reading', subsection: 'Work text', title: 'Narrow text', subtitle: 'A narrower reading column.' },
  { category: 'Search', subsection: 'Filter defaults', title: 'Default language', subtitle: 'Pre-fills the sidebar.' },
]

const ORDER = [SITE, 'Search', 'Reading']

const byId = rail => Object.fromEntries(rail.map(category => [category.id, category]))
/** The sub-sections a category draws, by title, in the order it draws them. */
const drawn = (category, ...titles) => titles.map(title => ({ category, title }))

/** The drawn Lists, whose Saved lists has no rows: no list has been saved. */
const LISTS_ROWS = [
  { category: 'Lists', subsection: 'Review', title: 'Tracked lists', subtitle: 'What is new across the lists you track.' },
  { category: 'Lists', subsection: 'Offline reading', title: 'Cached work text', subtitle: 'The text of the works you cached.' },
]
const LISTS_DRAWN = drawn('Lists', 'Review', 'Saved lists', 'Offline reading')
const shape = rail => rail.map(({ id, count, subsections }) => ({ id, count, subsections: subsections.map(s => [s.id, s.count]) }))

describe('buildRail', () => {
  test('lists the categories in the given order, by id and name', () => {
    const rail = buildRail(ROWS, ORDER, '', 'search')
    assert.deepEqual(rail.map(c => [c.id, c.name]), [
      ['site-features-appearance', SITE],
      ['search', 'Search'],
      ['reading', 'Reading'],
    ])
  })

  test('counts each category\'s rows, and each sub-section\'s, in the order the rows come', () => {
    assert.deepEqual(shape(buildRail(ROWS, ORDER, '', 'search')), [
      { id: 'site-features-appearance', count: 3, subsections: [['link-menus', 2], ['appearance', 1]] },
      { id: 'search', count: 1, subsections: [['filter-defaults', 1]] },
      { id: 'reading', count: 3, subsections: [['marks-status', 1], ['work-text', 2]] },
    ])
  })

  test('puts sub-sections in the order given, whatever order their rows come in', () => {
    const rows = [
      { category: 'Lists', subsection: 'Review', title: 'Tracked lists', subtitle: '' },
      { category: 'Lists', subsection: 'Offline reading', title: 'Cached work text', subtitle: '' },
      // A saved list's row, drawn once the stored lists have been read.
      { category: 'Lists', subsection: 'Saved lists', title: 'Search: tea', subtitle: '' },
    ]
    const lists = byId(buildRail(rows, ['Lists'], '', 'lists', drawn('Lists', 'Review', 'Saved lists', 'Offline reading'))).lists
    assert.deepEqual(lists.subsections.map(s => [s.id, s.count]), [['review', 1], ['saved-lists', 1], ['offline-reading', 1]])
  })

  test('a sub-section the order leaves out comes after the others, in the order its rows come', () => {
    const reading = byId(buildRail(ROWS, ORDER, '', 'reading', drawn('Reading', 'Work text'))).reading
    assert.deepEqual(reading.subsections.map(s => s.id), ['work-text', 'marks-status'])
  })

  test('a sub-section drawn with no rows is listed under its own category, at 0', () => {
    const rail = byId(buildRail(LISTS_ROWS, ['Lists', 'Reading'], '', 'lists', [...LISTS_DRAWN, ...drawn('Reading', 'Work text')]))
    assert.deepEqual(rail.lists.subsections.map(s => [s.id, s.count, s.hits]), [['review', 1, 1], ['saved-lists', 0, 0], ['offline-reading', 1, 1]])
    assert.equal(rail.lists.count, 2, 'a sub-section adds no rows to its category')
    assert.deepEqual(rail.reading.subsections.map(s => [s.id, s.count]), [['work-text', 0]], 'nor to another category')
  })

  test('names each sub-section by its title', () => {
    const reading = byId(buildRail(ROWS, ORDER, '', 'reading')).reading
    assert.deepEqual(reading.subsections.map(s => s.name), ['Marks & status', 'Work text'])
  })

  test('a row outside any sub-section counts toward its category only', () => {
    const rows = [...ROWS, { category: 'Search', subsection: null, title: 'Loose row', subtitle: '' }]
    const search = byId(buildRail(rows, ORDER, '', 'search')).search
    assert.equal(search.count, 2)
    assert.deepEqual(search.subsections.map(s => [s.id, s.count]), [['filter-defaults', 1]])
  })

  test('a row with no category is in none', () => {
    const rows = [...ROWS, { category: null, subsection: null, title: 'Stray row', subtitle: '' }]
    assert.deepEqual(shape(buildRail(rows, ORDER, '', 'search')), shape(buildRail(ROWS, ORDER, '', 'search')))
  })

  test('a category the order leaves out still gets listed, after the others', () => {
    const rows = [{ category: 'Advanced', subsection: 'Under the hood', title: 'Verbose logging', subtitle: '' }, ...ROWS]
    const rail = buildRail(rows, ORDER, '', 'search')
    assert.deepEqual(rail.map(c => c.id), ['site-features-appearance', 'search', 'reading', 'advanced'])
    assert.equal(rail.at(-1).count, 1)
  })

  test('a category in the order with no rows is listed, empty', () => {
    const rail = buildRail(ROWS, [...ORDER, 'Lists'], '', 'search')
    const lists = byId(rail).lists
    assert.deepEqual({ count: lists.count, hits: lists.hits, visible: lists.visible, subsections: lists.subsections }, {
      count: 0,
      hits: 0,
      visible: true,
      subsections: [],
    })
  })

  describe('with no query', () => {
    test('every category is visible, and its hits are its count', () => {
      for (const query of ['', '   ']) {
        for (const category of buildRail(ROWS, ORDER, query, 'search')) {
          assert.equal(category.visible, true, `${category.id} with ${JSON.stringify(query)}`)
          assert.equal(category.hits, category.count)
          for (const subsection of category.subsections)
            assert.equal(subsection.hits, subsection.count)
        }
      }
    })

    test('every sub-section is visible, one with no rows too', () => {
      for (const query of ['', '   ']) {
        const lists = byId(buildRail(LISTS_ROWS, ['Lists'], query, 'lists', LISTS_DRAWN)).lists
        assert.deepEqual(lists.subsections.map(s => [s.id, s.visible]), [['review', true], ['saved-lists', true], ['offline-reading', true]], JSON.stringify(query))
      }
    })
  })

  describe('with a query', () => {
    test('counts the matching rows in each category and sub-section, and keeps the counts', () => {
      const rail = byId(buildRail(ROWS, ORDER, 'text', 'search'))
      assert.equal(rail.reading.count, 3)
      assert.equal(rail.reading.hits, 2)
      assert.deepEqual(rail.reading.subsections.map(s => [s.id, s.count, s.hits]), [['marks-status', 1, 0], ['work-text', 2, 2]])
    })

    test('hides the categories with no hit', () => {
      const rail = buildRail(ROWS, ORDER, 'text', 'search')
      assert.deepEqual(rail.map(c => [c.id, c.visible, c.hits]), [
        ['site-features-appearance', false, 0],
        ['search', false, 0],
        ['reading', true, 2],
      ])
    })

    test('a category with no rows is hidden', () => {
      assert.equal(byId(buildRail(ROWS, [...ORDER, 'Lists'], 'text', 'search')).lists.visible, false)
    })

    test('only the sub-sections with hits are visible, so one with no rows is hidden', () => {
      const lists = byId(buildRail(LISTS_ROWS, ['Lists'], 'cached', 'lists', LISTS_DRAWN)).lists
      assert.deepEqual(lists.subsections.map(s => [s.id, s.hits, s.visible]), [['review', 0, false], ['saved-lists', 0, false], ['offline-reading', 1, true]])
    })

    test('matches every term, in the title or the description, ignoring case and accents', () => {
      const rail = byId(buildRail(ROWS, ORDER, 'MENU fandoms', 'search'))
      assert.equal(rail['site-features-appearance'].hits, 1, 'only "Right-click menus" has both terms')
      assert.equal(byId(buildRail(ROWS, ORDER, 'réader', 'search')).reading.hits, 1)
    })
  })

  describe('the current category', () => {
    test('is the one whose id is given', () => {
      const rail = buildRail(ROWS, ORDER, '', 'site-features-appearance')
      assert.deepEqual(rail.map(c => [c.id, c.current]), [
        ['site-features-appearance', true],
        ['search', false],
        ['reading', false],
      ])
    })

    test('is none when the id names no category', () => {
      assert.ok(buildRail(ROWS, ORDER, '', 'nowhere').every(c => !c.current))
      assert.ok(buildRail(ROWS, ORDER, '', SITE).every(c => !c.current), 'a title is not an id')
    })

    test('stays current while a query hides it', () => {
      const site = byId(buildRail(ROWS, ORDER, 'text', 'site-features-appearance'))['site-features-appearance']
      assert.deepEqual([site.visible, site.current], [false, true])
    })
  })

  describe('the pane', () => {
    const inPane = rail => rail.filter(c => c.inPane).map(c => c.id)

    test('with no query, holds the current category alone', () => {
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, '', 'reading')), ['reading'])
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, '  ', 'search')), ['search'])
    })

    test('with a query, holds every category with a hit, in rail order', () => {
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, 'menu', 'reading')), ['site-features-appearance'])
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, 'the', 'reading')), ['site-features-appearance', 'search', 'reading'])
    })

    test('with a query, leaves out the current category when it has no hit', () => {
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, 'text', 'search')), ['reading'])
    })

    test('with a query nothing matches, holds nothing', () => {
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, 'zzz', 'reading')), [])
    })

    test('clearing the query gives the pane back to the current category', () => {
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, 'menu', 'reading')), ['site-features-appearance'])
      assert.deepEqual(inPane(buildRail(ROWS, ORDER, '', 'reading')), ['reading'])
    })
  })
})

describe('landingCategory', () => {
  const anchors = { '#work-text-reader-mode': 'reading', '#Search': 'search' }
  const lookups = []
  const anchorCategory = (hash) => {
    lookups.push(hash)
    return anchors[hash] ?? null
  }

  test('with no hash, the first category', () => {
    lookups.length = 0
    assert.equal(landingCategory('', anchorCategory, 'site-features-appearance'), 'site-features-appearance')
    assert.equal(landingCategory('#', anchorCategory, 'site-features-appearance'), 'site-features-appearance')
    assert.deepEqual(lookups, [], 'an empty hash names nothing to look up')
  })

  test('a hash naming an anchor lands in the anchor\'s category', () => {
    assert.equal(landingCategory('#work-text-reader-mode', anchorCategory, 'site-features-appearance'), 'reading')
    assert.equal(landingCategory('#Search', anchorCategory, 'site-features-appearance'), 'search')
  })

  test('a hash naming nothing lands on the first category', () => {
    assert.equal(landingCategory('#no-such-setting', anchorCategory, 'site-features-appearance'), 'site-features-appearance')
  })
})

/**
 * Site features as the pane draws it, by each sub-section's top in the page:
 * a long first section, then two short ones, which a window 800 px tall
 * can't bring up to the reading line, just under the 52 px top bar.
 */
const PAGE = { 'link-menus': 120, 'page-controls': 900, 'appearance': 1300 }
const HEIGHT = 800
const SCROLL_HEIGHT = 1700
const LINE = 52

/** The sections' tops in the window, scrolled this far down. */
const tops = (scrollTop, page = PAGE) => Object.entries(page).map(([id, top]) => ({ id, top: top - scrollTop }))
/** The window, scrolled this far down a page this tall. */
const view = (scrollTop, scrollHeight = SCROLL_HEIGHT) => ({ line: LINE, scrollTop, height: HEIGHT, scrollHeight })

describe('subsectionInView', () => {
  test('names none with no sections', () => {
    assert.equal(subsectionInView([], view(0)), null)
  })

  test('above the first section, names the first', () => {
    assert.equal(subsectionInView(tops(0), view(0)), 'link-menus')
  })

  test('names the section that holds the line: the last whose top is at it or above it', () => {
    assert.equal(subsectionInView(tops(500), view(500)), 'link-menus')
    assert.equal(subsectionInView(tops(860), view(860)), 'page-controls')
  })

  test('a top on the line holds it, give or take the rounding of a scroll position', () => {
    const at = top => subsectionInView([{ id: 'link-menus', top: -400 }, { id: 'page-controls', top }], view(500))
    assert.equal(at(LINE), 'page-controls')
    assert.equal(at(LINE + 0.5), 'page-controls')
    assert.equal(at(LINE + 2), 'link-menus')
  })

  test('at the foot of the page, names the last, too short to reach the line', () => {
    const foot = SCROLL_HEIGHT - HEIGHT
    assert.ok(tops(foot).at(-1).top > LINE, 'the last section is under the line at the foot')
    assert.equal(subsectionInView(tops(foot), view(foot)), 'appearance')
    assert.equal(subsectionInView(tops(foot - 0.5), view(foot - 0.5)), 'appearance', 'give or take the rounding of a scroll position')
  })

  test('short of the foot, the line decides', () => {
    assert.equal(subsectionInView(tops(890), view(890)), 'page-controls')
  })

  test('a page too short to scroll is at its top, not its foot', () => {
    assert.equal(subsectionInView(tops(0), view(0, HEIGHT - 100)), 'link-menus')
  })
})

describe('nextHold', () => {
  const jump = to => ({ kind: 'jump', to })
  const PAGE_CONTROLS = { kind: 'subsection', id: 'page-controls', subsection: 'Page controls' }
  const held = (target, landedAt = null) => ({ target, landedAt })

  test('a jump to a sub-section holds the sub-section', () => {
    assert.deepEqual(nextHold(null, jump(PAGE_CONTROLS)), held('page-controls'))
  })

  test('a jump to a setting holds the sub-section it is in, by the sub-section\'s id', () => {
    assert.deepEqual(nextHold(null, jump({ kind: 'row', id: 'marks-status-work-marks', subsection: 'Marks & status' })), held('marks-status'))
  })

  test('a jump to a category holds its first sub-section, whichever is first when it lands', () => {
    assert.deepEqual(nextHold(null, jump({ kind: 'category', id: 'search', subsection: null })), held(null))
  })

  test('a later jump takes the place of an earlier one\'s hold, landed or not', () => {
    const next = jump({ kind: 'subsection', id: 'appearance', subsection: 'Appearance' })
    assert.deepEqual(nextHold(held('page-controls'), next), held('appearance'))
    assert.deepEqual(nextHold(held('page-controls', 860), next), held('appearance'))
  })

  test('a hash naming nothing holds nothing, and lets an earlier hold go', () => {
    assert.equal(nextHold(null, jump(null)), null)
    assert.equal(nextHold(held('page-controls', 860), jump(null)), null)
  })

  test('scrolling while the jump is under way keeps its hold', () => {
    const hold = held('page-controls')
    assert.equal(nextHold(hold, { kind: 'scrolled', scrollTop: 400 }), hold)
  })

  test('landing records where the page was left', () => {
    assert.deepEqual(nextHold(held('page-controls'), { kind: 'landed', scrollTop: 900 }), held('page-controls', 900))
  })

  test('scrolling away from where the jump left the page lets its hold go', () => {
    assert.equal(nextHold(held('page-controls', 900), { kind: 'scrolled', scrollTop: 860 }), null)
    assert.equal(nextHold(held('page-controls', 0), { kind: 'scrolled', scrollTop: 40 }), null)
  })

  test('a scroll that leaves the page where the jump left it keeps the hold, give or take the rounding of a scroll position', () => {
    const hold = held('page-controls', 900)
    assert.equal(nextHold(hold, { kind: 'scrolled', scrollTop: 900 }), hold)
    assert.equal(nextHold(hold, { kind: 'scrolled', scrollTop: 899.5 }), hold)
  })

  test('with nothing held, landing and scrolling hold nothing', () => {
    assert.equal(nextHold(null, { kind: 'landed', scrollTop: 900 }), null)
    assert.equal(nextHold(null, { kind: 'scrolled', scrollTop: 900 }), null)
  })
})

describe('markedSubsection', () => {
  const foot = SCROLL_HEIGHT - HEIGHT

  test('with nothing held, the sub-section in view', () => {
    for (const scrollTop of [0, 500, 860, foot])
      assert.equal(markedSubsection(null, tops(scrollTop), view(scrollTop)), subsectionInView(tops(scrollTop), view(scrollTop)), `at ${scrollTop}`)
  })

  test('a held sub-section, wherever the page is: the one a jump went to, though the foot would name another', () => {
    for (const scrollTop of [0, 500, foot])
      assert.equal(markedSubsection({ target: 'page-controls', landedAt: null }, tops(scrollTop), view(scrollTop)), 'page-controls', `at ${scrollTop}`)
  })

  test('a held category, its first sub-section', () => {
    assert.equal(markedSubsection({ target: null, landedAt: foot }, tops(foot), view(foot)), 'link-menus')
  })

  test('a held sub-section that isn\'t among those given, such as one a query hides, leaves it to the line', () => {
    const shown = tops(foot).filter(section => section.id !== 'page-controls')
    assert.equal(markedSubsection({ target: 'page-controls', landedAt: foot }, shown, view(foot)), 'appearance')
  })

  test('none with no sections, held or not', () => {
    assert.equal(markedSubsection({ target: null, landedAt: null }, [], view(0)), null)
    assert.equal(markedSubsection({ target: 'page-controls', landedAt: null }, [], view(0)), null)
  })
})
