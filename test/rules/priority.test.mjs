import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// rules.ts and data.ts are pure, so this needs no build, no DOM and no
// extension APIs:
//
//   node --test test/rules/priority.test.mjs
import { TagType } from '../../src/common/data.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import {
  DEFAULT_AUTHOR_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_COLOR,
  defaultRulePriority,
  excludesFromSearch,
  isTagTarget,
  MAX_PRIORITY,
  MIN_PRIORITY,
  ruleAffectsWorks,
  ruleHasPriority,
  ruleHideMode,
  ruleHighlightColor,
  ruleMatchesAuthor,
  ruleMatchesEntity,
  ruleMatchesTag,
  rulePriority,
  ruleTargetColor,
  ruleValueMatches,
} from '../../src/common/rules.ts'

const rule = props => ({ target: 'tag', value: '', matcher: 'exact', ...props })

/** The rules settings a fresh install starts with. */
const SETTINGS = OPTION_DEFAULTS.rules
/** The priority an "always show" rule gets when it sets none of its own. */
const ALWAYS_SHOW = SETTINGS.alwaysShowPriority
/** Every behaviour other than "always show", none of which the setting touches. */
const OTHER_BEHAVIORS = ['hide', 'collapse', 'highlight', 'hideFilter', 'none']
/** Every priority on the scale. */
const SCALE = Array.from({ length: MAX_PRIORITY - MIN_PRIORITY + 1 }, (_, i) => MIN_PRIORITY + i)

describe('ruleValueMatches', () => {
  test('exact is case-sensitive; contains and regex are not', () => {
    assert.ok(ruleValueMatches({ value: 'Slow Burn', matcher: 'exact' }, 'Slow Burn'))
    assert.ok(!ruleValueMatches({ value: 'slow burn', matcher: 'exact' }, 'Slow Burn'))
    assert.ok(ruleValueMatches({ value: 'SLOW', matcher: 'contains' }, 'Slow Burn'))
    assert.ok(ruleValueMatches({ value: '^slow.*BURN$', matcher: 'regex' }, 'Slow Burn'))
    assert.ok(!ruleValueMatches({ value: '^burn', matcher: 'regex' }, 'Slow Burn'))
  })

  test('an invalid regex matches nothing rather than throwing', () => {
    assert.equal(ruleValueMatches({ value: '(', matcher: 'regex' }, '('), false)
  })

  /** How many times `pattern` is compiled while `run` runs. */
  function compilations(pattern, run) {
    const Original = globalThis.RegExp
    let count = 0
    globalThis.RegExp = new Proxy(Original, {
      construct(target, args) {
        if (args[0] === pattern)
          count++
        return Reflect.construct(target, args)
      },
    })
    try {
      run()
    }
    finally {
      globalThis.RegExp = Original
    }
    return count
  }

  test('a regex is compiled once, however many names it is tested against', () => {
    const pattern = '^compiled once'
    const count = compilations(pattern, () => {
      for (const subject of ['Compiled once', 'compiled twice', 'Not compiled once'])
        ruleValueMatches({ value: pattern, matcher: 'regex' }, subject)
    })
    assert.equal(count, 1)
  })

  test('an invalid regex is not compiled again either', () => {
    const pattern = '(never closed'
    const count = compilations(pattern, () => {
      for (let i = 0; i < 3; i++)
        assert.equal(ruleValueMatches({ value: pattern, matcher: 'regex' }, pattern), false)
    })
    assert.equal(count, 1)
  })

  test('a rule whose pattern changes matches by the new one', () => {
    const live = { value: '^old', matcher: 'regex' }
    assert.ok(ruleValueMatches(live, 'Old Name'))
    live.value = '^new'
    assert.ok(!ruleValueMatches(live, 'Old Name'))
    assert.ok(ruleValueMatches(live, 'New Name'))
  })
})

