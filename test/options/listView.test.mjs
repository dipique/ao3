import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { capFor, cycleSort, filterRows, LIST_CAPS, MARK_ORDER_OFF, MARK_SORTS, markOrderOff, RULE_SORTS, rulePriorityCell, shownRules, sortHint, sortMarks, sortRows, sortState, UNSORTED } from '../../src/options_ui/model/listView.ts'

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

  test('priority sorts by number, both ways', () => {
    assert.deepEqual(order('priority'), ['Zebra', 'banana', 'apple', 'Mango'])
    assert.deepEqual(order('priority', 'desc'), ['Mango', 'apple', 'banana', 'Zebra'])
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
