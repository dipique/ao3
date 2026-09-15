import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// data.ts is pure — no imports at all, so no build, no DOM and no extension
// APIs — and nothing in it emits runtime code, so plain type stripping is enough:
//
//   node --test test/textReplace/parts.test.mjs
import {
  applyTextReplacement,
  applyTextReplacements,
  replaceTextSegments,
  textReplacementActive,
} from '../../src/common/data.ts'

const rule = (find, replace, extra = {}) => ({ find, replace, ...extra })

/** The rewritten text of one segment, as it would be written back to its node. */
const segmentText = (spans, segment) =>
  spans.filter(s => s.segment === segment).map(s => s.text).join('')

/** Every segment's text, in order — what the run reads as afterwards. */
const allText = spans => spans.map(s => s.text).join('')

describe('a disabled replacement', () => {
  test('is not active', () => {
    assert.equal(textReplacementActive(rule('cat', 'dog')), true)
    assert.equal(textReplacementActive(rule('cat', 'dog', { disabled: true })), false)
    // Nothing to find has always meant nothing to do.
    assert.equal(textReplacementActive(rule('', 'dog')), false)
  })

  test('leaves the text alone, on its own and among others', () => {
    const off = rule('cat', 'dog', { disabled: true })
    assert.equal(applyTextReplacement('a cat', off), 'a cat')
    assert.equal(applyTextReplacements('a cat and a bird', [off, rule('bird', 'bat')]), 'a cat and a bat')
  })

  test('still occupies its index, so the rules after it keep theirs', () => {
    const rules = [rule('cat', 'dog', { disabled: true }), rule('bird', 'bat')]
    const spans = replaceTextSegments(['a cat and a bird'], rules)
    assert.deepEqual(spans.filter(s => s.rule !== null).map(s => s.rule), [1])
  })
})

describe('the runs a rewrite is made of', () => {
  test('join back into what applying the rules gives', () => {
    const rules = [rule('middle', 'last'), rule('night', 'day')]
    const text = 'Written in the middle of the night, in the middle.'
    assert.equal(allText(replaceTextSegments([text], rules)), applyTextReplacements(text, rules))
  })

  test('name the rule behind each replacement', () => {
    const rules = [rule('middle', 'last'), rule('night', 'day')]
    const spans = replaceTextSegments(['the middle of the night'], rules)
    assert.deepEqual(spans.map(s => [s.text, s.rule]), [
      ['the ', null],
      ['last', 0],
      [' of the ', null],
      ['day', 1],
    ])
  })

  test('are one untouched run when nothing matches', () => {
    const spans = replaceTextSegments(['nothing here'], [rule('cat', 'dog')])
    assert.deepEqual(spans, [{ text: 'nothing here', segment: 0, rule: null }])
  })

  test('carry the casing the match asked for', () => {
    const spans = replaceTextSegments(['Cat and cat'], [rule('cat', 'dog', { matchCasing: true })])
    assert.deepEqual(spans.filter(s => s.rule !== null).map(s => s.text), ['Dog', 'dog'])
  })

  test('respect whole-word matching', () => {
    const spans = replaceTextSegments(['cat and cats'], [rule('cat', 'dog', { wholeWord: true })])
    assert.equal(allText(spans), 'dog and cats')
  })

  test('let a later rule rewrite what an earlier one wrote', () => {
    const rules = [rule('cat', 'dog'), rule('dog', 'bird')]
    const spans = replaceTextSegments(['a cat'], rules)
    assert.equal(allText(spans), 'a bird')
    // The run belongs to whichever rule wrote the words that are actually there.
    assert.deepEqual(spans.filter(s => s.rule !== null).map(s => s.rule), [1])
  })

  // A seam left inside one segment by an earlier rule is not formatting, so it
  // never stops a later rule — the segment reads as one string either way.
  test('let a later rule read straight through an earlier replacement', () => {
    const rules = [rule('X', 'ca'), rule('cat', 'dog')]
    assert.equal(allText(replaceTextSegments(['a Xt'], rules)), 'a dog')
  })
})

