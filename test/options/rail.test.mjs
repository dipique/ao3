import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildRail, landingCategory } from '../../src/options_ui/model/rail.ts'

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
    const lists = byId(buildRail(rows, ['Lists'], '', 'lists', ['Review', 'Saved lists', 'Offline reading'])).lists
    assert.deepEqual(lists.subsections.map(s => [s.id, s.count]), [['review', 1], ['saved-lists', 1], ['offline-reading', 1]])
  })

  test('a sub-section the order leaves out comes after the others, in the order its rows come', () => {
    const reading = byId(buildRail(ROWS, ORDER, '', 'reading', ['Work text'])).reading
    assert.deepEqual(reading.subsections.map(s => s.id), ['work-text', 'marks-status'])
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
