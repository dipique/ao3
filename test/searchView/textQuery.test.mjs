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

describe('a quoted single word', () => {
  test('matches only as a whole word', () => {
    assert.equal(finds('high "school"', 'I went to school at central high'), true)
    assert.equal(finds('high "school"', 'I want to preschool at central high'), false)
    assert.equal(finds('"school"', 'schools'), false)
    assert.equal(finds('"school"', 'schoolhouse'), false)
  })

  test('finds a later whole word past an earlier word that only holds it', () => {
    assert.equal(finds('"school"', 'preschool, then school'), true)
  })

  test('stands at the start and end of the text, and beside punctuation', () => {
    for (const text of ['school', 'School.', '(school)', '"school"', 'school’s', 'after-school'])
      assert.equal(finds('"school"', text), true, text)
  })

  test('counts digits, accented letters and combining marks as part of a word', () => {
    assert.equal(finds('"tea"', 'tea2'), false)
    assert.equal(finds('"caf"', 'café'), false)
    assert.equal(finds('"cafe"', 'café'), false)
    assert.equal(finds('"café"', 'Le Café.'), true)
  })

  test('still finds a word in a script written without spaces', () => {
    assert.equal(finds('"学校"', '我的学校很大'), true)
    assert.equal(finds('"school"', '我的school很大'), true)
  })

  test('reads the same in curly quotes, unclosed, or with spaces inside the quotes', () => {
    for (const query of ['“school”', '"school', '" school "']) {
      assert.equal(finds(query, 'a school'), true, query)
      assert.equal(finds(query, 'a preschool'), false, query)
    }
  })

  test('works under NOT and OR', () => {
    assert.equal(finds('NOT "ron"', 'Aaron'), true)
    assert.equal(finds('NOT "ron"', 'Ron'), false)
    assert.equal(finds('"ron" OR "harry"', 'Aaron and Harry'), true)
    assert.equal(finds('"ron" OR "harry"', 'Aaron and Harrys'), false)
  })

  test('takes its punctuation literally', () => {
    assert.equal(finds('"(tv)"', 'Sherlock (TV)'), true)
    assert.equal(finds('"c++"', 'c++ code'), true)
    assert.equal(finds('"c++"', 'cc code'), false)
  })

  test('leaves unquoted words and quoted phrases matching inside words', () => {
    assert.equal(finds('school', 'preschool'), true)
    assert.equal(finds('"old hou"', 'the old house'), true)
    assert.equal(finds('"reschool at"', 'preschool at home'), true)
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

describe('a minus at the start of a term', () => {
  test('excludes it, as NOT does', () => {
    assert.equal(finds('fluff -angst', 'fluff'), true)
    assert.equal(finds('fluff -angst', 'fluff and angst'), false)
    assert.equal(queryKey(parseTextQuery('fluff -angst')), queryKey(parseTextQuery('fluff NOT angst')))
  })

  test('takes a phrase, a quoted word or a group', () => {
    assert.equal(finds('-"major character death"', 'a major death of a character'), true)
    assert.equal(finds('-"major character death"', 'major character death'), false)
    assert.equal(finds('-"ron"', 'Aaron'), true)
    assert.equal(finds('-"ron"', 'Ron'), false)
    assert.equal(finds('-(harry OR draco)', 'ron'), true)
    assert.equal(finds('-(harry OR draco)', 'draco'), false)
  })

  test('binds tighter than OR', () => {
    assert.equal(finds('-harry OR draco', 'harry and draco'), true)
    assert.equal(finds('-harry OR draco', 'harry'), false)
  })

  test('stays part of a word when it comes later in the word', () => {
    assert.equal(finds('slow-burn', 'a slow-burn romance'), true)
    assert.equal(finds('slow-burn', 'a slow burn romance'), false)
    assert.equal(finds('well-', 'well-known'), true)
  })

  test('on its own excludes nothing and is not looked for', () => {
    assert.equal(finds('fluff - angst', 'fluff and angst'), true)
    assert.equal(finds('fluff - angst', 'fluff - comfort'), false)
    assert.equal(finds('fluff -', 'fluff'), true)
    for (const query of ['-', ' - ', '--', '-()'])
      assert.equal(parseTextQuery(query), null, query)
  })

  test('in quotes is looked for as written', () => {
    assert.equal(finds('-chan', 'Sakura-chan'), false)
    assert.equal(finds('"-chan"', 'Sakura-chan'), true)
    assert.equal(finds('"-chan"', 'Sakura chan'), false)
    assert.equal(finds('"-chan"', 'Sakura-chans'), false)
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
  const texts = query => queryTerms(parseTextQuery(query)).map(term => term.text)

  test('lists the words and phrases outside a NOT, each once, in order', () => {
    assert.deepEqual(texts('Harry OR "the  old house" NOT draco harry'), ['harry', 'the old house'])
    assert.deepEqual(texts('tea NOT (dragon OR house)'), ['tea'])
  })

  test('counts a word under two NOTs as outside', () => {
    assert.deepEqual(texts('NOT NOT tea'), ['tea'])
  })

  test('keeps a word and the same word quoted apart, since they ask different things', () => {
    const terms = queryTerms(parseTextQuery('tea "tea"'))
    assert.deepEqual(terms.map(term => Boolean(term.wholeWord)), [false, true])
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
    assert.ok(same('tea Tea', 'tea'))
    assert.ok(same('"tea" “Tea”', '"tea"'))
  })

  test('differs for queries that ask different things', () => {
    assert.ok(!same('harry draco', 'harry OR draco'))
    assert.ok(!same('"harry draco"', 'harry draco'))
    assert.ok(!same('"tea"', 'tea'))
    assert.ok(!same('fluff harry OR draco', '(fluff harry) OR draco'))
    assert.ok(!same('NOT tea', 'tea'))
    assert.ok(!same('"tea or"', 'tea OR'))
  })

  test('is empty for no query', () => {
    assert.equal(queryKey(null), '')
    assert.equal(queryKey(parseTextQuery('  ')), '')
  })
})