/** What hovering a replaced run shows: the text as the author wrote it. */
describe('the original text behind a replacement', () => {
  const originals = spans => spans.filter(s => s.rule !== null).map(s => [s.text, s.original])

  test('is the text the match covered, in its own casing', () => {
    const spans = replaceTextSegments(['Cat and cat'], [rule('cat', 'dog', { matchCasing: true })])
    assert.deepEqual(originals(spans), [['Dog', 'Cat'], ['dog', 'cat']])
  })

  test('is not recorded on untouched text', () => {
    const spans = replaceTextSegments(['a cat'], [rule('cat', 'dog')])
    assert.ok(spans.filter(s => s.rule === null).every(s => !('original' in s)))
  })

  test('reaches back past an earlier rule to the source', () => {
    const spans = replaceTextSegments(['a cat'], [rule('cat', 'dog'), rule('dog', 'wolf')])
    assert.deepEqual(originals(spans), [['wolf', 'cat']])
  })

  test('joins source text and an earlier replacement a later match read across', () => {
    const spans = replaceTextSegments(['a Xt'], [rule('X', 'ca'), rule('cat', 'dog')])
    assert.deepEqual(originals(spans), [['dog', 'Xt']])
  })

  test('is shared by what a later rule left of an earlier replacement', () => {
    const spans = replaceTextSegments(['a cat'], [rule('cat', 'dog'), rule('og', 'ig')])
    assert.equal(allText(spans), 'a dig')
    assert.deepEqual(originals(spans), [['d', 'cat'], ['ig', 'cat']])
  })
})

/**
 * The whole point of segments: a work's markup splits one sentence into a text
 * node per change of formatting, and `, Love...` in
 * `…I can,<em> Love….</em> Alright?` lives across two of them.
 */
describe('a match that spans a change of formatting', () => {
  const SPLIT = ['"…as soon as I can,', ' Love....', ' Alright?…"']
  const LOVE = rule(', Love...', ', honey', { caseSensitive: true })

  test('is not made by default', () => {
    const spans = replaceTextSegments(SPLIT, [LOVE])
    assert.equal(allText(spans), SPLIT.join(''))
    assert.ok(spans.every(s => s.rule === null))
  })

  test('is made when the rule asks to read across formatting', () => {
    const spans = replaceTextSegments(SPLIT, [{ ...LOVE, acrossFormatting: true }])
    assert.equal(allText(spans), '"…as soon as I can, honey. Alright?…"')
  })

  test('puts the replacement in the segment the match started in', () => {
    const spans = replaceTextSegments(SPLIT, [{ ...LOVE, acrossFormatting: true }])
    // The comma's own segment gains the whole replacement…
    assert.equal(segmentText(spans, 0), '"…as soon as I can, honey')
    // …and the italic segment keeps only what the match didn't reach.
    assert.equal(segmentText(spans, 1), '.')
    assert.equal(segmentText(spans, 2), ' Alright?…"')
  })

  test('is still one run, so it underlines and edits as one replacement', () => {
    const spans = replaceTextSegments(SPLIT, [{ ...LOVE, acrossFormatting: true }])
    const replaced = spans.filter(s => s.rule !== null)
    assert.deepEqual(replaced.map(s => ({ text: s.text, segment: s.segment })), [
      { text: ', honey', segment: 0 },
    ])
  })

  test('does not stop a rule that fits inside one segment', () => {
    // The control: `Alright` is wholly within the third segment either way.
    const spans = replaceTextSegments(SPLIT, [LOVE, rule('Alright', 'OK', { caseSensitive: true })])
    assert.equal(allText(spans), '"…as soon as I can, Love.... OK?…"')
  })

  test('leaves a segment empty when the match swallowed all of it', () => {
    const spans = replaceTextSegments(['ab', 'cd', 'ef'], [rule('bcde', 'z', { acrossFormatting: true })])
    assert.equal(segmentText(spans, 0), 'az')
    assert.equal(segmentText(spans, 1), '')
    assert.equal(segmentText(spans, 2), 'f')
    assert.equal(allText(spans), 'azf')
  })

  test('remembers the whole source it replaced, seam and all', () => {
    const spans = replaceTextSegments(SPLIT, [{ ...LOVE, acrossFormatting: true }])
    assert.deepEqual(spans.filter(s => s.rule !== null).map(s => s.original), [', Love...'])
  })

  test('an off rule and an on rule can sit in the same list', () => {
    // Both rules straddle the same seam; only the one that asked gets its match.
    const rules = [LOVE, { ...LOVE, find: 'n, Love', replace: 'n, dear', acrossFormatting: true }]
    assert.equal(allText(replaceTextSegments(SPLIT, rules)), '"…as soon as I can, dear.... Alright?…"')
  })
})
