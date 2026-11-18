import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { DEFAULT_HIGHLIGHT_COLOR, highlightingRules, isEntityTarget, matchesById, ruleDescription, ruleSubject } from '../../src/common/rules.ts'
import { mentions } from '../facts.mjs'

describe('matchesById', () => {
  test('a work or series rule whose text is a number matches by id, spaces and all', () => {
    assert.equal(matchesById('work', '4232377'), true)
    assert.equal(matchesById('series', ' 4232377 '), true)
  })

  test('any other text, or any other target, matches by what it says', () => {
    assert.equal(matchesById('work', 'Chapter 12'), false)
    assert.equal(matchesById('work', ''), false)
    assert.equal(matchesById('author', '4232377'), false)
    assert.equal(matchesById('tag', '4232377'), false)
  })

  test('a rule matching by id is described by it', () => {
    const subject = ruleSubject({ target: 'series', value: ' 77 ', matcher: 'contains' })
    assert.ok(mentions(subject, '77') && !mentions(subject, 'contains'), subject)
  })
})

describe('ruleSubject', () => {
  const pseudRule = props => ({ target: 'author', value: 'someone', pseud: 'Nightjar', ...props })

  for (const matcher of ['exact', 'contains', 'regex']) {
    test(`an author rule narrowed to one pseud names the pseud, matching by ${matcher}`, () => {
      const subject = ruleSubject(pseudRule({ matcher }))
      assert.ok(mentions(subject, 'someone') && mentions(subject, 'Nightjar'), subject)
    })
  }

  test('a reason names the pseud beside the rule\'s priority', () => {
    const description = ruleDescription(pseudRule({ matcher: 'exact', priority: 3 }), OPTION_DEFAULTS.rules)
    assert.ok(mentions(description, 'Nightjar') && mentions(description, 3), description)
  })
})

describe('isEntityTarget', () => {
  test('is a work or a series', () => {
    assert.deepEqual(['work', 'series', 'author', 'tag', 'F'].filter(isEntityTarget), ['work', 'series'])
  })
})

describe('highlightingRules', () => {
  test('keeps the rules that highlight, each with the colour it highlights in, in list order', () => {
    const own = { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight', color: '#123456' }
    const byDefault = { target: 'F', value: 'Waff', matcher: 'exact', behavior: 'invert' }
    const rules = [
      { target: 'F', value: 'Angst', matcher: 'exact', behavior: 'hide' },
      own,
      { target: 'F', value: 'Plain', matcher: 'exact', behavior: 'invert', color: 'transparent' },
      byDefault,
    ]
    assert.deepEqual(highlightingRules(rules, {}), [
      { rule: own, color: '#123456' },
      { rule: byDefault, color: DEFAULT_HIGHLIGHT_COLOR },
    ])
  })

  test('follows the colours set for each target', () => {
    const rule = { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight' }
    assert.deepEqual(highlightingRules([rule], { F: '#abcdef' }), [{ rule, color: '#abcdef' }])
  })
})
