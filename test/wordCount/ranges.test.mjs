import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; wordCount.ts is pure (no `#common`, no
// `browser`, no DOM) and declares nothing that emits at runtime, so it loads
// with a plain `node --test`.
import {
  DEFAULT_WORD_COUNT_RANGES,
  duplicateOf,
  formatWordCountRange,
  isValidRange,
  normalizeBound,
  parseBoundInput,
  parseWordCountQuery,
  rangeError,
  sameRange,
  serializeWordCountQuery,
} from '../../src/common/wordCount.ts'

describe('rangeError', () => {
  test('accepts a normal range', () => {
    assert.equal(rangeError({ from: 1000, to: 3000 }), null)
  })

  test('accepts equal bounds (a single length)', () => {
    assert.equal(rangeError({ from: 1000, to: 1000 }), null)
  })

  test('accepts one-sided ranges', () => {
    assert.equal(rangeError({ from: 5000, to: null }), null)
    assert.equal(rangeError({ from: null, to: 2000 }), null)
  })

  test('rejects negative bounds', () => {
    assert.match(rangeError({ from: -1, to: 3000 }), /lower bound/)
    assert.match(rangeError({ from: 1000, to: -5 }), /upper bound/)
  })

  test('rejects non-integer bounds', () => {
    assert.notEqual(rangeError({ from: 1000.5, to: 3000 }), null)
  })

  test('rejects an upper bound below the lower one', () => {
    assert.match(rangeError({ from: 3000, to: 1000 }), /not be below/)
  })

  test('rejects a range with neither bound', () => {
    assert.match(rangeError({ from: null, to: null }), /at least one/)
  })

  test('isValidRange agrees', () => {
    assert.equal(isValidRange({ from: 1000, to: 3000 }), true)
    assert.equal(isValidRange({ from: 3000, to: 1000 }), false)
  })

  test('every shipped default is valid', () => {
    for (const range of DEFAULT_WORD_COUNT_RANGES)
      assert.equal(rangeError(range), null, `${JSON.stringify(range)} should be valid`)
  })
})

describe('duplicates', () => {
  const ranges = [
    { from: 1000, to: 3000 },
    { from: 1500, to: 5000 },
    { from: 1000, to: 3000 },
    { from: 2500, to: 10000 },
  ]

  test('finds an exact repeat', () => {
    assert.equal(duplicateOf(ranges, 2), 0)
    assert.equal(duplicateOf(ranges, 0), 2)
  })

  test('leaves merely overlapping ranges alone', () => {
    assert.equal(duplicateOf(ranges, 1), -1)
    assert.equal(duplicateOf(ranges, 3), -1)
  })

  test('a one-sided range only duplicates the same one-sided range', () => {
    const list = [{ from: 5000, to: null }, { from: 5000, to: 100000 }, { from: 5000, to: null }]
    assert.equal(duplicateOf(list, 0), 2)
    assert.equal(duplicateOf(list, 1), -1)
  })

  test('sameRange compares both bounds', () => {
    assert.equal(sameRange({ from: 1, to: 2 }, { from: 1, to: 2 }), true)
    assert.equal(sameRange({ from: 1, to: null }, { from: 1, to: 2 }), false)
  })
})

describe('bound parsing', () => {
  test('parseBoundInput: blank is unbounded, not an error', () => {
    assert.equal(parseBoundInput(''), null)
    assert.equal(parseBoundInput('   '), null)
  })

  test('parseBoundInput: digits and grouped digits parse', () => {
    assert.equal(parseBoundInput('1000'), 1000)
    assert.equal(parseBoundInput(' 25,000 '), 25000)
  })

  test('parseBoundInput: anything else is an error, not a silent null', () => {
    assert.equal(parseBoundInput('-5'), undefined)
    assert.equal(parseBoundInput('1.5'), undefined)
    assert.equal(parseBoundInput('lots'), undefined)
  })

  test('normalizeBound degrades bad stored values to unbounded', () => {
    assert.equal(normalizeBound('1000'), 1000)
    assert.equal(normalizeBound(1000), 1000)
    assert.equal(normalizeBound('12,500'), 12500)
    assert.equal(normalizeBound(''), null)
    assert.equal(normalizeBound(-1), null)
    assert.equal(normalizeBound(1.5), null)
    assert.equal(normalizeBound('nope'), null)
    assert.equal(normalizeBound(undefined), null)
  })
})

describe('formatting', () => {
  // The thousands separator is whatever the runtime's locale uses, so compare
  // against that same formatter rather than hard-coding commas.
  const n = value => new Intl.NumberFormat().format(value)

  test('two bounds read as a range', () => {
    const label = formatWordCountRange({ from: 1000, to: 3000 })
    assert.ok(label.includes(n(1000)), label)
    assert.ok(label.includes(n(3000)), label)
  })

  test('a lower bound alone reads as "n+"', () => {
    assert.equal(formatWordCountRange({ from: 5000, to: null }), `${n(5000)}+`)
  })

  test('an upper bound alone reads as "up to n"', () => {
    assert.equal(formatWordCountRange({ from: null, to: 2000 }), `up to ${n(2000)}`)
  })
})

describe('the advanced-search word_count field', () => {
  test('round-trips a two-sided range', () => {
    assert.equal(serializeWordCountQuery({ from: 1000, to: 5000 }), '1000-5000')
    assert.deepEqual(parseWordCountQuery('1000-5000'), { from: 1000, to: 5000 })
  })

  test('round-trips one-sided ranges', () => {
    assert.equal(serializeWordCountQuery({ from: 5000, to: null }), '>5000')
    assert.deepEqual(parseWordCountQuery('>5000'), { from: 5000, to: null })
    assert.equal(serializeWordCountQuery({ from: null, to: 2000 }), '<2000')
    assert.deepEqual(parseWordCountQuery('<2000'), { from: null, to: 2000 })
  })

  test('a single number is an exact length', () => {
    assert.equal(serializeWordCountQuery({ from: 1000, to: 1000 }), '1000')
    assert.deepEqual(parseWordCountQuery('1000'), { from: 1000, to: 1000 })
  })

  test('accepts the other spellings AO3 takes', () => {
    assert.deepEqual(parseWordCountQuery('1,000 to 5,000'), { from: 1000, to: 5000 })
    assert.deepEqual(parseWordCountQuery('>= 100'), { from: 100, to: null })
    assert.deepEqual(parseWordCountQuery('<=100'), { from: null, to: 100 })
  })

  test('blank or unmappable text is "no filter"', () => {
    assert.equal(parseWordCountQuery(''), null)
    assert.equal(parseWordCountQuery('   '), null)
    assert.equal(parseWordCountQuery('a lot'), null)
  })
})
