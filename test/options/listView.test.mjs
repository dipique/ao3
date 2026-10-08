import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { capFor, cycleSort, filterRows, filterSavedLists, focusSuccessor, LIST_CAPS, MARK_ORDER_OFF, MARK_SORTS, markOrderOff, RULE_SORTS, rulePriorityCell, SAVED_LIST_SORTS, savedListsHead, shownRules, shownSavedLists, sortHint, sortMarks, sortRows, sortSavedLists, sortState, UNSORTED } from '../../src/options_ui/model/listView.ts'

const MARKS = [
  { id: 'read', label: 'Read', icon: 'Check' },
  { id: 'fav', label: 'Favorite', icon: 'Heart' },
  { id: 'cafe', label: 'Café AU', icon: 'Cup' },
  { id: 'gross', label: 'Gross', icon: 'Skull' },
]
const markText = mark => [mark.label, mark.icon]
const ids = rows => rows.map(row => row.id)

describe('filterRows', () => {
  test('a blank query keeps every row, in order', () => {
    assert.deepEqual(ids(filterRows(MARKS, '', markText)), ['read', 'fav', 'cafe', 'gross'])
    assert.deepEqual(ids(filterRows(MARKS, '   ', markText)), ['read', 'fav', 'cafe', 'gross'])
  })

  test('keeps the rows a term appears in, in their own order', () => {
    assert.deepEqual(ids(filterRows(MARKS, 'r', markText)), ['read', 'fav', 'gross'])
  })

  test('matches any of a row\'s texts', () => {
    assert.deepEqual(ids(filterRows(MARKS, 'heart', markText)), ['fav'])
    assert.deepEqual(ids(filterRows(MARKS, 'favorite', markText)), ['fav'])
  })

  test('every term must appear, in the same text or different ones', () => {
    assert.deepEqual(ids(filterRows(MARKS, 'fav heart', markText)), ['fav'])
    assert.deepEqual(ids(filterRows(MARKS, 'fav skull', markText)), [])
  })

  test('ignores case and accents, as the settings search does', () => {
    assert.deepEqual(ids(filterRows(MARKS, 'CAFE', markText)), ['cafe'])
    assert.deepEqual(ids(filterRows(MARKS, 'café', markText)), ['cafe'])
  })

  test('a term never matches across the end of one text and the start of the next', () => {
    // "Read" then "Check": "dc" is in "ReadCheck" but in neither text.
    assert.deepEqual(ids(filterRows(MARKS, 'dc', markText)), [])
  })

  test('leaves the rows it was given alone', () => {
    const rows = [...MARKS]
    filterRows(rows, 'gross', markText)
    assert.deepEqual(rows, MARKS)
  })
})

