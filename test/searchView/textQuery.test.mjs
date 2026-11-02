import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; textQuery.ts is pure (no imports at all),
// so it loads with a plain `node --test`.
import {
  foldText,
  parseTextQuery,
  queryKey,
  queryMatches,
  queryTerms,
} from '../../src/content_script/searchView/textQuery.ts'

/** Whether `query` finds `text`, both folded as a search box folds them. */
function finds(query, text) {
  return queryMatches(parseTextQuery(query), foldText(text))
}

describe('foldText', () => {
  test('lowercases and straightens curly quotes without changing the length', () => {
    const plain = 'Don’t say “Hello”'
    const folded = foldText(plain)
    assert.equal(folded, 'don\'t say "hello"')
    assert.equal(folded.length, plain.length)
  })
})

describe('words and phrases', () => {
  const text = 'The dragon drank tea in the old house.'

  test('every word has to appear, in any case', () => {
    assert.equal(finds('Dragon   TEA', text), true)
    assert.equal(finds('dragon coffee', text), false)
  })

  test('words match inside words', () => {
    assert.equal(finds('rag', text), true)
  })

  test('a quoted phrase has to appear as written, its inner spaces collapsed', () => {
    assert.equal(finds('"the  old house"', text), true)
    assert.equal(finds('"the house"', text), false)
    assert.equal(finds('"house the"', 'the house'), false)
  })

  test('curly quotes delimit a phrase too, as a phone keyboard types them', () => {
    assert.equal(finds('“The Old House”', text), true)
    assert.equal(finds('“the house”', text), false)
  })

  test('an apostrophe stays inside its word, curly or not', () => {
    assert.equal(finds('don’t', 'I don\'t know'), true)
    assert.equal(finds('don\'t', 'I don’t know'), true)
  })

  test('an unclosed quote runs to the end', () => {
    assert.equal(finds('tea "the old', text), true)
    assert.equal(finds('tea "old the', text), false)
  })
})

describe('OR', () => {
  test('either side will do, spelled OR or ||', () => {
    for (const query of ['harry OR draco', 'harry || draco', 'harry||draco']) {
      assert.equal(finds(query, 'draco'), true, query)
      assert.equal(finds(query, 'harry'), true, query)
      assert.equal(finds(query, 'ron'), false, query)
    }
  })

  test('chains over any number of choices', () => {
    assert.equal(finds('harry OR draco OR ron', 'ron'), true)
    assert.equal(finds('harry OR draco OR ron', 'hermione'), false)
  })

  test('binds tighter than the words around it', () => {
    assert.equal(finds('fluff harry OR draco', 'fluff with draco'), true)
    assert.equal(finds('fluff harry OR draco', 'angst with draco'), false)
    assert.equal(finds('harry OR draco fluff', 'angst with harry'), false)
  })

  test('works between phrases', () => {
    assert.equal(finds('"slow burn" OR "enemies to lovers"', 'enemies to lovers, eventually'), true)
    assert.equal(finds('"slow burn" OR "enemies to lovers"', 'lovers to enemies'), false)
  })
})

describe('NOT', () => {
  test('drops what holds the word', () => {
    assert.equal(finds('fluff NOT angst', 'fluff'), true)
    assert.equal(finds('fluff NOT angst', 'fluff and angst'), false)
  })

  test('on its own, keeps everything without the word', () => {
    assert.equal(finds('NOT angst', 'fluff'), true)
    assert.equal(finds('NOT angst', 'angst'), false)
  })

  test('takes the one word or group after it', () => {
    assert.equal(finds('NOT harry draco', 'draco'), true)
    assert.equal(finds('NOT harry draco', 'harry and draco'), false)
    assert.equal(finds('NOT (harry OR draco)', 'ron'), true)
    assert.equal(finds('NOT (harry OR draco)', 'draco'), false)
  })

  test('binds tighter than OR', () => {
    assert.equal(finds('NOT harry OR draco', 'harry and draco'), true)
    assert.equal(finds('NOT harry OR draco', 'ron'), true)
    assert.equal(finds('NOT harry OR draco', 'harry'), false)
  })

  test('drops a phrase only where it appears as written', () => {
    assert.equal(finds('NOT "major character death"', 'a major death of a character'), true)
    assert.equal(finds('NOT "major character death"', 'major character death'), false)
  })

  test('twice cancels out', () => {
    assert.equal(finds('NOT NOT angst', 'angst'), true)
    assert.equal(finds('NOT NOT angst', 'fluff'), false)
  })
})