describe('rulePriority', () => {
  test('an unset priority follows the behaviour', () => {
    assert.equal(rulePriority(rule({}), SETTINGS), MIN_PRIORITY, 'hide is the default behaviour')
    // Collapsing is a hide that leaves a trace, so it starts out just as strong.
    for (const behavior of OTHER_BEHAVIORS)
      assert.equal(rulePriority(rule({ behavior }), SETTINGS), MIN_PRIORITY, behavior)
    assert.equal(rulePriority(rule({ behavior: 'invert' }), SETTINGS), ALWAYS_SHOW)
  })

  test('out of the box, "always show" beats an ordinary hide, with room above it', () => {
    // What it meant before priorities existed — and a hide can still be raised
    // over it.
    assert.ok(ALWAYS_SHOW > MIN_PRIORITY)
    assert.ok(ALWAYS_SHOW < MAX_PRIORITY)
  })

  test('an "always show" with no priority of its own takes the setting', () => {
    for (const alwaysShowPriority of SCALE) {
      assert.equal(rulePriority(rule({ behavior: 'invert' }), { alwaysShowPriority }), alwaysShowPriority)
      assert.equal(defaultRulePriority('invert', { alwaysShowPriority }), alwaysShowPriority)
    }
  })

  test('the setting moves no other behaviour', () => {
    for (const alwaysShowPriority of SCALE) {
      for (const behavior of OTHER_BEHAVIORS)
        assert.equal(rulePriority(rule({ behavior }), { alwaysShowPriority }), MIN_PRIORITY, `${behavior} with the setting at ${alwaysShowPriority}`)
    }
  })

  test('settings stored before the setting existed read as the shipped default', () => {
    assert.equal(rulePriority(rule({ behavior: 'invert' }), {}), ALWAYS_SHOW)
  })

  test('the setting is clamped to the scale, and junk reads as the shipped default', () => {
    assert.equal(defaultRulePriority('invert', { alwaysShowPriority: MAX_PRIORITY + 5 }), MAX_PRIORITY)
    assert.equal(defaultRulePriority('invert', { alwaysShowPriority: MIN_PRIORITY - 5 }), MIN_PRIORITY)
    assert.equal(defaultRulePriority('invert', { alwaysShowPriority: MIN_PRIORITY + 1.7 }), MIN_PRIORITY + 1)
    assert.equal(defaultRulePriority('invert', { alwaysShowPriority: Number.NaN }), ALWAYS_SHOW)
    assert.equal(defaultRulePriority('invert', { alwaysShowPriority: String(MAX_PRIORITY) }), ALWAYS_SHOW, 'not a number at all')
  })

  test('an explicit priority wins over the behaviour default', () => {
    const own = (ALWAYS_SHOW + 1) % (MAX_PRIORITY + 1)
    assert.equal(rulePriority(rule({ behavior: 'invert', priority: own }), SETTINGS), own)
    assert.equal(rulePriority(rule({ behavior: 'invert', priority: own }), { alwaysShowPriority: MAX_PRIORITY }), own, 'whatever the setting says')
    assert.equal(rulePriority(rule({ behavior: 'hide', priority: 7 }), SETTINGS), 7)
    assert.equal(rulePriority(rule({ priority: 0 }), SETTINGS), 0)
  })

  test('clamps to 0-9 and ignores junk', () => {
    assert.equal(rulePriority(rule({ priority: 42 }), SETTINGS), 9)
    assert.equal(rulePriority(rule({ priority: -3 }), SETTINGS), 0)
    assert.equal(rulePriority(rule({ priority: 3.7 }), SETTINGS), 3)
    assert.equal(rulePriority(rule({ behavior: 'invert', priority: Number.NaN }), SETTINGS), ALWAYS_SHOW, 'falls back to the default')
  })

  test('a hide rule can be raised above a force-show', () => {
    // The point of the whole feature: an "always show" tag no longer overrules a
    // fandom you never want to see, as long as you say so.
    const alwaysShow = rule({ behavior: 'invert' })
    const hardHide = rule({ target: TagType.Fandom, value: 'Naruto', behavior: 'hide', priority: ALWAYS_SHOW + 1 })
    assert.ok(rulePriority(hardHide, SETTINGS) > rulePriority(alwaysShow, SETTINGS))
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

  test('a regex keeps its negated classes', () => {
    // Case-insensitivity comes from the `i` flag. Lower-casing the pattern
    // instead rewrote every negated class into its opposite, so each of these
    // matched exactly the set the reader had written it to skip. Each pair is
    // the escape and its negation, and they must disagree.
    assert.ok(!ruleMatchesTag(rule({ value: 'Slow\\S*Burn', matcher: 'regex' }), tag))
    assert.ok(ruleMatchesTag(rule({ value: 'Slow\\s*Burn', matcher: 'regex' }), tag))

    assert.ok(ruleMatchesTag(rule({ value: 'Slow\\WBurn', matcher: 'regex' }), tag))
    assert.ok(!ruleMatchesTag(rule({ value: 'Slow\\wBurn', matcher: 'regex' }), tag))

    assert.ok(ruleMatchesTag(rule({ value: '\\D{4}', matcher: 'regex' }), tag))
    assert.ok(!ruleMatchesTag(rule({ value: '\\d{4}', matcher: 'regex' }), tag))

    assert.ok(ruleMatchesTag(rule({ value: '\\Bl', matcher: 'regex' }), tag))
    assert.ok(!ruleMatchesTag(rule({ value: '\\bl', matcher: 'regex' }), tag))
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
  test('only hiding, collapsing and force-showing decide whether a work is shown', () => {
    assert.equal(ruleAffectsWorks(rule({})), true, 'hide is the default behaviour')
    assert.equal(ruleAffectsWorks(rule({ behavior: 'hide' })), true)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'collapse' })), true)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'invert' })), true)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'highlight' })), false)
    assert.equal(ruleAffectsWorks(rule({ behavior: 'hideFilter' })), false)
  })

  test('a disabled rule takes no part, whatever else it carries', () => {
    assert.equal(ruleAffectsWorks(rule({ behavior: 'none' })), false)
    // Priority and colour survive for when it is turned back on; neither lets it
    // back into the contest while it is off.
    assert.equal(ruleAffectsWorks(rule({ behavior: 'none', priority: 9, color: '#abcdefff' })), false)
    assert.equal(rulePriority(rule({ behavior: 'none', priority: 7 }), SETTINGS), 7)
  })
})