describe('sortRows', () => {
  const byLabel = (a, b) => a.label.localeCompare(b.label)
  const RULES = [
    { id: 'a', target: 'tag', value: 'Fluff' },
    { id: 'b', target: 'author', value: 'zed' },
    { id: 'c', target: 'tag', value: 'Angst' },
    { id: 'd', target: 'author', value: 'amy' },
    { id: 'e', target: 'tag', value: 'Crack' },
  ]
  const byTarget = (a, b) => a.target.localeCompare(b.target)
  const byValue = (a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base' })

  test('orders a copy of the rows, ascending by default', () => {
    const rows = [...MARKS]
    assert.deepEqual(ids(sortRows(rows, byLabel)), ['cafe', 'fav', 'gross', 'read'])
    assert.deepEqual(rows, MARKS, 'the rows given are left in their order')
  })

  test('descending reverses the order', () => {
    assert.deepEqual(ids(sortRows(MARKS, byLabel, { direction: 'desc' })), ['read', 'gross', 'fav', 'cafe'])
  })

  test('rows that tie keep the order they were given in, either way round', () => {
    assert.deepEqual(ids(sortRows(RULES, byTarget)), ['b', 'd', 'a', 'c', 'e'])
    assert.deepEqual(ids(sortRows(RULES, byTarget, { direction: 'desc' })), ['a', 'c', 'e', 'b', 'd'])
  })

  test('a tie-break settles ties, and stays ascending when the sort is reversed', () => {
    assert.deepEqual(ids(sortRows(RULES, byTarget, { then: byValue })), ['d', 'b', 'c', 'e', 'a'])
    assert.deepEqual(ids(sortRows(RULES, byTarget, { direction: 'desc', then: byValue })), ['c', 'e', 'a', 'd', 'b'])
  })
})

describe('capFor', () => {
  const rows = (count, height = 32) => Array.from({ length: count }).fill(height)

  test('a list inside a setting shows about seven rows, and one that is its section\'s point about twelve', () => {
    assert.deepEqual(LIST_CAPS, { setting: 7, section: 12 })
  })

  test('no height while the rows fit: the body is exactly as tall as its rows', () => {
    assert.equal(capFor('setting', []), null)
    assert.equal(capFor('setting', rows(2)), null)
    assert.equal(capFor('setting', rows(7)), null)
    assert.equal(capFor('section', rows(12)), null)
  })

  test('past the cap, the height of the first rows up to it', () => {
    assert.equal(capFor('setting', rows(8)), 7 * 32)
    assert.equal(capFor('setting', rows(40)), 7 * 32)
    assert.equal(capFor('section', rows(13)), 12 * 32)
  })

  test('counts rows, not pixels, so rows taller than one line still cap at the same number', () => {
    assert.equal(capFor('setting', [52, 52, 70, 52, 52, 52, 52, 52]), 52 * 6 + 70)
    assert.equal(capFor('setting', [32.5, 32.5, 32.5, 32.5, 32.5, 32.5, 32.5, 32.5]), 7 * 32.5)
  })
})

describe('sortMarks', () => {
  // In the reader's order, as the list is given them.
  const ROWS = [
    { id: 'read', label: 'Read', count: 2 },
    { id: 'fav', label: 'favorite', count: 3 },
    { id: 'good', label: 'Good', count: 0 },
    { id: 'eclair', label: 'Éclair', count: 0 },
    { id: 'gross', label: 'Gross', count: 1 },
    { id: 'continue', label: 'Ongoing', count: 4 },
  ]

  test('three sorts, your order first, which is where the list starts', () => {
    assert.deepEqual(MARK_SORTS, [
      { value: 'order', label: 'Your order' },
      { value: 'name', label: 'Name' },
      { value: 'works', label: 'Works' },
    ])
  })

  test('your order is the order the rows were given in', () => {
    assert.deepEqual(ids(sortMarks(ROWS, 'order')), ['read', 'fav', 'good', 'eclair', 'gross', 'continue'])
  })

  test('name runs A to Z, ignoring case and accents', () => {
    assert.deepEqual(ids(sortMarks(ROWS, 'name')), ['eclair', 'fav', 'good', 'gross', 'continue', 'read'])
  })

  test('works puts the most first, and marks holding as many keep your order', () => {
    assert.deepEqual(ids(sortMarks(ROWS, 'works')), ['continue', 'fav', 'read', 'gross', 'good', 'eclair'])
  })

  test('marks named alike keep your order', () => {
    const twins = [{ id: 'b', label: 'Same', count: 0 }, { id: 'a', label: 'same', count: 0 }]
    assert.deepEqual(ids(sortMarks(twins, 'name')), ['b', 'a'])
  })

  test('every sort leaves the rows it was given alone', () => {
    const rows = [...ROWS]
    for (const sort of ['order', 'name', 'works']) {
      const sorted = sortMarks(rows, sort)
      assert.notEqual(sorted, rows, `${sort} hands back a new array`)
      assert.deepEqual(rows, ROWS, `${sort} leaves the given order`)
    }
  })
})

describe('markOrderOff', () => {
  test('the order buttons work only in your order, and say why otherwise', () => {
    assert.equal(MARK_ORDER_OFF, 'Sort by your order to rearrange')
    assert.equal(markOrderOff('order'), null)
    assert.equal(markOrderOff('name'), MARK_ORDER_OFF)
    assert.equal(markOrderOff('works'), MARK_ORDER_OFF)
  })
})

describe('cycleSort', () => {
  test('a key pressed in turn sorts ascending, then descending, then not at all', () => {
    const once = cycleSort(UNSORTED, 'value')
    assert.deepEqual(once, { key: 'value', direction: 'asc' })
    const twice = cycleSort(once, 'value')
    assert.deepEqual(twice, { key: 'value', direction: 'desc' })
    assert.deepEqual(cycleSort(twice, 'value'), UNSORTED)
  })

  test('another key starts ascending, whichever way the last one pointed', () => {
    assert.deepEqual(cycleSort({ key: 'value', direction: 'asc' }, 'priority'), { key: 'priority', direction: 'asc' })
    assert.deepEqual(cycleSort({ key: 'value', direction: 'desc' }, 'priority'), { key: 'priority', direction: 'asc' })
  })

  test('leaves the sort it was given alone', () => {
    const sort = { key: 'value', direction: 'asc' }
    cycleSort(sort, 'value')
    assert.deepEqual(sort, { key: 'value', direction: 'asc' })
  })
})

describe('sortState and sortHint', () => {
  test('a key reads in aria-sort\'s terms', () => {
    assert.equal(sortState(UNSORTED, 'value'), 'none')
    assert.equal(sortState({ key: 'value', direction: 'asc' }, 'value'), 'ascending')
    assert.equal(sortState({ key: 'value', direction: 'desc' }, 'value'), 'descending')
    assert.equal(sortState({ key: 'value', direction: 'asc' }, 'priority'), 'none', 'only the key sorted by')
  })

  test('each key says what pressing it next does', () => {
    assert.equal(sortHint(UNSORTED, 'value'), 'Sort ascending')
    assert.equal(sortHint({ key: 'priority', direction: 'desc' }, 'value'), 'Sort ascending')
    assert.equal(sortHint({ key: 'value', direction: 'asc' }, 'value'), 'Sort descending')
    assert.equal(sortHint({ key: 'value', direction: 'desc' }, 'value'), 'Clear sort')
  })
})

describe('shownRules: the filter', () => {
  // Casing, a substring that isn't a prefix, a `.` and a `*` that must stay
  // literal, and a target and a pseud that must not be searched.
  const RULES = [
    { target: 'tag', value: 'Slow Burn', matcher: 'exact' },
    { target: 'tag', value: 'slow build', matcher: 'exact' },
    { target: 'tag', value: 'Enemies to Lovers', matcher: 'exact' },
    { target: 'f', value: 'Teen Wolf (TV)', matcher: 'exact' },
    { target: 'author', value: 'someone', pseud: 'BurnNotice', matcher: 'exact' },
    { target: 'tag', value: 'A.B.O. Dynamics', matcher: 'exact' },
    { target: 'tag', value: '5*Stars', matcher: 'exact' },
  ]
  const shown = query => shownRules(RULES, query, UNSORTED).map(at => RULES[at].value)

  test('a blank query shows every rule', () => {
    assert.equal(shown('').length, RULES.length)
    assert.equal(shown('   ').length, RULES.length)
  })

  test('ignores case, and matches anywhere in the rule\'s text', () => {
    assert.deepEqual(shown('SLOW'), ['slow build', 'Slow Burn'])
    assert.deepEqual(shown('lovers'), ['Enemies to Lovers'])
    assert.deepEqual(shown('  burn '), ['Slow Burn'], 'the query is trimmed')
  })

  test('the query is one piece of text, not words to find in any order', () => {
    assert.deepEqual(shown('to lovers'), ['Enemies to Lovers'])
    assert.deepEqual(shown('lovers enemies'), [])
  })

  test('neither the target nor an author\'s pseud is searched', () => {
    assert.deepEqual(shown('fandom'), [], 'Fandom is what one rule applies to, not what it says')
    assert.deepEqual(shown('BurnNotice'), [])
    assert.deepEqual(shown('someone'), ['someone'])
  })

  test('a dot and a star are themselves, not wildcards', () => {
    assert.deepEqual(shown('A.B.O'), ['A.B.O. Dynamics'])
    assert.deepEqual(shown('sl.w'), [])
    assert.deepEqual(shown('5*'), ['5*Stars'])
    assert.deepEqual(shown('slow*'), [])
  })

  test('hands back each shown rule\'s place in the list it was given', () => {
    assert.deepEqual(shownRules(RULES, 'slow', UNSORTED), [1, 0])
  })
})

describe('shownRules: the sort', () => {
  // Each key orders these differently, so no order could come from sorting by
  // the wrong one. Targets are stored codes: Additional Tags is 'F', Fandom 'f'.
  const RULES = [
    { target: 'F', value: 'Zebra', matcher: 'exact', behavior: 'hide' },
    { target: 'f', value: 'apple', matcher: 'exact', behavior: 'invert' },
    { target: 'author', value: 'Mango', matcher: 'exact', behavior: 'highlight', priority: 7 },
    { target: 'series', value: 'banana', matcher: 'exact', behavior: 'hideFilter', priority: 2 },
  ]
  const order = (key, direction = 'asc', query = '', rules = RULES) =>
    shownRules(rules, query, key ? { key, direction } : UNSORTED).map(at => rules[at].value)

  test('four keys: action, priority, the rule\'s text, and what it applies to', () => {
    assert.deepEqual(RULE_SORTS, [
      { value: 'behavior', label: 'Action' },
      { value: 'priority', label: 'Priority' },
      { value: 'value', label: 'Rule' },
      { value: 'target', label: 'Applies to' },
    ])
  })

  test('unsorted, rules are grouped by their stored target, then by text', () => {
    assert.deepEqual(order(null), ['Mango', 'apple', 'Zebra', 'banana'])
  })

  test('the rule\'s text sorts ignoring case, both ways', () => {
    assert.deepEqual(order('value'), ['apple', 'banana', 'Mango', 'Zebra'])
    assert.deepEqual(order('value', 'desc'), ['Zebra', 'Mango', 'banana', 'apple'])
  })

  test('priority sorts by number, both ways, with the rules that show none after', () => {
    assert.deepEqual(order('priority'), ['Zebra', 'apple', 'Mango', 'banana'])
    assert.deepEqual(order('priority', 'desc'), ['apple', 'Zebra', 'Mango', 'banana'])
  })

  test('the rules that show no priority keep the list\'s own order among themselves, whichever way the sort points', () => {
    // Highlight and hide-tag rules show "–", whatever number they store. The
    // list's own order (by target, then text) differs here from the stored
    // order, from the text's, and from the stored numbers'.
    const mixed = [
      { target: 'tag', value: 'apple', matcher: 'exact', behavior: 'highlight', priority: 9 },
      { target: 'author', value: 'cherry', matcher: 'exact', behavior: 'hideFilter', priority: 1 },
      { target: 'tag', value: 'Banana', matcher: 'exact', behavior: 'hide', priority: 5 },
      { target: 'author', value: 'banana', matcher: 'exact', behavior: 'highlight' },
      { target: 'tag', value: 'date', matcher: 'exact', behavior: 'invert' },
    ]
    assert.deepEqual(order(null, 'asc', '', mixed).filter(value => ['apple', 'cherry', 'banana'].includes(value)), ['banana', 'cherry', 'apple'])
    assert.deepEqual(order('priority', 'asc', '', mixed), ['date', 'Banana', 'banana', 'cherry', 'apple'])
    assert.deepEqual(order('priority', 'desc', '', mixed), ['Banana', 'date', 'banana', 'cherry', 'apple'])
  })

  test('what a rule applies to sorts by the name shown, not the stored code', () => {
    assert.deepEqual(order('target'), ['Zebra', 'Mango', 'apple', 'banana'])
    assert.deepEqual(order('target', 'desc'), ['banana', 'apple', 'Mango', 'Zebra'])
  })

  test('action sorts by effect, strongest first, with a disabled rule last', () => {
    assert.deepEqual(order('behavior'), ['Zebra', 'apple', 'Mango', 'banana'])
    assert.deepEqual(order('behavior', 'desc'), ['banana', 'Mango', 'apple', 'Zebra'])
    const more = [
      { target: 'tag', value: 'off', matcher: 'exact', behavior: 'none' },
      { target: 'tag', value: 'shown', matcher: 'exact', behavior: 'invert' },
      { target: 'tag', value: 'squeezed', matcher: 'exact', behavior: 'collapse' },
      { target: 'tag', value: 'plain', matcher: 'exact' },
    ]
    assert.deepEqual(order('behavior', 'asc', '', more), ['plain', 'squeezed', 'shown', 'off'], 'a rule with no behaviour hides')
  })

  test('ties go to the rule\'s text, ascending whichever way the sort points', () => {
    const tied = [
      { target: 'tag', value: 'b', matcher: 'exact' },
      { target: 'tag', value: 'C', matcher: 'exact', priority: 5 },
      { target: 'tag', value: 'A', matcher: 'exact' },
    ]
    assert.deepEqual(order('priority', 'asc', '', tied), ['A', 'b', 'C'])
    assert.deepEqual(order('priority', 'desc', '', tied), ['C', 'A', 'b'])
  })

  test('a target this build doesn\'t know sorts without breaking the list', () => {
    const odd = [...RULES, { target: 'zz', value: 'odd', matcher: 'exact' }]
    assert.equal(order('target', 'asc', '', odd).length, odd.length)
  })

  test('the sort runs over what the filter leaves', () => {
    assert.deepEqual(order('value', 'asc', 'an'), ['banana', 'Mango'])
    assert.deepEqual(order('value', 'desc', 'an'), ['Mango', 'banana'])
  })
})

describe('rulePriorityCell', () => {
  const rule = props => ({ target: 'tag', value: 'x', matcher: 'exact', ...props })

  test('a priority its action gives it is plain, and says it is the default', () => {
    assert.deepEqual(rulePriorityCell(rule({})), { text: '0', title: 'Priority 0 (default)', custom: false })
    assert.deepEqual(rulePriorityCell(rule({ behavior: 'invert' })), { text: '4', title: 'Priority 4 (default)', custom: false })
  })

  test('a priority of the rule\'s own stands out, and says what it does', () => {
    assert.deepEqual(rulePriorityCell(rule({ priority: 6 })), {
      text: '6',
      title: 'Priority 6: beats lower-priority rules that match the same work',
      custom: true,
    })
    assert.equal(rulePriorityCell(rule({ behavior: 'invert', priority: 2 })).custom, true)
  })

  test('highlight and hide-tag rules show none, since they never contest a work', () => {
    assert.deepEqual(rulePriorityCell(rule({ behavior: 'highlight', priority: 7 })), {
      text: '–',
      title: 'Highlight rules have no priority: they never conflict with other rules',
      custom: false,
    })
    assert.deepEqual(rulePriorityCell(rule({ behavior: 'hideFilter' })), {
      text: '–',
      title: 'Hide-tag rules have no priority: they never conflict with other rules',
      custom: false,
    })
  })

  test('a disabled rule shows the priority it keeps for when it is on again', () => {
    assert.deepEqual(rulePriorityCell(rule({ behavior: 'none' })), {
      text: '0',
      title: 'Priority 0, kept while the rule is disabled',
      custom: false,
    })
    assert.deepEqual(rulePriorityCell(rule({ behavior: 'none', priority: 4 })), {
      text: '4',
      title: 'Priority 4, kept while the rule is disabled',
      custom: true,
    })
  })
})

/** A saved list's row, as `savedListRows` makes one: only what the frame reads. */
const savedRow = (id, title, fields = {}) => ({ id, title, placeholder: title, kind: 'Works search', status: 'saved', pending: null, caching: { kind: 'none' }, ...fields })
const copyAt = scrapedAt => ({ kind: 'copy', key: `k${scrapedAt}`, scrapedAt, unstored: 0, buckets: { total: 1, cached: 0, failed: 0, unfetched: 1, bytes: 0, staleFailures: 0 } })

const DRACO = savedRow('dr4c0', 'Mostly Draco', { type: 'Character', typeTip: 'Character: Draco Malfoy', kind: 'Filtered listing', status: 'tracked', caching: copyAt(3_000) })
const TEA = savedRow('t3a', 'Search: tea', { type: 'Search', typeTip: 'Search: tea', caching: copyAt(5_000) })
const CAFE = savedRow('c4fe', 'café AUs', { type: 'Tag', typeTip: 'Tag: Coffee Shop AU', kind: 'Uncommon tag', status: 'tracked' })
const SERIES = savedRow('s3r', 'the Long Haul', { type: 'Series', typeTip: 'Series: The Long Haul', kind: 'Series', caching: copyAt(1_000) })
/** A stored list no visit has described: a row by its raw key, with no record to track. */
const OLD = savedRow('copy:tag-works:Old%20Tag', 'tag-works:Old%20Tag', { placeholder: '', kind: undefined, pending: 'needs-visit', caching: copyAt(500) })
/** Tracked, at an address that isn't the archive's, with no title of its own: its URL's tail stands in. */
const BROKEN = savedRow('br0', '', { placeholder: 'https://example.com/tags/x', kind: 'Uncommon tag', status: 'tracked', pending: 'not-archive' })
const SAVED_ROWS = [DRACO, TEA, CAFE, SERIES, OLD, BROKEN]

describe('filterSavedLists', () => {
  test('a blank query keeps every list, in order', () => {
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, ' ')), ids(SAVED_ROWS))
  })

  test('finds a list by its title, what it is of, what kind of search it is, or the tag or name it searches', () => {
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'mostly')), ['dr4c0'])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'character')), ['dr4c0'])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'uncommon')), ['c4fe', 'br0'])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'malfoy')), ['dr4c0'])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'coffee shop')), ['c4fe'])
  })

  test('nothing else about a list is matched: not whether it is tracked', () => {
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'tracked')), [])
  })

  test('every term must appear, ignoring case and accents, as the settings search reads them', () => {
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'draco listing')), ['dr4c0'])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'draco series')), [])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'CAFE')), ['c4fe'])
  })

  test('a raw key is a list\'s name, and so is what stands in for a missing title', () => {
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'old%20tag')), ['copy:tag-works:Old%20Tag'])
    assert.deepEqual(ids(filterSavedLists(SAVED_ROWS, 'example')), ['br0'])
  })
})