describe('parentheses', () => {
  test('group what they hold', () => {
    const query = '(fluff OR crack) (harry OR draco)'
    assert.equal(finds(query, 'crack with harry'), true)
    assert.equal(finds(query, 'crack with ron'), false)
    assert.equal(finds(query, 'angst with harry'), false)
  })

  test('let words outrank OR', () => {
    assert.equal(finds('(fluff harry) OR draco', 'angst with draco'), true)
    assert.equal(finds('(fluff harry) OR draco', 'angst with harry'), false)
  })

  test('nest', () => {
    const query = 'tea (dragon OR (old NOT house))'
    assert.equal(finds(query, 'tea with an old friend'), true)
    assert.equal(finds(query, 'tea in the old house'), false)
    assert.equal(finds(query, 'tea in the old house with a dragon'), true)
  })

  test('around a tag\'s own words still find the tag', () => {
    assert.equal(finds('sherlock (tv)', 'Sherlock (TV)'), true)
    assert.equal(finds('"sherlock (tv)"', 'Sherlock (TV)'), true)
    assert.equal(finds('"sherlock (tv)"', 'Sherlock Holmes (TV)'), false)
  })
})

describe('operators', () => {
  test('count only in capitals; in lower case they are words', () => {
    assert.equal(finds('harry or draco', 'harry or draco'), true)
    assert.equal(finds('harry or draco', 'harry draco'), false)
    assert.equal(finds('not', 'Creator Chose Not To Use Archive Warnings'), true)
    assert.equal(finds('not', 'No Archive Warnings Apply'), false)
  })

  test('inside quotes are words', () => {
    assert.equal(finds('"harry OR draco"', 'harry or draco'), true)
    assert.equal(finds('"harry OR draco"', 'draco'), false)
    assert.equal(finds('"NOT angst"', 'not angst'), true)
  })
})

describe('a query typed part-way', () => {
  test('reads what it has so far', () => {
    for (const [query, kept, dropped] of [
      ['(fluff OR', 'fluff', 'angst'],
      ['fluff OR', 'fluff', 'angst'],
      ['OR fluff', 'fluff', 'angst'],
      ['fluff NOT', 'fluff', 'angst'],
      ['fluff (', 'fluff', 'angst'],
      [')fluff(', 'fluff', 'angst'],
      ['fluff ) angst', 'fluff angst', 'fluff'],
      ['(fluff OR) angst', 'fluff angst', 'fluff'],
      ['fluff OR OR angst', 'angst', 'crack'],
      ['NOT OR fluff', 'angst', 'fluff'],
    ]) {
      assert.equal(finds(query, kept), true, `${query} should find "${kept}"`)
      assert.equal(finds(query, dropped), false, `${query} should not find "${dropped}"`)
    }
  })

  test('with nothing to look for yet, is no query, which finds everything', () => {
    for (const query of ['', '   ', '""', '   ""  " " ', '()', '( )', 'NOT', 'OR', '||', '(NOT)', ')(']) {
      assert.equal(parseTextQuery(query), null, JSON.stringify(query))
      assert.equal(finds(query, 'anything'), true, JSON.stringify(query))
    }
  })
})

describe('queryTerms', () => {
  test('lists the words and phrases outside a NOT, each once, in order', () => {
    assert.deepEqual(queryTerms(parseTextQuery('Harry OR "the  old house" NOT draco harry')), ['harry', 'the old house'])
    assert.deepEqual(queryTerms(parseTextQuery('tea NOT (dragon OR house)')), ['tea'])
  })

  test('counts a word under two NOTs as outside', () => {
    assert.deepEqual(queryTerms(parseTextQuery('NOT NOT tea')), ['tea'])
  })

  test('nothing for a query of exclusions only, or no query', () => {
    assert.deepEqual(queryTerms(parseTextQuery('NOT dragon')), [])
    assert.deepEqual(queryTerms(null), [])
  })
})

describe('queryKey', () => {
  const same = (a, b) => queryKey(parseTextQuery(a)) === queryKey(parseTextQuery(b))

  test('is the same for queries that differ only in spacing, case or spelling', () => {
    assert.ok(same('Harry  OR draco', 'harry||DRACO'))
    assert.ok(same('(harry OR draco)', 'harry OR draco'))
    assert.ok(same('tea (dragon house)', 'tea dragon house'))
    assert.ok(same('“The Old House”', '"the old house"'))
  })

  test('is the same when a word is repeated', () => {
    assert.ok(same('tea Tea "tea"', 'tea'))
  })

  test('differs for queries that ask different things', () => {
    assert.ok(!same('harry draco', 'harry OR draco'))
    assert.ok(!same('"harry draco"', 'harry draco'))
    assert.ok(!same('fluff harry OR draco', '(fluff harry) OR draco'))
    assert.ok(!same('NOT tea', 'tea'))
    assert.ok(!same('"tea or"', 'tea OR'))
  })

  test('is empty for no query', () => {
    assert.equal(queryKey(null), '')
    assert.equal(queryKey(parseTextQuery('  ')), '')
  })
})
