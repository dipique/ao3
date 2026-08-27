import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// data.ts is pure (no imports at all), so it needs no build, no DOM and no
// extension APIs — but it does declare an enum, which strip-only mode refuses:
//
//   node --experimental-transform-types --test test/rules/priority.test.mjs
import {
  DEFAULT_AUTHOR_HIGHLIGHT_COLOR,
  DEFAULT_BEHAVIOR_PRIORITY,
  DEFAULT_HIGHLIGHT_COLOR,
  isTagTarget,
  ruleAffectsWorks,
  ruleHighlightColor,
  ruleMatchesAuthor,
  ruleMatchesEntity,
  ruleMatchesTag,
  rulePriority,
  ruleTargetColor,
  TagType,
} from '../../src/common/data.ts'

const rule = props => ({ target: 'tag', value: '', matcher: 'exact', ...props })

describe('rulePriority', () => {
  test('an unset priority follows the behaviour', () => {
    assert.equal(rulePriority(rule({})), 0, 'hide is the default behaviour')
    assert.equal(rulePriority(rule({ behavior: 'hide' })), 0)
    assert.equal(rulePriority(rule({ behavior: 'highlight' })), 0)
    assert.equal(rulePriority(rule({ behavior: 'hideFilter' })), 0)
    assert.equal(rulePriority(rule({ behavior: 'none' })), 0)
    // The one non-zero default: "always show" has to beat an ordinary hide, which
    // is what it meant before priorities existed.
    assert.equal(rulePriority(rule({ behavior: 'invert' })), 4)
    assert.equal(DEFAULT_BEHAVIOR_PRIORITY.invert, 4)
  })

  test('an explicit priority wins over the behaviour default', () => {
    assert.equal(rulePriority(rule({ behavior: 'invert', priority: 1 })), 1)
    assert.equal(rulePriority(rule({ behavior: 'hide', priority: 7 })), 7)
    assert.equal(rulePriority(rule({ priority: 0 })), 0)
  })

  test('clamps to 0-9 and ignores junk', () => {
    assert.equal(rulePriority(rule({ priority: 42 })), 9)
    assert.equal(rulePriority(rule({ priority: -3 })), 0)
    assert.equal(rulePriority(rule({ priority: 3.7 })), 3)
    assert.equal(rulePriority(rule({ behavior: 'invert', priority: Number.NaN })), 4, 'falls back to the default')
  })

  test('a hide rule can be raised above a force-show', () => {
    // The point of the whole feature: an "always show" tag no longer overrules a
    // fandom you never want to see, as long as you say so.
    const alwaysShow = rule({ behavior: 'invert' })
    const hardHide = rule({ target: TagType.Fandom, value: 'Naruto', behavior: 'hide', priority: 5 })
    assert.ok(rulePriority(hardHide) > rulePriority(alwaysShow))
  })
})

describe('ruleMatchesTag', () => {
  const tag = { name: 'Slow Burn', type: TagType.Freeform }

  test('"tag" matches any type; a type target restricts', () => {
    assert.ok(ruleMatchesTag(rule({ target: 'tag', value: 'Slow Burn' }), tag))
    assert.ok(ruleMatchesTag(rule({ target: TagType.Freeform, value: 'Slow Burn' }), tag))
    assert.ok(!ruleMatchesTag(rule({ target: TagType.Character, value: 'Slow Burn' }), tag))
  })

  test('exact is case-sensitive; contains and regex are not', () => {
    assert.ok(!ruleMatchesTag(rule({ value: 'slow burn' }), tag))
    assert.ok(ruleMatchesTag(rule({ value: 'SLOW', matcher: 'contains' }), tag))
    assert.ok(ruleMatchesTag(rule({ value: '^slow.*burn$', matcher: 'regex' }), tag))
  })

  test('an invalid regex matches nothing rather than throwing', () => {
    assert.ok(!ruleMatchesTag(rule({ value: '([', matcher: 'regex' }), tag))
  })

  test('non-tag targets never match a tag', () => {
    assert.ok(!ruleMatchesTag(rule({ target: 'author', value: 'Slow Burn' }), tag))
    assert.ok(!isTagTarget('work'))
    assert.ok(isTagTarget('tag') && isTagTarget(TagType.Fandom))
  })
})