describe('sortSavedLists', () => {
  test('offers Name, Status and Last refreshed, Name first, as the default', () => {
    assert.deepEqual(SAVED_LIST_SORTS, [
      { value: 'name', label: 'Name' },
      { value: 'status', label: 'Status' },
      { value: 'refreshed', label: 'Last refreshed' },
    ])
  })

  test('Name: A to Z by what each is called, ignoring case and accents', () => {
    assert.deepEqual(ids(sortSavedLists(SAVED_ROWS, 'name')), ['c4fe', 'br0', 'dr4c0', 't3a', 'copy:tag-works:Old%20Tag', 's3r'])
  })

  test('Status: tracked, then saved, then every list waiting on the reader, by name within each', () => {
    assert.deepEqual(ids(sortSavedLists(SAVED_ROWS, 'status')), ['c4fe', 'dr4c0', 't3a', 's3r', 'br0', 'copy:tag-works:Old%20Tag'])
  })

  test('Last refreshed: the newest offline copy first, and the lists with none last, by name', () => {
    assert.deepEqual(ids(sortSavedLists(SAVED_ROWS, 'refreshed')), ['t3a', 'dr4c0', 's3r', 'copy:tag-works:Old%20Tag', 'c4fe', 'br0'])
  })

  test('leaves the rows it was given alone', () => {
    const rows = [...SAVED_ROWS]
    sortSavedLists(rows, 'status')
    assert.deepEqual(rows, SAVED_ROWS)
  })
})

