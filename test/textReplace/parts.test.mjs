import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// data.ts is pure (no imports at all), so it needs no build, no DOM and no
// extension APIs — but it does declare an enum, which strip-only mode refuses:
//
//   node --experimental-transform-types --test test/textReplace/parts.test.mjs
import {
  applyTextReplacement,
  applyTextReplacements,
  replaceTextParts,
  textReplacementActive,
} from '../../src/common/data.ts'

const rule = (find, replace, extra = {}) => ({ find, replace, ...extra })

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
    const parts = replaceTextParts('a cat and a bird', rules)
    assert.deepEqual(parts.filter(p => p.rule !== null).map(p => p.rule), [1])
  })
})

describe('the runs a rewrite is made of', () => {
  test('join back into what applying the rules gives', () => {
    const rules = [rule('middle', 'last'), rule('night', 'day')]
    const text = 'Written in the middle of the night, in the middle.'
    assert.equal(
      replaceTextParts(text, rules).map(p => p.text).join(''),
      applyTextReplacements(text, rules),
    )
  })

  test('name the rule behind each replacement', () => {
    const rules = [rule('middle', 'last'), rule('night', 'day')]
    const parts = replaceTextParts('the middle of the night', rules)
    assert.deepEqual(parts.map(p => [p.text, p.rule]), [
      ['the ', null],
      ['last', 0],
      [' of the ', null],
      ['day', 1],
    ])
  })

  test('are one untouched run when nothing matches', () => {
    const parts = replaceTextParts('nothing here', [rule('cat', 'dog')])
    assert.deepEqual(parts, [{ text: 'nothing here', rule: null }])
  })

  test('carry the casing the match asked for', () => {
    const parts = replaceTextParts('Cat and cat', [rule('cat', 'dog', { matchCasing: true })])
    assert.deepEqual(parts.filter(p => p.rule !== null).map(p => p.text), ['Dog', 'dog'])
  })

  test('respect whole-word matching', () => {
    const parts = replaceTextParts('cat and cats', [rule('cat', 'dog', { wholeWord: true })])
    assert.equal(parts.map(p => p.text).join(''), 'dog and cats')
  })

  test('let a later rule rewrite what an earlier one wrote', () => {
    const rules = [rule('cat', 'dog'), rule('dog', 'bird')]
    const parts = replaceTextParts('a cat', rules)
    assert.equal(parts.map(p => p.text).join(''), 'a bird')
    // The run belongs to whichever rule wrote the words that are actually there.
    assert.deepEqual(parts.filter(p => p.rule !== null).map(p => p.rule), [1])
  })
})
