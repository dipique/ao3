import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// Node strips the TS types on import; textSearch.ts is pure (no `#common`, no
// `browser`, no DOM, nothing but the pure textQuery.ts), so it loads with a
// plain `node --test`.
import { foldText, parseTextQuery, queryTerms } from '../../src/content_script/searchView/textQuery.ts'
import {
  createWorkTextSearcher,
  describeTextSearch,
  NOTHING_TO_SEARCH,
  textSnippet,
  workTextOf,
} from '../../src/content_script/searchView/textSearch.ts'
import { figures, mentions } from '../facts.mjs'

/** A stored work as the sanitizer writes one: the meta block, then the work's own text. */
function storedWork(body, meta = '<dl class="work meta group"><dt class="words">Words:</dt><dd class="words">5,000</dd></dl>') {
  return `<div class="ao3e-work" data-ao3e-work-id="1">${meta}<div id="workskin"><div class="preface group"><h2 class="title heading">A Title</h2></div><div id="chapters"><div class="userstuff">${body}</div></div></div></div>`
}

describe('workTextOf', () => {
  test('keeps the work and leaves the meta block behind', () => {
    const text = workTextOf(storedWork('<p>Once upon a time.</p>'))
    assert.equal(text, 'A Title Once upon a time.')
  })

  test('falls back to the whole markup when there is no #workskin', () => {
    assert.equal(workTextOf('<p>Just a paragraph.</p>'), 'Just a paragraph.')
  })

  test('block boundaries separate words, inline tags do not', () => {
    const text = workTextOf(storedWork('<p>end</p><p>start</p>line<br>break <em>em</em>phasis<hr>after'))
    assert.match(text, /end start line break emphasis after$/)
  })

  test('decodes entities after the tags are gone, so escaped markup stays text', () => {
    const text = workTextOf(storedWork('<p>&lt;b&gt;not bold&lt;/b&gt; &amp; Tom&#39;s &#x201C;quote&#x201D;&nbsp;here &bogus;</p>'))
    assert.match(text, /<b>not bold<\/b> & Tom's “quote” here &bogus;$/)
  })

  test('drops comments, and a > inside a quoted attribute does not end the tag', () => {
    const text = workTextOf(storedWork('<!--updated_at=1 > 0--><p title="a > b">inside</p>'))
    assert.match(text, /A Title inside$/)
  })

  test('collapses every run of whitespace, non-breaking spaces included', () => {
    assert.equal(workTextOf('<p>  one \n\n two  three\t</p>'), 'one two three')
  })
})

describe('textSnippet', () => {
  const plain = 'One two three four five six seven eight nine ten. The Dragon drank tea. Eleven twelve thirteen fourteen fifteen.'
  const terms = query => queryTerms(parseTextQuery(query))

  test('centres on the earliest match, in the text\'s own case, clipped at word boundaries', () => {
    const snippet = textSnippet(plain, terms('tea dragon'), 20)
    assert.equal(snippet.match, 'Dragon')
    assert.equal(snippet.before, 'eight nine ten. The ')
    assert.equal(snippet.after, ' drank tea. Eleven')
    assert.equal(snippet.clippedStart, true)
    assert.equal(snippet.clippedEnd, true)
  })

  test('a match near the start is not clipped there', () => {
    const snippet = textSnippet(plain, terms('two'), 20)
    assert.equal(snippet.before, 'One ')
    assert.equal(snippet.clippedStart, false)
  })

  test('a whole short text comes back unclipped', () => {
    const snippet = textSnippet('Tea time.', terms('time'), 40)
    assert.deepEqual(snippet, { before: 'Tea ', match: 'time', after: '.', clippedStart: false, clippedEnd: false })
  })

  test('a curly apostrophe in the text answers a straight one in the query', () => {
    const snippet = textSnippet('I don’t know.', terms('don\'t'), 40)
    assert.equal(snippet.match, 'don’t')
  })

  test('a quoted word centres on where it stands whole, past a word that only holds it', () => {
    const snippet = textSnippet('Preschool first, then school.', terms('"school"'), 40)
    assert.equal(snippet.match, 'school')
    assert.equal(snippet.before, 'Preschool first, then ')
  })

  test('null when nothing matches', () => {
    assert.equal(textSnippet(plain, terms('coffee')), null)
    assert.equal(textSnippet('A preschool.', terms('"school"')), null)
  })
})

/** A source over a fixed library, counting what it was asked to load. */
function library(works) {
  const loads = []
  return {
    loads,
    has: id => id in works,
    load: async (ids) => {
      loads.push([...ids])
      const out = {}
      for (const id of ids) {
        if (typeof works[id] === 'string')
          out[id] = works[id]
      }
      return out
    },
  }
}

const WORKS = {
  1: storedWork('<p>The dragon drank tea.</p>'),
  2: storedWork('<p>A quiet house by the sea.</p>'),
  3: storedWork('<p>Tea with the dragon, again.</p>'),
  // Listed as saved, but the copy can't be read.
  4: null,
}

describe('createWorkTextSearcher', () => {
  test('finds the works whose text holds every term', async () => {
    const source = library(WORKS)
    const searcher = createWorkTextSearcher(source)
    const result = await searcher.search(['1', '2', '3'], 'dragon tea')
    assert.deepEqual([...result.hits].sort(), ['1', '3'])
    assert.equal(result.searched, 3)
    assert.equal(result.unavailable, 0)
  })

  test('reads OR, NOT and parentheses', async () => {
    const searcher = createWorkTextSearcher(library(WORKS))
    const hits = async query => [...(await searcher.search(['1', '2', '3'], query)).hits].sort()
    assert.deepEqual(await hits('sea OR again'), ['2', '3'])
    assert.deepEqual(await hits('tea NOT again'), ['1'])
    assert.deepEqual(await hits('NOT dragon'), ['2'])
    assert.deepEqual(await hits('(sea OR again) tea'), ['3'])
  })

  test('a quoted word finds only the works that hold it whole', async () => {
    const searcher = createWorkTextSearcher(library({
      1: storedWork('<p>I went to school at central high.</p>'),
      2: storedWork('<p>I want to preschool at central high.</p>'),
    }))
    const hits = async query => [...(await searcher.search(['1', '2'], query)).hits].sort()
    assert.deepEqual(await hits('high "school"'), ['1'])
    assert.deepEqual(await hits('high school'), ['1', '2'])
  })

  test('quoting a word asks for a new snippet of the same work', async () => {
    const searcher = createWorkTextSearcher(library({ 1: storedWork('<p>Preschool first, then school.</p>') }))
    assert.match((await searcher.snippet('1', 'school')).before, /Pre$/)
    assert.match((await searcher.snippet('1', '"school"')).before, /then $/)
  })

  test('a work with no saved text is counted, not loaded', async () => {
    const source = library(WORKS)
    const searcher = createWorkTextSearcher(source)
    const result = await searcher.search(['1', '9'], 'dragon')
    assert.deepEqual([...result.hits], ['1'])
    assert.equal(result.searched, 1)
    assert.equal(result.unavailable, 1)
    assert.deepEqual(source.loads.flat(), ['1'])
  })

  test('a saved copy that can\'t be read counts as unavailable', async () => {
    const searcher = createWorkTextSearcher(library(WORKS))
    const result = await searcher.search(['1', '4'], 'dragon')
    assert.equal(result.searched, 1)
    assert.equal(result.unavailable, 1)
  })

  test('a work listed twice is searched once', async () => {
    const source = library(WORKS)
    const result = await createWorkTextSearcher(source).search(['1', '1'], 'dragon')
    assert.equal(result.searched, 1)
    assert.deepEqual(source.loads.flat(), ['1'])
  })

  test('loads in batches, and a second search reads nothing again', async () => {
    const source = library(WORKS)
    const searcher = createWorkTextSearcher({ ...source, batchSize: 2 })
    await searcher.search(['1', '2', '3'], 'dragon')
    assert.deepEqual(source.loads, [['1', '2'], ['3']])
    const again = await searcher.search(['1', '2', '3'], 'sea')
    assert.deepEqual([...again.hits], ['2'])
    assert.equal(source.loads.length, 2)
  })

  test('past its budget it still searches, but loads the rest afresh each time', async () => {
    const source = library(WORKS)
    const budget = foldText(workTextOf(WORKS[1])).length
    const searcher = createWorkTextSearcher({ ...source, budgetChars: budget })
    await searcher.search(['1', '2'], 'dragon')
    const second = await searcher.search(['1', '2'], 'sea')
    assert.deepEqual([...second.hits], ['2'])
    assert.deepEqual(source.loads.slice(1), [['2']])
  })

  test('reports progress over the works it can search', async () => {
    const seen = []
    const searcher = createWorkTextSearcher({ ...library(WORKS), batchSize: 1 })
    await searcher.search(['1', '2', '9'], 'tea', { onProgress: (done, total) => seen.push([done, total]) })
    assert.deepEqual(seen, [[0, 2], [1, 2], [2, 2]])
  })

  test('an aborted search rejects, and what it loaded is kept for the next', async () => {
    const source = library(WORKS)
    const searcher = createWorkTextSearcher({ ...source, batchSize: 1 })
    const controller = new AbortController()
    const search = searcher.search(['1', '2', '3'], 'tea', {
      signal: controller.signal,
      onProgress: done => done === 1 && controller.abort(),
    })
    await assert.rejects(search, { name: 'AbortError' })
    const loadedBefore = source.loads.flat()
    assert.ok(loadedBefore.length < 3, 'the search should stop before reading every work')
    await searcher.search(['1', '2', '3'], 'tea')
    for (const id of loadedBefore)
      assert.equal(source.loads.flat().filter(loaded => loaded === id).length, 1, `work ${id} should not be read twice`)
  })

  test('a signal aborted before the start reads nothing', async () => {
    const source = library(WORKS)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(createWorkTextSearcher(source).search(['1'], 'tea', { signal: controller.signal }), { name: 'AbortError' })
    assert.deepEqual(source.loads, [])
  })

  test('a snippet is cut from the work\'s own text, case intact', async () => {
    const searcher = createWorkTextSearcher(library(WORKS))
    const snippet = await searcher.snippet('3', 'DRAGON')
    assert.equal(snippet.match, 'dragon')
    assert.equal(snippet.before, 'A Title Tea with the ')
  })

  test('no snippet for a work without text, or a query without terms', async () => {
    const searcher = createWorkTextSearcher(library(WORKS))
    assert.equal(await searcher.snippet('9', 'dragon'), null)
    assert.equal(await searcher.snippet('4', 'dragon'), null)
    assert.equal(await searcher.snippet('1', '  '), null)
  })

  test('a snippet never centres on a word the query excludes', async () => {
    const searcher = createWorkTextSearcher(library(WORKS))
    assert.equal((await searcher.snippet('1', 'tea OR NOT dragon')).match, 'tea')
    assert.equal(await searcher.snippet('2', 'NOT dragon'), null)
  })

  test('asking for the same snippet twice reads the work once', async () => {
    const source = library(WORKS)
    const searcher = createWorkTextSearcher(source)
    await Promise.all([searcher.snippet('1', 'tea'), searcher.snippet('1', 'tea')])
    assert.equal(source.loads.length, 1)
  })
})

describe('describeTextSearch', () => {
  test('before a search, says how much of the list it covers', () => {
    assert.deepEqual(figures(describeTextSearch({ kind: 'idle', searchable: 3, total: 3 })), [3])
    assert.deepEqual(figures(describeTextSearch({ kind: 'idle', searchable: 2, total: 5 })), [2, 5])
    assert.equal(describeTextSearch({ kind: 'idle', searchable: 0, total: 5 }), NOTHING_TO_SEARCH)
  })

  test('while searching, says how far it has got', () => {
    assert.deepEqual(figures(describeTextSearch({ kind: 'searching', done: 40, total: 120 })), [40, 120])
  })

  test('after a search, says where it was found and what it could not look at', () => {
    const found = describeTextSearch({ kind: 'done', hits: 2, searched: 3, unavailable: 0 })
    assert.deepEqual(figures(found), [2, 3])
    const missed = describeTextSearch({ kind: 'done', hits: 0, searched: 3, unavailable: 0 })
    assert.ok(figures(missed).includes(3), missed)
    assert.notEqual(missed, describeTextSearch({ kind: 'done', hits: 3, searched: 3, unavailable: 0 }))
    const partly = describeTextSearch({ kind: 'done', hits: 2, searched: 3, unavailable: 1 })
    assert.deepEqual(figures(partly), [1, 2, 3])
    const unsearched = describeTextSearch({ kind: 'done', hits: 0, searched: 3, unavailable: 4 })
    assert.ok(figures(unsearched).includes(3) && figures(unsearched).includes(4), unsearched)
    assert.equal(describeTextSearch({ kind: 'done', hits: 0, searched: 0, unavailable: 4 }), NOTHING_TO_SEARCH)
  })

  test('a failure says what went wrong', () => {
    assert.ok(mentions(describeTextSearch({ kind: 'failed', message: 'it broke' }), 'it broke'))
  })
})