describe('shownSavedLists', () => {
  test('the lists the filter keeps, in the order the sort puts them', () => {
    assert.deepEqual(ids(shownSavedLists(SAVED_ROWS, { query: 'tag', sort: 'refreshed', hold: null })), ['copy:tag-works:Old%20Tag', 'c4fe', 'br0'])
    assert.deepEqual(ids(shownSavedLists(SAVED_ROWS, { query: '', sort: 'status', hold: null })), ids(sortSavedLists(SAVED_ROWS, 'status')))
  })

  test('while a title has focus, the rows hold the order they had, whatever the sort', () => {
    const hold = { order: ['s3r', 't3a', 'dr4c0', 'c4fe', 'br0', 'copy:tag-works:Old%20Tag'], focused: 't3a' }
    assert.deepEqual(ids(shownSavedLists(SAVED_ROWS, { query: '', sort: 'name', hold })), hold.order)
    assert.deepEqual(ids(shownSavedLists(SAVED_ROWS, { query: '', sort: 'status', hold })), hold.order)
  })

  test('a list that arrives while the order is held goes at the end, in the sort\'s order', () => {
    const hold = { order: ['t3a', 'dr4c0'], focused: 't3a' }
    assert.deepEqual(ids(shownSavedLists(SAVED_ROWS, { query: '', sort: 'name', hold })), ['t3a', 'dr4c0', 'c4fe', 'br0', 'copy:tag-works:Old%20Tag', 's3r'])
  })

  test('the filter never hides the list whose title has focus', () => {
    const hold = { order: ids(SAVED_ROWS), focused: 't3a' }
    assert.deepEqual(ids(shownSavedLists(SAVED_ROWS, { query: 'draco', sort: 'name', hold })), ['dr4c0', 't3a'])
  })
})