describe('ruleMatchesAuthor', () => {
  const author = { userId: 'someone', pseud: 'Alt' }

  test('matches by user id, and by pseud when the rule names one', () => {
    assert.ok(ruleMatchesAuthor(rule({ target: 'author', value: 'someone' }), author))
    assert.ok(ruleMatchesAuthor(rule({ target: 'author', value: 'someone', pseud: 'Alt' }), author))
    assert.ok(!ruleMatchesAuthor(rule({ target: 'author', value: 'someone', pseud: 'Main' }), author))
  })

  test('a tag rule never matches an author', () => {
    assert.ok(!ruleMatchesAuthor(rule({ target: 'tag', value: 'someone' }), author))
  })
})

describe('ruleMatchesEntity', () => {
  const work = { id: '89100761', name: 'Her Kindness' }

  test('a numeric value matches the id, not the title', () => {
    assert.ok(ruleMatchesEntity(rule({ target: 'work', value: '89100761' }), 'work', work))
    assert.ok(!ruleMatchesEntity(rule({ target: 'work', value: '123' }), 'work', work))
  })

  test('a non-numeric value matches the title with the rule\'s matcher', () => {
    assert.ok(ruleMatchesEntity(rule({ target: 'work', value: 'Her Kindness' }), 'work', work))
    assert.ok(ruleMatchesEntity(rule({ target: 'work', value: 'kind', matcher: 'contains' }), 'work', work))
  })

  test('an empty value matches nothing, and the kind must agree', () => {
    assert.ok(!ruleMatchesEntity(rule({ target: 'work', value: '  ' }), 'work', work))
    assert.ok(!ruleMatchesEntity(rule({ target: 'series', value: '89100761' }), 'work', work))
  })
})

describe('highlight colours', () => {
  test('default colours are keyed by target', () => {
    assert.equal(ruleTargetColor('tag'), DEFAULT_HIGHLIGHT_COLOR)
    assert.equal(ruleTargetColor(TagType.Fandom), DEFAULT_HIGHLIGHT_COLOR)
    assert.equal(ruleTargetColor('author'), DEFAULT_AUTHOR_HIGHLIGHT_COLOR)
  })

  test('an override wins over the built-in, per target', () => {
    const colors = { [TagType.Fandom]: '#123456ff' }
    assert.equal(ruleTargetColor(TagType.Fandom, colors), '#123456ff')
    assert.equal(ruleTargetColor(TagType.Character, colors), DEFAULT_HIGHLIGHT_COLOR)
  })

  test('only highlight and invert rules highlight', () => {
    assert.equal(ruleHighlightColor(rule({ behavior: 'hide' })), null)
    assert.equal(ruleHighlightColor(rule({ behavior: 'hideFilter' })), null)
    // A disabled rule keeps its colour on the rule but never paints with it.
    assert.equal(ruleHighlightColor(rule({ behavior: 'none', color: '#abcdefff' })), null)
    assert.equal(ruleHighlightColor(rule({ behavior: 'highlight' })), DEFAULT_HIGHLIGHT_COLOR)
    assert.equal(ruleHighlightColor(rule({ behavior: 'invert' })), DEFAULT_HIGHLIGHT_COLOR)
  })

  test('an invert rule opts out of highlighting with the transparent sentinel', () => {
    assert.equal(ruleHighlightColor(rule({ behavior: 'invert', color: 'transparent' })), null)
  })

  test('a rule inherits its target\'s colour unless it sets one', () => {
    assert.equal(
      ruleHighlightColor(rule({ target: 'author', behavior: 'highlight' })),
      DEFAULT_AUTHOR_HIGHLIGHT_COLOR,
    )
    assert.equal(ruleHighlightColor(rule({ behavior: 'highlight', color: '#abcdefff' })), '#abcdefff')
  })
})

describe('ruleAffectsWorks', () => {
  test('only hiding and force-showing decide whether a work is shown', () => {
    assert.equal(ruleAffectsWorks(rule({})), true, 'hide is the default behaviour')
    assert.equal(ruleAffectsWorks(rule({ behavior: 'hide' })), true)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'invert' })), true)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'highlight' })), false)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'hideFilter' })), false)
  })

  test('a disabled rule takes no part, whatever else it carries', () => {
    assert.equal(ruleAffectsWorks(rule({ behavior: 'none' })), false)
    // Priority and colour survive for when it is turned back on; neither lets it
    // back into the contest while it is off.
    assert.equal(ruleAffectsWorks(rule({ behavior: 'none', priority: 9, color: '#abcdefff' })), false)
    assert.equal(rulePriority(rule({ behavior: 'none', priority: 7 })), 7)
  })
})
