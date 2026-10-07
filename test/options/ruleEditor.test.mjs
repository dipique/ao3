import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { DEFAULT_AUTHOR_HIGHLIGHT_COLOR, DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_PRESETS, RULE_TARGETS, ruleMatchesAuthor, ruleMatchesEntity, ruleMatchesTag, ruleValueMatches, TagType } from '../../src/common/data.ts'
import { canSave, describeRule, draftRule, openDraft, parseAutocomplete, regexTester, regexVerdict, RULE_ACTIONS, ruleSummary, suggestSource, swatchFor, usesColor, usesPriority, valueField, withAction, withSwatch, withTarget } from '../../src/options_ui/model/ruleEditor.ts'

/** AO3's answers to its tag autocomplete, recorded signed out and trimmed to a few names each, keyed by request. */
const RECORDED = JSON.parse(readFileSync(new URL('./ao3-autocomplete.json', import.meta.url), 'utf8'))

/** The recorded answer from one endpoint. */
const recorded = endpoint => Object.entries(RECORDED).find(([request]) => request.split('?')[0] === endpoint)?.[1]

const NO_COLORS = {}

/** A draft opened on `rule`, given the default colours. */
const opened = (rule, colors = NO_COLORS) => openDraft(rule, colors)

/** What saving the draft writes. */
const saved = (draft, colors = NO_COLORS) => draftRule(draft, colors)

describe('HIGHLIGHT_PRESETS', () => {
  test('Sky, Amber and Violet, in that order', () => {
    assert.deepEqual(HIGHLIGHT_PRESETS, [
      { name: 'Sky', color: '#0ea5e9' },
      { name: 'Amber', color: '#f59e0b' },
      { name: 'Violet', color: '#7c3aed' },
    ])
  })
})

describe('the actions', () => {
  test('are today\'s behaviours but none, which the Rule Enabled switch stands for', () => {
    assert.deepEqual(RULE_ACTIONS.map(action => action.value), ['hide', 'collapse', 'highlight', 'invert', 'hideFilter'])
    assert.deepEqual(RULE_ACTIONS.map(action => action.label), ['Hide Work', 'Collapse', 'Highlight', 'Always show', 'Hide Tag'])
    for (const action of RULE_ACTIONS)
      assert.ok(action.help.endsWith('.'), `${action.value} has a sentence of help`)
  })

  test('a colour is for Highlight and Always show', () => {
    assert.deepEqual(RULE_ACTIONS.map(action => action.value).filter(usesColor), ['highlight', 'invert'])
  })

  test('a priority is for the actions that enter the contest over a work: not Highlight or Hide Tag', () => {
    assert.deepEqual(RULE_ACTIONS.map(action => action.value).filter(usesPriority), ['hide', 'collapse', 'invert'])
  })
})

describe('swatchFor', () => {
  test('no colour of the rule\'s own is Default', () => {
    assert.equal(swatchFor(undefined, DEFAULT_HIGHLIGHT_COLOR), 'default')
    assert.equal(swatchFor('', DEFAULT_HIGHLIGHT_COLOR), 'default')
  })

  test('a colour equal to a preset shows that preset, whatever its case', () => {
    assert.equal(swatchFor('#0ea5e9', DEFAULT_HIGHLIGHT_COLOR), 'Sky')
    assert.equal(swatchFor('#F59E0B', DEFAULT_HIGHLIGHT_COLOR), 'Amber')
    assert.equal(swatchFor(' #7c3aed ', DEFAULT_HIGHLIGHT_COLOR), 'Violet')
  })

  test('a colour equal to the target\'s default shows Default, even where that default is a preset', () => {
    assert.equal(swatchFor(DEFAULT_HIGHLIGHT_COLOR, DEFAULT_HIGHLIGHT_COLOR), 'default')
    assert.equal(swatchFor('#0ea5e9', '#0EA5E9'), 'default')
  })

  test('any other colour is Custom', () => {
    assert.equal(swatchFor('#123456', DEFAULT_HIGHLIGHT_COLOR), 'custom')
    assert.equal(swatchFor('#0ea5e980', DEFAULT_HIGHLIGHT_COLOR), 'custom')
  })
})