describe('savedListsHead', () => {
  test('with no lists: none yet', () => {
    assert.deepEqual(savedListsHead([], [], ''), { count: 'none yet', shortCount: 'none yet', placeholder: 'Filter lists' })
  })

  test('how many lists, how many of them are tracked, and how many have an offline copy', () => {
    assert.deepEqual(savedListsHead(SAVED_ROWS, SAVED_ROWS, ''), { count: '6 lists · 3 tracked · 4 cached', shortCount: '6', placeholder: 'Filter 6 lists' })
    assert.deepEqual(savedListsHead([TEA], [TEA], ''), { count: '1 list · 0 tracked · 1 cached', shortCount: '1', placeholder: 'Filter 1 list' })
  })

  test('while the filter holds a query, how many lists it shows', () => {
    const shown = filterSavedLists(SAVED_ROWS, 'tag')
    assert.deepEqual(savedListsHead(SAVED_ROWS, shown, 'tag'), { count: '3 of 6', shortCount: '3 of 6', placeholder: 'Filter 6 lists' })
    assert.deepEqual(savedListsHead(SAVED_ROWS, [], 'nothing'), { count: '0 of 6', shortCount: '0 of 6', placeholder: 'Filter 6 lists' })
    assert.deepEqual(savedListsHead(SAVED_ROWS, SAVED_ROWS, '  '), savedListsHead(SAVED_ROWS, SAVED_ROWS, ''), 'spaces are no query')
  })
})

describe('focusSuccessor', () => {
  test('a row that goes hands focus to the one that takes its place: the next', () => {
    assert.equal(focusSuccessor(['a', 'b', 'c'], ['a', 'c'], 'b'), 'c')
    assert.equal(focusSuccessor(['a', 'b', 'c'], ['b', 'c'], 'a'), 'b')
  })

  test('the last row hands it back to the row before', () => {
    assert.equal(focusSuccessor(['a', 'b', 'c'], ['a', 'b'], 'c'), 'b')
  })

  test('a row replaced where it stood hands it to its replacement', () => {
    assert.equal(focusSuccessor(['a', 'copy:k', 'c'], ['a', 'n3w', 'c'], 'copy:k'), 'n3w')
  })

  test('with no rows left, to none', () => {
    assert.equal(focusSuccessor(['a'], [], 'a'), null)
  })

  test('a row the old order never had hands it to the first', () => {
    assert.equal(focusSuccessor(['a', 'b'], ['a', 'b'], 'x'), 'a')
    assert.equal(focusSuccessor(undefined, ['a', 'b'], 'x'), 'a')
  })
})
