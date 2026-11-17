import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { matchedTagRules, tagRuleIndicators } from '../../src/common/rules.ts'
import { mentions } from '../facts.mjs'

/** The rules settings a fresh install starts with. */
const SETTINGS = OPTION_DEFAULTS.rules
/** The priority an "always show" rule gets when it sets none of its own. */
const ALWAYS_SHOW = SETTINGS.alwaysShowPriority

const tag = { name: 'Alternate Universe - Coffee Shop', type: 'F' }
/** Where a tag link's menu writes its exact rule: its type, and its name. */
const key = { target: 'F', value: tag.name }

const exact = props => ({ ...key, matcher: 'exact', ...props })
const contains = (value, props) => ({ target: 'tag', value, matcher: 'contains', ...props })
const regex = (value, props) => ({ target: 'F', value, matcher: 'regex', ...props })

const indicators = rules => tagRuleIndicators(rules, tag, SETTINGS)
const byBehavior = rules => Object.fromEntries(indicators(rules).map(i => [i.behavior, i]))

describe('tagRuleIndicators', () => {
  test('the tag’s own exact rule draws plainly, with nothing to explain', () => {
    assert.deepEqual(indicators([exact({ behavior: 'collapse' })]), [{ behavior: 'collapse', matcher: 'exact', reasons: [] }])
  })

  test('a tag of unknown type has its own rule under any tag', () => {
    const untyped = { name: tag.name }
    const own = { target: 'tag', value: tag.name, matcher: 'exact', behavior: 'invert' }
    assert.deepEqual(tagRuleIndicators([own], untyped, SETTINGS), [{ behavior: 'invert', matcher: 'exact', reasons: [] }])
  })

  test('a rule with no behaviour is a hide', () => {
    assert.deepEqual(indicators([exact({})]).map(i => i.behavior), ['hide'])
  })

  test('the tag’s own rule keeps every behaviour it can draw, but a disabled one draws nothing', () => {
    assert.deepEqual(indicators([exact({ behavior: 'highlight' })]).map(i => i.behavior), ['highlight'])
    assert.deepEqual(indicators([exact({ behavior: 'hideFilter' })]).map(i => i.behavior), ['hideFilter'])
    assert.deepEqual(indicators([exact({ behavior: 'none' })]), [])
  })

  test('a contains rule matching the tag draws as contains, naming the rule', () => {
    const [hide] = indicators([contains('coffee')])
    assert.equal(hide.behavior, 'hide')
    assert.equal(hide.matcher, 'contains')
    assert.equal(hide.reasons.length, 1)
    assert.ok(mentions(hide.reasons[0], 'coffee'), hide.reasons[0])
  })

  test('a regex rule matching the tag draws as regex, naming the rule and its priority', () => {
    const [show] = indicators([regex('^alternate universe', { behavior: 'invert' })])
    assert.equal(show.behavior, 'invert')
    assert.equal(show.matcher, 'regex')
    assert.ok(mentions(show.reasons[0], '^alternate universe'), show.reasons[0])
    assert.ok(mentions(show.reasons[0], ALWAYS_SHOW), show.reasons[0])
  })

  test('an exact rule on another target that matches the tag draws as exact, naming the rule', () => {
    const [hide] = indicators([{ target: 'tag', value: tag.name, matcher: 'exact' }])
    assert.equal(hide.matcher, 'exact')
    assert.equal(hide.reasons.length, 1)
  })

  test('only rules that weigh in on whether a work shows are drawn for other matches', () => {
    assert.deepEqual(indicators([
      contains('coffee', { behavior: 'highlight' }),
      contains('coffee', { behavior: 'hideFilter' }),
      contains('coffee', { behavior: 'none' }),
    ]), [])
  })

  test('rules that don’t match the tag draw nothing', () => {
    assert.deepEqual(indicators([
      contains('tea'),
      regex('^coffee'),
      { target: 'R', value: 'coffee', matcher: 'contains' },
      exact({ value: 'Coffee Shop' }),
    ]), [])
  })

  test('the tag’s own rule is drawn ahead of other rules doing the same, and every one is named', () => {
    const { hide } = byBehavior([contains('coffee', { priority: 7 }), exact({})])
    assert.equal(hide.matcher, 'exact')
    assert.equal(hide.reasons.length, 2)
    assert.ok(mentions(hide.reasons[0], tag.name), hide.reasons[0])
    assert.ok(mentions(hide.reasons[1], 'coffee'), hide.reasons[1])
  })

  test('of other rules doing the same, the strongest is drawn and named first', () => {
    const { collapse } = byBehavior([
      contains('coffee', { behavior: 'collapse' }),
      regex('shop$', { behavior: 'collapse', priority: 3 }),
    ])
    assert.equal(collapse.matcher, 'regex')
    assert.ok(mentions(collapse.reasons[0], 'shop$'), collapse.reasons[0])
    assert.ok(mentions(collapse.reasons[1], 'coffee'), collapse.reasons[1])
  })

  test('between equally strong rules, the first listed is drawn', () => {
    const { hide } = byBehavior([regex('shop$'), contains('coffee')])
    assert.equal(hide.matcher, 'regex')
  })

  test('each behaviour gets its own indicator', () => {
    const drawn = byBehavior([
      exact({ behavior: 'highlight' }),
      contains('coffee'),
      regex('shop$', { behavior: 'invert' }),
    ])
    assert.deepEqual(Object.keys(drawn).sort(), ['hide', 'highlight', 'invert'])
    assert.equal(drawn.highlight.matcher, 'exact')
    assert.equal(drawn.hide.matcher, 'contains')
    assert.equal(drawn.invert.matcher, 'regex')
  })

  test('an invalid regex matches nothing', () => {
    assert.deepEqual(indicators([regex('(coffee')]), [])
  })
})

describe('matchedTagRules', () => {
  test('lists the rules weighing in on the tag besides the tag’s own exact one, in list order', () => {
    const own = exact({})
    const byName = { target: 'tag', value: tag.name, matcher: 'exact', behavior: 'collapse' }
    const shop = regex('shop$', { behavior: 'invert' })
    const coffee = contains('coffee')
    const rules = [own, shop, contains('tea'), byName, contains('coffee', { behavior: 'highlight' }), coffee]
    assert.deepEqual(matchedTagRules(rules, tag), [shop, byName, coffee])
  })
})