describe('openDraft', () => {
  test('Add opens on an enabled Hide Work rule for any tag, matched exactly, at the default priority and colour', () => {
    assert.deepEqual(opened(undefined), {
      target: 'tag',
      value: '',
      pseud: '',
      matcher: 'exact',
      action: 'hide',
      enabled: true,
      priority: 0,
      swatch: 'default',
      color: DEFAULT_HIGHLIGHT_COLOR,
      noHighlight: false,
      kept: undefined,
    })
  })

  test('an edited rule opens on its own fields', () => {
    const draft = opened({ target: 'author', value: 'someone', pseud: 'sideblog', matcher: 'contains', behavior: 'invert', priority: 7, color: '#f59e0b' })
    assert.equal(draft.target, 'author')
    assert.equal(draft.value, 'someone')
    assert.equal(draft.pseud, 'sideblog')
    assert.equal(draft.matcher, 'contains')
    assert.equal(draft.action, 'invert')
    assert.equal(draft.enabled, true)
    assert.equal(draft.priority, 7)
    assert.equal(draft.swatch, 'Amber')
    assert.equal(draft.color, '#f59e0b')
  })

  test('a rule stored without a behaviour or priority reads as Hide Work at its default', () => {
    const draft = opened({ target: 'F', value: 'Fluff', matcher: 'exact' })
    assert.equal(draft.action, 'hide')
    assert.equal(draft.priority, 0)
    assert.equal(opened({ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'invert' }).priority, 4)
  })

  test('a disabled rule opens switched off, on Hide Work, with its priority and colour kept', () => {
    const draft = opened({ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'none', priority: 4, color: '#123456' })
    assert.equal(draft.enabled, false)
    assert.equal(draft.action, 'hide')
    assert.equal(draft.priority, 4)
    assert.equal(draft.kept, '#123456')
  })

  test('a custom colour opens on Custom, with the picker on that colour', () => {
    const draft = opened({ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight', color: '#123456' })
    assert.equal(draft.swatch, 'custom')
    assert.equal(draft.color, '#123456')
  })

  test('a colour equal to the target\'s default, as the reader set it, opens on Default', () => {
    const draft = opened({ target: 'author', value: 'a', matcher: 'exact', behavior: 'highlight', color: '#abcdef' }, { author: '#abcdef' })
    assert.equal(draft.swatch, 'default')
  })

  test('with no colour of its own the picker starts on the target\'s default', () => {
    assert.equal(opened({ target: 'author', value: 'a', matcher: 'exact', behavior: 'highlight' }).color, DEFAULT_AUTHOR_HIGHLIGHT_COLOR)
    assert.equal(opened({ target: 'author', value: 'a', matcher: 'exact', behavior: 'highlight' }, { author: '#abcdef' }).color, '#abcdef')
  })

  test('an Always show rule with no highlight opens with No highlight on and the colour on Default', () => {
    const draft = opened({ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'invert', color: 'transparent' })
    assert.equal(draft.noHighlight, true)
    assert.equal(draft.swatch, 'default')
    assert.equal(draft.color, DEFAULT_HIGHLIGHT_COLOR)
  })
})

describe('withAction', () => {
  test('choosing an action sets the priority it implies', () => {
    const always = withAction(opened(undefined), 'invert')
    assert.equal(always.action, 'invert')
    assert.equal(always.priority, 4)
    assert.equal(withAction({ ...always, priority: 8 }, 'collapse').priority, 0)
  })

  test('choosing the action already chosen keeps a priority typed over it', () => {
    const draft = { ...withAction(opened(undefined), 'invert'), priority: 8 }
    assert.equal(withAction(draft, 'invert').priority, 8)
  })

  test('Hide Tag is refused for an author, a work or a series', () => {
    for (const target of ['author', 'work', 'series']) {
      const draft = withTarget(opened(undefined), target)
      assert.equal(withAction(draft, 'hideFilter'), draft, target)
    }
    assert.equal(withAction(opened(undefined), 'hideFilter').action, 'hideFilter')
  })
})

describe('withTarget', () => {
  test('Hide Tag falls back to Hide Work when the rule stops being about a tag', () => {
    const hideTag = withAction(opened(undefined), 'hideFilter')
    assert.equal(withTarget(hideTag, 'R').action, 'hideFilter')
    const author = withTarget(hideTag, 'author')
    assert.equal(author.action, 'hide')
    assert.equal(author.priority, 0)
  })

  test('a pseud goes when the rule stops being about an author', () => {
    const author = { ...withTarget(opened(undefined), 'author'), pseud: 'sideblog' }
    assert.equal(withTarget(author, 'author').pseud, 'sideblog')
    assert.equal(withTarget(author, 'work').pseud, '')
  })

  test('leaves the rest alone', () => {
    const draft = { ...opened(undefined), value: 'Fluff', matcher: 'regex', priority: 3 }
    assert.deepEqual(withTarget(draft, 'F'), { ...draft, target: 'F' })
  })
})

describe('withSwatch', () => {
  test('a preset puts its colour in the picker, so Custom starts from it', () => {
    const amber = withSwatch(opened(undefined), 'Amber')
    assert.equal(amber.swatch, 'Amber')
    assert.equal(amber.color, '#f59e0b')
    const custom = withSwatch(amber, 'custom')
    assert.equal(custom.swatch, 'custom')
    assert.equal(custom.color, '#f59e0b')
  })

  test('Default leaves the picker where it was', () => {
    const draft = withSwatch(withSwatch(opened(undefined), 'Violet'), 'default')
    assert.equal(draft.swatch, 'default')
    assert.equal(draft.color, '#7c3aed')
  })
})

describe('draftRule', () => {
  const base = { ...opened(undefined), value: 'Fluff', target: 'F' }

  test('the defaults are stored as missing: Hide Work, its own priority, the target\'s colour, no pseud', () => {
    assert.deepEqual(saved(base), { target: 'F', value: 'Fluff', matcher: 'exact' })
  })

  test('stores what differs from the defaults', () => {
    const draft = { ...withAction(base, 'collapse'), matcher: 'contains', priority: 6 }
    assert.deepEqual(saved(draft), { target: 'F', value: 'Fluff', matcher: 'contains', behavior: 'collapse', priority: 6 })
  })

  test('a pseud is stored only for an author, and only when given', () => {
    const author = { ...withTarget(base, 'author'), value: 'someone', pseud: 'sideblog' }
    assert.equal(saved(author).pseud, 'sideblog')
    assert.equal('pseud' in saved({ ...author, pseud: '' }), false)
    assert.equal('pseud' in saved({ ...base, pseud: 'stray' }), false)
  })

  test('Amber writes #f59e0b', () => {
    const draft = withSwatch(withAction(base, 'highlight'), 'Amber')
    assert.deepEqual(saved(draft), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight', color: '#f59e0b' })
  })

  test('Default writes no colour of the rule\'s own', () => {
    const draft = withSwatch(withSwatch(withAction(base, 'highlight'), 'Amber'), 'default')
    assert.equal('color' in saved(draft), false)
  })

  test('Custom writes the picker\'s colour, unless it is the target\'s default', () => {
    const custom = withSwatch(withAction(base, 'highlight'), 'custom')
    assert.equal(saved({ ...custom, color: '#123456' }).color, '#123456')
    assert.equal('color' in saved({ ...custom, color: DEFAULT_HIGHLIGHT_COLOR }), false)
    assert.equal('color' in saved({ ...custom, color: '#abcdef' }, { F: '#ABCDEF' }), false)
  })

  test('a preset that is the target\'s default writes no colour', () => {
    const draft = withSwatch(withAction(base, 'highlight'), 'Sky')
    assert.equal('color' in saved(draft, { F: '#0ea5e9' }), false)
  })

  test('Always show writes its colour too, or transparent for No highlight', () => {
    const always = withSwatch(withAction(base, 'invert'), 'Violet')
    assert.equal(saved(always).color, '#7c3aed')
    assert.equal(saved({ ...always, noHighlight: true }).color, 'transparent')
  })

  test('No highlight means nothing to a Highlight rule', () => {
    const draft = { ...withSwatch(withAction(base, 'highlight'), 'Violet'), noHighlight: true }
    assert.equal(saved(draft).color, '#7c3aed')
  })

  test('an action that draws no colour stores none', () => {
    const draft = withAction(withSwatch(withAction(base, 'highlight'), 'Amber'), 'collapse')
    assert.equal('color' in saved(draft), false)
  })

  test('switched off it stores behaviour none, keeping the priority', () => {
    const draft = { ...withAction(base, 'invert'), enabled: false }
    assert.deepEqual(saved(draft), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'none', priority: 4 })
  })

  test('switched off it keeps the colour its action would draw', () => {
    const draft = { ...withSwatch(withAction(base, 'highlight'), 'Amber'), enabled: false }
    assert.equal(saved(draft).color, '#f59e0b')
  })

  test('switched off, an action that draws no colour keeps the colour the rule was opened with', () => {
    const draft = opened({ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'none', color: 'transparent' })
    assert.deepEqual(saved(draft), { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'none', color: 'transparent' })
  })

  test('switched on again, it is the action it shows', () => {
    const draft = { ...opened({ target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'none', priority: 4 }), enabled: true }
    assert.deepEqual(saved(draft), { target: 'F', value: 'Fluff', matcher: 'exact', priority: 4 })
  })

  test('a rule opened and saved unchanged is stored as it was', () => {
    const rules = [
      { target: 'author', value: 'someone', pseud: 'sideblog', matcher: 'exact', behavior: 'collapse' },
      { target: 'R', value: 'Steve Rogers/', matcher: 'contains', behavior: 'invert' },
      { target: 'F', value: 'Fluff', matcher: 'exact', behavior: 'highlight', color: '#7c3aed' },
      { target: 'tag', value: 'Dead Dove: Do Not Eat', matcher: 'exact', behavior: 'none' },
      { target: 'w', value: 'Major Character Death', matcher: 'exact', priority: 6 },
      { target: 'C', value: '^(Original|OC)\\b', matcher: 'regex', behavior: 'hideFilter' },
      { target: 'R', value: 'x', matcher: 'exact', behavior: 'invert', color: 'transparent' },
      { target: 'work', value: '123', matcher: 'exact', behavior: 'none', priority: 2, color: '#123456' },
    ]
    for (const rule of rules)
      assert.deepEqual(saved(opened(rule)), rule)
  })
})

describe('canSave', () => {
  test('needs something to match', () => {
    assert.equal(canSave(opened(undefined)), false)
    assert.equal(canSave({ ...opened(undefined), value: '   ' }), false)
    assert.equal(canSave({ ...opened(undefined), value: 'Fluff' }), true)
  })
})

describe('valueField', () => {
  test('is labelled for what the rule matches', () => {
    assert.equal(valueField('tag', 'exact', '').label, 'Tag')
    assert.equal(valueField('F', 'exact', '').label, 'Tag')
    assert.equal(valueField('f', 'exact', '').label, 'Fandom')
    assert.equal(valueField('author', 'exact', '').label, 'Author')
    assert.equal(valueField('work', 'exact', '').label, 'Work')
    assert.equal(valueField('series', 'exact', '').label, 'Series')
  })

  test('says how each matcher reads the text', () => {
    assert.match(valueField('author', 'exact', '').help, /exactly/)
    assert.match(valueField('F', 'contains', '').help, /contains this text, ignoring case/)
    assert.match(valueField('F', 'regex', '').help, /regular expression.*ignoring case/)
    assert.match(valueField('author', 'contains', '').help, /username/)
    assert.match(valueField('work', 'regex', '').help, /title/)
  })

  test('in Exact mode, says where the suggestions come from, so the rule takes AO3\'s spelling', () => {
    for (const target of [TagType.Fandom, TagType.Character, TagType.Relationship, TagType.Freeform])
      assert.equal(valueField(target, 'exact', '').help, 'Suggestions come from AO3’s tag autocomplete, so the rule uses AO3’s own spelling.', target)
    for (const target of [TagType.Rating, TagType.ArchiveWarning, TagType.Category])
      assert.equal(valueField(target, 'exact', '').help, 'Suggestions are the archive’s own names, so the rule uses AO3’s own spelling.', target)
  })

  test('asks for typing where suggestions follow it, and for the name where they don\'t', () => {
    assert.equal(valueField('F', 'exact', '').placeholder, 'Start typing a tag…')
    assert.equal(valueField('r', 'exact', '').placeholder, 'Start typing a tag…')
    assert.equal(valueField('f', 'exact', '').placeholder, 'Start typing a fandom…')
    assert.equal(valueField('F', 'contains', '').placeholder, 'Tag name')
    assert.equal(valueField('f', 'regex', '').placeholder, 'Fandom name')
    assert.equal(valueField('author', 'exact', '').placeholder, 'Username')
    assert.equal(valueField('work', 'exact', '').placeholder, 'Work title or id')
  })

  test('a number for a work or a series matches its id, whatever the matcher', () => {
    for (const target of ['work', 'series']) {
      const field = valueField(target, 'regex', ' 4232377 ')
      assert.equal(field.byId, true, target)
      assert.match(field.help, /id/)
    }
    assert.equal(valueField('F', 'exact', '4232377').byId, false)
    assert.equal(valueField('work', 'exact', '42a').byId, false)
  })
})

describe('regexVerdict', () => {
  test('tests the pattern ignoring case', () => {
    assert.deepEqual(regexVerdict('^slow.*burn$', 'Slow Burn'), { kind: 'match' })
    assert.deepEqual(regexVerdict('^SLOW', 'slow burn'), { kind: 'match' })
    assert.deepEqual(regexVerdict('^burn', 'Slow Burn'), { kind: 'miss' })
  })

  test('a negated class keeps its meaning under the i flag', () => {
    // Each pair is an escape and its negation, which must disagree.
    for (const [miss, match] of [['Slow\\S*Burn', 'Slow\\s*Burn'], ['Slow\\wBurn', 'Slow\\WBurn'], ['\\d{4}', '\\D{4}'], ['\\bl', '\\Bl']]) {
      assert.deepEqual(regexVerdict(miss, 'Slow Burn'), { kind: 'miss' }, miss)
      assert.deepEqual(regexVerdict(match, 'Slow Burn'), { kind: 'match' }, match)
    }
    assert.deepEqual(regexVerdict('omega\\S+verse', 'Omega Verse'), { kind: 'miss' })
  })

  test('an unterminated group is an invalid pattern, with the engine\'s reason, and a live rule matches nothing with it', () => {
    assert.deepEqual(regexVerdict('(slow', 'slow'), { kind: 'invalid', reason: 'Unterminated group' })
    assert.equal(ruleValueMatches({ value: '(slow', matcher: 'regex' }, 'slow'), false)
  })

  test('the reason leaves out the pattern the engine repeats, however the pattern reads, and starts with a capital', () => {
    assert.deepEqual(regexVerdict('x/i: (', 'x'), { kind: 'invalid', reason: 'Unterminated group' })
    assert.deepEqual(regexVerdict('a{2,1}', 'a'), { kind: 'invalid', reason: 'Numbers out of order in {} quantifier' })
  })

  test('an invalid pattern says so before anything is typed to test', () => {
    assert.deepEqual(regexVerdict('[', ''), { kind: 'invalid', reason: 'Unterminated character class' })
  })

  test('no verdict without a pattern, or without something to test', () => {
    assert.deepEqual(regexVerdict('', 'Slow Burn'), { kind: 'none' })
    assert.deepEqual(regexVerdict('   ', 'Slow Burn'), { kind: 'none' })
    assert.deepEqual(regexVerdict('slow', ''), { kind: 'none' })
  })
})

describe('regexTester', () => {
  const tester = (target, value, subject) => regexTester({ target, matcher: 'regex', value }, subject)

  test('is there in Regex mode only', () => {
    assert.equal(regexTester({ target: 'tag', matcher: 'exact', value: 'slow' }, 'Slow Burn'), null)
    assert.equal(regexTester({ target: 'tag', matcher: 'contains', value: 'slow' }, 'Slow Burn'), null)
    assert.notEqual(tester('tag', 'slow', 'Slow Burn'), null)
  })

  test('is not there while a work\'s or a series\' number matches its id', () => {
    assert.equal(tester('work', ' 4232377 ', '4232377'), null)
    assert.equal(tester('series', '4232377', '4232377'), null)
    assert.notEqual(tester('work', '42a', '42a'), null)
    assert.notEqual(tester(TagType.Freeform, '4232377', '4232377'), null)
  })

  test('asks for what the pattern is tested against', () => {
    for (const target of ['tag', TagType.Fandom, TagType.Freeform, TagType.Rating]) {
      assert.equal(tester(target, 'slow', '').placeholder, 'Type a tag to test the pattern against', target)
      assert.equal(tester(target, 'slow', '').label, 'Type a tag', target)
    }
    assert.equal(tester('author', 'some', '').placeholder, 'Type a username to test the pattern against')
    assert.equal(tester('author', 'some', '').label, 'Type a username')
    for (const target of ['work', 'series']) {
      assert.equal(tester(target, 'Saga', '').placeholder, 'Type a title to test the pattern against', target)
      assert.equal(tester(target, 'Saga', '').label, 'Type a title', target)
    }
  })

  test('with no pattern, says there is none yet', () => {
    assert.equal(tester('tag', '', 'Slow Burn').label, 'No pattern yet')
    assert.equal(tester('tag', '  ', '').label, 'No pattern yet')
  })

  test('names each verdict', () => {
    assert.deepEqual(tester('tag', '^slow', 'Slow Burn').verdict, { kind: 'match' })
    assert.equal(tester('tag', '^slow', 'Slow Burn').label, 'Matches')
    assert.equal(tester('tag', '^burn', 'Slow Burn').label, 'No match')
    assert.equal(tester('tag', '(slow', 'Slow Burn').label, 'Invalid pattern')
  })

  test('the line under it says nothing is saved from it, or why the pattern is refused', () => {
    for (const [value, subject] of [['', ''], ['^slow', ''], ['^slow', 'Slow Burn'], ['^burn', 'Slow Burn']])
      assert.equal(tester('tag', value, subject).help, 'Checks the pattern as you type. Nothing is saved from here.', `${value} / ${subject}`)
    assert.equal(tester('tag', '(slow', '').help, 'Unterminated group')
  })

  test('agrees with live rules on every kind of target, which trim a work\'s or a series\' pattern only', () => {
    const subject = 'Her Kindness'
    const live = {
      [TagType.Freeform]: value => ruleMatchesTag({ target: TagType.Freeform, value, matcher: 'regex' }, { name: subject, type: TagType.Freeform }),
      author: value => ruleMatchesAuthor({ target: 'author', value, matcher: 'regex' }, { userId: subject }),
      work: value => ruleMatchesEntity({ target: 'work', value, matcher: 'regex' }, 'work', { name: subject }),
      series: value => ruleMatchesEntity({ target: 'series', value, matcher: 'regex' }, 'series', { name: subject }),
    }
    for (const [target, matches] of Object.entries(live)) {
      for (const value of ['^her', ' ^her', 'KIND', 'kind ', '\\S+\\s\\S+', '(her']) {
        const verdict = tester(target, value, subject).verdict
        assert.equal(verdict.kind === 'match', matches(value), `${target}: ${JSON.stringify(value)} gave ${verdict.kind}`)
      }
    }
    assert.equal(tester('work', ' ^her', subject).verdict.kind, 'match')
    assert.equal(tester(TagType.Freeform, ' ^her', subject).verdict.kind, 'miss')
  })
})

describe('describeRule', () => {
  const rule = fields => ({ target: 'F', value: 'Fluff', matcher: 'exact', ...fields })

  test('says what each action does to the works it matches', () => {
    assert.equal(describeRule(rule({})), 'Hide every work tagged “Fluff” in Additional Tags.')
    assert.equal(describeRule(rule({ behavior: 'collapse' })), 'Collapse every work tagged “Fluff” in Additional Tags.')
    assert.equal(describeRule(rule({ behavior: 'invert' })), 'Always show every work tagged “Fluff” in Additional Tags.')
    assert.equal(describeRule(rule({ behavior: 'highlight' })), 'Highlight the match on every work tagged “Fluff” in Additional Tags.')
  })

  test('a Hide Tag rule leaves the works alone', () => {
    assert.equal(describeRule(rule({ behavior: 'hideFilter' })), 'Hide the tag “Fluff” in Additional Tags from tag lists and the filter sidebar; the works stay.')
    assert.equal(describeRule(rule({ target: 'tag', matcher: 'regex', value: '^OC', behavior: 'hideFilter' })), 'Hide every tag matching “^OC” from tag lists and the filter sidebar; the works stay.')
  })

  test('a disabled rule does nothing', () => {
    assert.equal(describeRule(rule({ behavior: 'none' })), 'Off: does nothing to every work tagged “Fluff” in Additional Tags.')
  })

  test('any tag, and how a tag is matched', () => {
    assert.equal(describeRule(rule({ target: 'tag' })), 'Hide every work tagged “Fluff”.')
    assert.equal(describeRule(rule({ target: 'R', matcher: 'contains', value: 'Steve Rogers/' })), 'Hide every work with a tag containing “Steve Rogers/” in Relationship.')
    assert.equal(describeRule(rule({ target: 'tag', matcher: 'regex', value: '^OC' })), 'Hide every work with a tag matching “^OC”.')
  })

  test('an author, with and without a pseud', () => {
    assert.equal(describeRule(rule({ target: 'author', value: 'someone' })), 'Hide every work by “someone”.')
    assert.equal(describeRule(rule({ target: 'author', value: 'someone', pseud: 'sideblog' })), 'Hide every work by “someone” writing as “sideblog”.')
    assert.equal(describeRule(rule({ target: 'author', value: 'some', matcher: 'contains' })), 'Hide every work by an author whose username contains “some”.')
    assert.equal(describeRule(rule({ target: 'author', value: '^some', matcher: 'regex' })), 'Hide every work by an author whose username matches “^some”.')
  })

  test('a work or a series, by title or by id', () => {
    assert.equal(describeRule(rule({ target: 'work', value: 'Title' })), 'Hide the work “Title”.')
    assert.equal(describeRule(rule({ target: 'work', value: 'Tit', matcher: 'contains' })), 'Hide every work whose title contains “Tit”.')
    assert.equal(describeRule(rule({ target: 'work', value: ' 123 ', matcher: 'regex' })), 'Hide the work with id 123.')
    assert.equal(describeRule(rule({ target: 'series', value: 'Saga' })), 'Hide every work in the series “Saga”.')
    assert.equal(describeRule(rule({ target: 'series', value: 'Sa', matcher: 'regex' })), 'Hide every work in a series whose title matches “Sa”.')
    assert.equal(describeRule(rule({ target: 'series', value: '4232377' })), 'Hide every work in the series with id 4232377.')
  })

  test('a priority is mentioned only where it differs from its action\'s default, and the action has one', () => {
    assert.equal(describeRule(rule({ priority: 6 })), 'Hide every work tagged “Fluff” in Additional Tags, at priority 6.')
    assert.equal(describeRule(rule({ behavior: 'invert', priority: 4 })), 'Always show every work tagged “Fluff” in Additional Tags.')
    assert.equal(describeRule(rule({ behavior: 'invert', priority: 2 })), 'Always show every work tagged “Fluff” in Additional Tags, at priority 2.')
    assert.equal(describeRule(rule({ behavior: 'highlight', priority: 3 })), 'Highlight the match on every work tagged “Fluff” in Additional Tags.')
    assert.equal(describeRule(rule({ behavior: 'none', priority: 3 })), 'Off: does nothing to every work tagged “Fluff” in Additional Tags.')
  })

  test('with nothing typed yet, the value is an ellipsis', () => {
    assert.equal(describeRule(rule({ value: '' })), 'Hide every work tagged … in Additional Tags.')
    assert.equal(describeRule(rule({ value: '  ', target: 'author' })), 'Hide every work by …')
  })
})

describe('suggestSource', () => {
  test('any tag asks AO3\'s tag autocomplete, and a fandom, character, relationship or additional tag the endpoint for its kind', () => {
    assert.deepEqual(['tag', TagType.Fandom, TagType.Character, TagType.Relationship, TagType.Freeform].map(suggestSource), [
      { kind: 'ao3', endpoint: '/autocomplete/tag' },
      { kind: 'ao3', endpoint: '/autocomplete/fandom' },
      { kind: 'ao3', endpoint: '/autocomplete/character' },
      { kind: 'ao3', endpoint: '/autocomplete/relationship' },
      { kind: 'ao3', endpoint: '/autocomplete/freeform' },
    ])
  })

  test('every endpoint it asks was recorded answering', () => {
    const endpoints = RULE_TARGETS.map(suggestSource).filter(source => source.kind === 'ao3').map(source => source.endpoint)
    assert.equal(endpoints.length, 5)
    for (const endpoint of endpoints)
      assert.ok(recorded(endpoint)?.length, `${endpoint} has a recorded answer`)
  })

  test('a rating, an archive warning or a category offers the archive\'s fixed names, and asks nothing', () => {
    assert.deepEqual(suggestSource(TagType.Rating), {
      kind: 'fixed',
      names: ['General Audiences', 'Teen And Up Audiences', 'Mature', 'Explicit', 'Not Rated'],
    })
    assert.deepEqual(suggestSource(TagType.ArchiveWarning), {
      kind: 'fixed',
      names: ['Creator Chose Not To Use Archive Warnings', 'Graphic Depictions Of Violence', 'Major Character Death', 'No Archive Warnings Apply', 'Rape/Non-Con', 'Underage Sex'],
    })
    assert.deepEqual(suggestSource(TagType.Category), {
      kind: 'fixed',
      names: ['F/F', 'F/M', 'Gen', 'M/M', 'Multi', 'Other'],
    })
  })

  test('an author, a work or a series offers nothing', () => {
    for (const target of ['author', 'work', 'series'])
      assert.deepEqual(suggestSource(target), { kind: 'none' }, target)
  })
})

describe('parseAutocomplete', () => {
  test('AO3\'s answer gives its names in its order, spelled as AO3 spells them', () => {
    assert.deepEqual(parseAutocomplete(recorded('/autocomplete/fandom')), [
      'Harry Potter - J. K. Rowling',
      'Harry Potter and the Cursed Child - Thorne & Rowling',
      'Harry Potter: Hogwarts Mystery (Video Game)',
    ])
    assert.deepEqual(parseAutocomplete(recorded('/autocomplete/tag')), [
      'Pottercest (Harry Potter)',
      'Henry Potter | James Potter\'s Grandfather',
      'Harry Potter & Lily Evans Potter\'s Father',
      'Quote: Scared Potter? (Harry Potter)',
    ])
    assert.deepEqual(parseAutocomplete(recorded('/autocomplete/freeform')), [
      'Song: Just a Little Bit of Your Heart (Ariana Grande)',
      'Aziraphale is "just enough of a bastard to be worth knowing" (Good Omens)',
    ])
  })

  test('an answer that isn\'t a list gives no names', () => {
    for (const json of [null, undefined, {}, 'Harry Potter', 16, { name: 'Harry Potter' }])
      assert.deepEqual(parseAutocomplete(json), [], JSON.stringify(json))
  })

  test('an entry without a name is skipped, and a name given twice is kept once', () => {
    const answer = [
      { id: 'Fluff' },
      null,
      'Angst',
      { id: 7, name: 7 },
      { id: '', name: '' },
      { id: 'Fluff', name: 'Fluff' },
      { id: 'Fluff', name: 'Fluff' },
      { id: 'Angst', name: 'Angst' },
    ]
    assert.deepEqual(parseAutocomplete(answer), ['Fluff', 'Angst'])
  })
})

describe('ruleSummary', () => {
  const rule = fields => ({ target: 'F', value: 'Fluff', matcher: 'exact', ...fields })

  test('the sentence in parts: the action, drawn bold, and the value, drawn as a quote', () => {
    assert.deepEqual(ruleSummary(rule({})), [
      { text: 'Hide', kind: 'verb' },
      { text: ' every work tagged ' },
      { text: '“Fluff”', kind: 'value' },
      { text: ' in Additional Tags.' },
    ])
    assert.deepEqual(ruleSummary(rule({ behavior: 'invert', target: 'author', value: 'someone', pseud: 'sideblog' })), [
      { text: 'Always show', kind: 'verb' },
      { text: ' every work by ' },
      { text: '“someone”', kind: 'value' },
      { text: ' writing as “sideblog”.' },
    ])
    assert.deepEqual(ruleSummary(rule({ behavior: 'none' }))[0], { text: 'Off', kind: 'verb' })
    assert.deepEqual(ruleSummary(rule({ behavior: 'hideFilter' }))[0], { text: 'Hide', kind: 'verb' })
    assert.deepEqual(ruleSummary(rule({ behavior: 'highlight' }))[0], { text: 'Highlight', kind: 'verb' })
  })

  test('an id is no quote, and an untyped value is the ellipsis alone', () => {
    assert.deepEqual(ruleSummary(rule({ target: 'work', value: '123' })), [{ text: 'Hide', kind: 'verb' }, { text: ' the work with id 123.' }])
    assert.deepEqual(ruleSummary(rule({ value: '', target: 'author' })), [{ text: 'Hide', kind: 'verb' }, { text: ' every work by …' }])
  })

  test('its parts read as the sentence', () => {
    const rules = [
      rule({}),
      rule({ behavior: 'collapse', priority: 6 }),
      rule({ behavior: 'invert', priority: 2 }),
      rule({ behavior: 'highlight' }),
      rule({ behavior: 'hideFilter' }),
      rule({ target: 'tag', matcher: 'regex', value: '^OC', behavior: 'hideFilter' }),
      rule({ behavior: 'none' }),
      rule({ target: 'R', matcher: 'contains', value: 'Steve Rogers/' }),
      rule({ target: 'author', value: 'some', matcher: 'contains' }),
      rule({ target: 'work', value: 'Tit', matcher: 'contains' }),
      rule({ target: 'series', value: '4232377' }),
      rule({ value: '' }),
    ]
    for (const each of rules)
      assert.equal(ruleSummary(each).map(part => part.text).join(''), describeRule(each))
  })
})