describe('ruleHasPriority', () => {
  test('a rule that decides whether a work is shown has one, and so does a switched-off rule', () => {
    for (const behavior of [undefined, 'hide', 'collapse', 'invert', 'none'])
      assert.equal(ruleHasPriority(rule({ behavior })), true, String(behavior))
  })

  test('a rule that only changes how its match is drawn has none', () => {
    for (const behavior of ['highlight', 'hideFilter'])
      assert.equal(ruleHasPriority(rule({ behavior })), false, behavior)
  })
})

describe('ruleHideMode', () => {
  test('only a collapse rule collapses; everything else takes the work away', () => {
    assert.equal(ruleHideMode(rule({ behavior: 'collapse' })), 'collapse')
    assert.equal(ruleHideMode(rule({ behavior: 'hide' })), 'hide')
    // A rule written before collapsing existed carries no behavior at all, and
    // means the same thing "Hide fully" used to: the work leaves the listing.
    assert.equal(ruleHideMode(rule({})), 'hide')
  })
})

describe('excludesFromSearch', () => {
  test('at the shipped minimum, a hide rule of any priority is handed to the search', () => {
    for (const priority of SCALE)
      assert.equal(excludesFromSearch(priority, OPTION_DEFAULTS.autoExcludeMinPriority), true, `priority ${priority}`)
  })

  test('a minimum of 2 holds back rules of 0 and 1, and hands over 2 and up', () => {
    for (const priority of SCALE)
      assert.equal(excludesFromSearch(priority, 2), priority >= 2, `priority ${priority}`)
  })

  test('the minimum itself is enough', () => {
    assert.equal(excludesFromSearch(MAX_PRIORITY, MAX_PRIORITY), true)
    assert.equal(excludesFromSearch(MAX_PRIORITY - 1, MAX_PRIORITY), false)
  })

  test('a minimum that isn\'t a number counts as the lowest, so nothing is held back', () => {
    for (const min of [undefined, null, 'x', Number.NaN])
      assert.equal(excludesFromSearch(MIN_PRIORITY, min), true, `min ${String(min)}`)
  })

  test('a minimum off the scale is brought onto it', () => {
    assert.equal(excludesFromSearch(MAX_PRIORITY, MAX_PRIORITY + 5), true, 'above the top still lets the strongest rule through')
    assert.equal(excludesFromSearch(MIN_PRIORITY, -3), true)
    assert.equal(excludesFromSearch(1, 1.9), true, 'a fraction is cut to its whole part')
  })
})
