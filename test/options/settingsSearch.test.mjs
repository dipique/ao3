import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { entryMatches, highlight, markSpans, normalize, searchTerms } from '../../src/options_ui/model/settingsSearch.ts'

const row = (title, subtitle = '') => ({ title, subtitle })

describe('normalize', () => {
  test('folds case and strips accents', () => {
    assert.equal(normalize('Précis ÜBER'), 'precis uber')
  })
})

describe('searchTerms', () => {
  test('splits the query on whitespace and drops the gaps', () => {
    assert.deepEqual(searchTerms('  reader \t mode '), ['reader', 'mode'])
  })

  test('folds the terms as the text they are matched against is folded', () => {
    assert.deepEqual(searchTerms('PRÉCIS'), ['precis'])
  })

  test('a blank query has no terms', () => {
    assert.deepEqual(searchTerms(' \n '), [])
  })
})

describe('entryMatches', () => {
  const readerMode = row('Reader mode', 'Strips the page down to the work text.')

  test('every term has to appear', () => {
    assert.ok(entryMatches(readerMode, ['reader', 'text']))
    assert.ok(!entryMatches(readerMode, ['reader', 'crossover']))
  })

  test('a term may be in the title or the description', () => {
    assert.ok(entryMatches(readerMode, ['mode']))
    assert.ok(entryMatches(readerMode, ['strips']))
  })

  test('a term matches inside a word', () => {
    assert.ok(entryMatches(readerMode, ['rip']))
  })

  test('no terms matches everything', () => {
    assert.ok(entryMatches(readerMode, []))
  })

  test('accents are ignored on either side', () => {
    assert.ok(entryMatches(row('Précis'), searchTerms('precis')))
    assert.ok(entryMatches(row('Precis'), searchTerms('précis')))
  })
})

describe('highlight', () => {
  test('with no terms the text is only escaped', () => {
    assert.equal(
      highlight('<b>"Tom" & \'Jerry\'</b>', []),
      '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;',
    )
  })

  test('markup in the text stays text when a term matches inside it', () => {
    assert.equal(highlight('<b>bold</b>', ['b']), '&lt;<mark>b</mark>&gt;<mark>b</mark>old&lt;/<mark>b</mark>&gt;')
  })

  test('a term never lands inside an escape', () => {
    // Each of these terms is spelled inside the escape the text's punctuation
    // becomes: `&amp;`, `&quot;`, `&#39;`.
    assert.equal(highlight('Sync & Backups', ['a']), 'Sync &amp; B<mark>a</mark>ckups')
    assert.equal(highlight('"Track this"', ['t']), '&quot;<mark>T</mark>rack <mark>t</mark>his&quot;')
    assert.equal(highlight('it\'s 39', ['39']), 'it&#39;s <mark>39</mark>')
  })

  test('every occurrence is marked', () => {
    assert.equal(highlight('Tag menu, tag list', ['tag']), '<mark>Tag</mark> menu, <mark>tag</mark> list')
  })

  test('hits from two terms that overlap make one mark', () => {
    assert.equal(highlight('Reader mode', ['read', 'ader']), '<mark>Reader</mark> mode')
  })

  test('hits that touch make one mark', () => {
    assert.equal(highlight('Reader mode', ['rea', 'der']), '<mark>Reader</mark> mode')
  })

  test('the text keeps its own spelling inside the mark', () => {
    assert.equal(highlight('Précis', ['precis']), '<mark>Précis</mark>')
    assert.equal(highlight('PRECIS', ['precis']), '<mark>PRECIS</mark>')
  })

  test('text written with combining accents is marked where the term is', () => {
    const decomposed = 'Café au lait'
    assert.equal(highlight(decomposed, ['au']), 'Café <mark>au</mark> lait')
    assert.equal(highlight(decomposed, ['cafe']), '<mark>Café</mark> au lait', 'the accent stays with its letter')
  })
})

describe('markSpans', () => {
  test('marks each span, merging those that overlap or touch, and escapes around and inside the marks', () => {
    assert.equal(markSpans('a<b>&c', [[1, 4], [0, 1]]), '<mark>a&lt;b&gt;</mark>&amp;c')
    assert.equal(markSpans('Fluff & Angst', [[0, 3], [2, 5], [8, 13]]), '<mark>Fluff</mark> &amp; <mark>Angst</mark>')
  })

  test('with no spans the text is only escaped', () => {
    assert.equal(markSpans('Fluff & Angst', []), 'Fluff &amp; Angst')
  })
})
