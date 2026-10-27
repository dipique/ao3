import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { DEFAULT_AUTHOR_HIGHLIGHT_COLOR, DEFAULT_HIGHLIGHT_COLOR, HIGHLIGHT_PRESETS, RULE_TARGETS, ruleMatchesAuthor, ruleMatchesEntity, ruleMatchesTag, ruleTargetLabel, ruleValueMatches, TagType } from '../../src/common/data.ts'
import { compilePattern, ended, IDLE_RUN, matchSpans } from '../../src/options_ui/model/regexCheck.ts'
import { canSave, checkedNames, checkedPattern, CHECKING, describeRule, draftRule, EXACT_HELP, NO_PATTERN, openDraft, parseAutocomplete, regexTester, regexVerdict, RULE_ACTIONS, ruleSummary, saveButton, suggestSource, swatchFor, TESTER_HELP, TESTER_STOPPED, TOO_SLOW, usesColor, usesPriority, valueField, VERDICT_LABELS, withAction, withSwatch, withTarget } from '../../src/options_ui/model/ruleEditor.ts'

/** A check of `pattern` that ran to the end over `subject` and `names`. */
const finished = (pattern, subject, names = []) => {
  const job = { pattern, subjects: [subject, ...names] }
  return ended(job, matchSpans(pattern, job.subjects))
}

/** A check of `pattern` stopped for running past the budget. */
const slow = pattern => ({ kind: 'slow', job: { pattern, subjects: [] } })

/** A check under way, after `last`. */
const running = (last = null) => ({ kind: 'running', last })

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
    for (const action of RULE_ACTIONS) {
      assert.ok(action.label.trim(), `${action.value} has a label`)
      assert.ok(action.help.trim(), `${action.value} has help`)
    }
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
  const regex = value => ({ ...opened(undefined), matcher: 'regex', value })

  test('needs something to match', () => {
    assert.equal(canSave(opened(undefined), IDLE_RUN), false)
    assert.equal(canSave({ ...opened(undefined), value: '   ' }, IDLE_RUN), false)
    assert.equal(canSave({ ...opened(undefined), value: 'Fluff' }, IDLE_RUN), true)
  })

  test('a Regex pattern needs its check to have run to the end in time', () => {
    assert.equal(canSave(regex('^a+!$'), finished('^a+!$', 'aaaa!')), true)
    assert.equal(canSave(regex('(a+)+$'), slow('(a+)+$')), false)
    assert.equal(canSave(regex('(a+)+$'), running()), false)
    assert.equal(canSave(regex('^a+!$'), running(finished('^a+', 'aaaa!'))), false)
  })

  test('a pattern the engine refuses runs nothing, so has nothing to wait for, as before', () => {
    assert.equal(canSave(regex('(slow'), IDLE_RUN), true)
  })

  test('nothing is checked for Exact or Contains, or for a number matching an id', () => {
    for (const draft of [{ ...regex('(a+)+$'), matcher: 'exact' }, { ...regex('(a+)+$'), matcher: 'contains' }, { ...regex('4232377'), target: 'work' }])
      assert.equal(canSave(draft, IDLE_RUN), true, draft.matcher)
  })
})

describe('saveButton', () => {
  const regex = value => ({ ...opened(undefined), matcher: 'regex', value })

  test('is off with no reason while there is nothing to match', () => {
    assert.deepEqual(saveButton(opened(undefined), IDLE_RUN), { off: true, reason: null })
  })

  test('is off, saying why, for a pattern that ran past the budget', () => {
    assert.deepEqual(saveButton(regex('(a+)+$'), slow('(a+)+$')), { off: true, reason: TOO_SLOW })
  })

  test('stays off while the next check runs, until it passes', () => {
    assert.deepEqual(saveButton(regex('(a+)+'), running(slow('(a+)+$'))), { off: true, reason: TOO_SLOW })
    assert.deepEqual(saveButton(regex('(a+)+'), finished('(a+)+', 'aaaa!')), { off: false, reason: null })
  })

  test('stays on while a check runs after one that passed, or the first: a press waits for it', () => {
    assert.deepEqual(saveButton(regex('^a+!$'), running(finished('^a+', 'aaaa!'))), { off: false, reason: null })
    assert.deepEqual(saveButton(regex('^a+!$'), running()), { off: false, reason: null })
  })

  test('a slow check is nothing to Exact or Contains', () => {
    assert.deepEqual(saveButton({ ...regex('(a+)+$'), matcher: 'contains' }, IDLE_RUN), { off: false, reason: null })
  })
})

describe('checkedPattern', () => {
  const draft = (target, matcher, value) => ({ target, matcher, value })

  test('is the pattern in Regex mode, as the live rule runs it: a work\'s or a series\' trimmed, any other\'s as typed', () => {
    assert.equal(checkedPattern(draft('tag', 'regex', ' ^slow ')), ' ^slow ')
    assert.equal(checkedPattern(draft('author', 'regex', ' ^some')), ' ^some')
    assert.equal(checkedPattern(draft('work', 'regex', ' ^Saga ')), '^Saga')
    assert.equal(checkedPattern(draft('series', 'regex', ' ^Saga ')), '^Saga')
  })

  test('runs nothing in Exact or Contains mode, for a number matching an id, or for a blank or refused pattern', () => {
    assert.equal(checkedPattern(draft('tag', 'exact', 'slow')), null)
    assert.equal(checkedPattern(draft('tag', 'contains', 'slow')), null)
    assert.equal(checkedPattern(draft('work', 'regex', ' 4232377 ')), null)
    assert.equal(checkedPattern(draft('tag', 'regex', '   ')), null)
    assert.equal(checkedPattern(draft('tag', 'regex', '(slow')), null)
  })
})

describe('checkedNames', () => {
  const known = { target: TagType.Character, names: ['Harry Potter'] }

  test('a tag\'s pattern runs over the names known for its target, once they have loaded', () => {
    assert.equal(checkedNames(TagType.Character, known), known.names)
    assert.equal(checkedNames(TagType.Character, null), null)
    assert.equal(checkedNames(TagType.Fandom, known), null, 'the names known for another target are no use')
  })

  test('an author\'s, a work\'s or a series\' runs over none', () => {
    for (const target of ['author', 'work', 'series'])
      assert.deepEqual(checkedNames(target, null), [], target)
  })
})

describe('valueField', () => {
  test('is labelled for what the rule matches: a fandom, any other tag alike, or an author, a work or a series', () => {
    for (const target of [TagType.Freeform, TagType.Character, TagType.Rating])
      assert.equal(valueField(target, 'exact', '').label, valueField('tag', 'exact', '').label, target)
    for (const target of [TagType.Fandom, 'author', 'work', 'series'])
      assert.equal(valueField(target, 'exact', '').label, ruleTargetLabel(target), target)
  })

  test('says how each matcher reads the text, and what it reads it against', () => {
    const MATCHERS = ['exact', 'contains', 'regex']
    const TARGETS = [TagType.Freeform, 'author', 'work']
    for (const target of TARGETS) {
      const helps = MATCHERS.map(matcher => valueField(target, matcher, '').help)
      assert.equal(new Set(helps).size, MATCHERS.length, `${target}: ${helps.join(' | ')}`)
    }
    for (const matcher of ['contains', 'regex']) {
      const helps = TARGETS.map(target => valueField(target, matcher, '').help)
      assert.equal(new Set(helps).size, TARGETS.length, `${matcher}: ${helps.join(' | ')}`)
    }
  })

  test('in Exact mode, says where the suggestions come from, so the rule takes AO3\'s spelling', () => {
    for (const target of [TagType.Fandom, TagType.Character, TagType.Relationship, TagType.Freeform, TagType.Rating, TagType.ArchiveWarning, TagType.Category])
      assert.equal(valueField(target, 'exact', '').help, EXACT_HELP[suggestSource(target).kind], target)
    assert.notEqual(EXACT_HELP.ao3, EXACT_HELP.fixed)
  })

  test('asks for typing where suggestions follow it, and for the name where they don\'t', () => {
    const placeholder = (target, matcher) => valueField(target, matcher, '').placeholder
    assert.equal(placeholder('F', 'exact'), placeholder('r', 'exact'), 'any tag with suggestions asks alike')
    assert.notEqual(placeholder('F', 'exact'), placeholder('F', 'contains'), 'with none, it asks for the name')
    assert.notEqual(placeholder('f', 'exact'), placeholder('F', 'exact'), 'a fandom is asked for as one')
    assert.notEqual(placeholder('f', 'regex'), placeholder('F', 'contains'))
    const others = [placeholder('F', 'exact'), placeholder('F', 'contains'), placeholder('author', 'exact'), placeholder('work', 'exact')]
    assert.equal(new Set(others).size, others.length, others.join(' | '))
  })

  test('a number for a work or a series matches its id, whatever the matcher', () => {
    for (const target of ['work', 'series']) {
      const field = valueField(target, 'regex', ' 4232377 ')
      assert.equal(field.byId, true, target)
      assert.notEqual(field.help, valueField(target, 'regex', 'Saga').help, 'the help says so')
    }
    assert.equal(valueField('F', 'exact', '4232377').byId, false)
    assert.equal(valueField('work', 'exact', '42a').byId, false)
  })
})

describe('regexVerdict', () => {
  /** The verdict once the check of `pattern` over `subject` has run to the end. */
  const verdict = (pattern, subject) => regexVerdict(pattern, subject, finished(pattern, subject))

  test('tests the pattern ignoring case', () => {
    assert.deepEqual(verdict('^slow.*burn$', 'Slow Burn'), { kind: 'match' })
    assert.deepEqual(verdict('^SLOW', 'slow burn'), { kind: 'match' })
    assert.deepEqual(verdict('^burn', 'Slow Burn'), { kind: 'miss' })
  })

  test('a negated class keeps its meaning under the i flag', () => {
    // Each pair is an escape and its negation, which must disagree.
    for (const [miss, match] of [['Slow\\S*Burn', 'Slow\\s*Burn'], ['Slow\\wBurn', 'Slow\\WBurn'], ['\\d{4}', '\\D{4}'], ['\\bl', '\\Bl']]) {
      assert.deepEqual(verdict(miss, 'Slow Burn'), { kind: 'miss' }, miss)
      assert.deepEqual(verdict(match, 'Slow Burn'), { kind: 'match' }, match)
    }
    assert.deepEqual(verdict('omega\\S+verse', 'Omega Verse'), { kind: 'miss' })
  })

  test('an unterminated group is an invalid pattern, with the engine\'s reason, and a live rule matches nothing with it', () => {
    assert.deepEqual(regexVerdict('(slow', 'slow', IDLE_RUN), { kind: 'invalid', reason: 'Unterminated group' })
    assert.equal(ruleValueMatches({ value: '(slow', matcher: 'regex' }, 'slow'), false)
  })

  test('the reason leaves out the pattern the engine repeats, however the pattern reads, and starts with a capital', () => {
    assert.deepEqual(regexVerdict('x/i: (', 'x', IDLE_RUN), { kind: 'invalid', reason: 'Unterminated group' })
    assert.deepEqual(regexVerdict('a{2,1}', 'a', IDLE_RUN), { kind: 'invalid', reason: 'Numbers out of order in {} quantifier' })
  })

  test('an invalid pattern says so before anything is typed to test', () => {
    assert.deepEqual(regexVerdict('[', '', IDLE_RUN), { kind: 'invalid', reason: 'Unterminated character class' })
  })

  test('no verdict without a pattern, or without something to test', () => {
    assert.deepEqual(regexVerdict('', 'Slow Burn', IDLE_RUN), { kind: 'none' })
    assert.deepEqual(regexVerdict('   ', 'Slow Burn', IDLE_RUN), { kind: 'none' })
    assert.deepEqual(verdict('slow', ''), { kind: 'none' })
  })

  test('a check that ran past the budget is too slow, in place of a verdict, with or without something to test', () => {
    assert.deepEqual(regexVerdict('(a+)+$', 'aaaa!', slow('(a+)+$')), { kind: 'slow' })
    assert.deepEqual(regexVerdict('(a+)+$', '', slow('(a+)+$')), { kind: 'slow' })
  })

  test('while the check runs, it is checking what is typed to test', () => {
    assert.deepEqual(regexVerdict('(a+)+$', 'aaaa!', running()), { kind: 'checking' })
    assert.deepEqual(regexVerdict('(a+)+$', 'aaaa!', running(finished('(a+)+', 'aaaa!'))), { kind: 'checking' })
  })

  test('with nothing typed to test, there is no verdict to wait for while the check runs', () => {
    assert.deepEqual(regexVerdict('(a+)+$', '', running(finished('(a+)+', ''))), { kind: 'none' })
  })

  test('a pattern the engine refuses, or a blank one, needs no check', () => {
    assert.deepEqual(regexVerdict('(slow', 'slow', running()), { kind: 'invalid', reason: 'Unterminated group' })
    assert.deepEqual(regexVerdict('  ', 'slow', running()), { kind: 'none' })
  })
})

describe('regexTester', () => {
  /** The tester once the check of `value` over `subject` has run to the end. */
  const tester = (target, value, subject) => regexTester({ target, matcher: 'regex', value }, subject, finished(checkedPattern({ target, matcher: 'regex', value }) ?? value, subject))

  test('is there in Regex mode only', () => {
    assert.equal(regexTester({ target: 'tag', matcher: 'exact', value: 'slow' }, 'Slow Burn', IDLE_RUN), null)
    assert.equal(regexTester({ target: 'tag', matcher: 'contains', value: 'slow' }, 'Slow Burn', IDLE_RUN), null)
    assert.notEqual(tester('tag', 'slow', 'Slow Burn'), null)
  })

  test('is not there while a work\'s or a series\' number matches its id', () => {
    assert.equal(tester('work', ' 4232377 ', '4232377'), null)
    assert.equal(tester('series', '4232377', '4232377'), null)
    assert.notEqual(tester('work', '42a', '42a'), null)
    assert.notEqual(tester(TagType.Freeform, '4232377', '4232377'), null)
  })

  test('asks for what the pattern is tested against: any tag alike, an author, or a work\'s or a series\' title', () => {
    const asks = (target) => {
      const { placeholder, label } = tester(target, 'slow', '')
      return { placeholder, label }
    }
    for (const target of [TagType.Fandom, TagType.Freeform, TagType.Rating])
      assert.deepEqual(asks(target), asks('tag'), target)
    assert.deepEqual(asks('series'), asks('work'))
    const kinds = ['tag', 'author', 'work'].map(asks)
    assert.equal(new Set(kinds.map(kind => kind.placeholder)).size, kinds.length, JSON.stringify(kinds))
    assert.equal(new Set(kinds.map(kind => kind.label)).size, kinds.length, JSON.stringify(kinds))
  })

  test('with no pattern, says there is none yet', () => {
    assert.equal(tester('tag', '', 'Slow Burn').label, NO_PATTERN)
    assert.equal(tester('tag', '  ', '').label, NO_PATTERN)
    assert.notEqual(tester('tag', 'slow', '').label, NO_PATTERN)
  })

  test('names each verdict', () => {
    for (const [value, kind] of [['^slow', 'match'], ['^burn', 'miss'], ['(slow', 'invalid']]) {
      const shown = tester('tag', value, 'Slow Burn')
      assert.equal(shown.verdict.kind, kind, value)
      assert.equal(shown.label, VERDICT_LABELS[kind], value)
    }
  })

  test('the line under it says nothing is saved from it, or why the pattern is refused', () => {
    for (const [value, subject] of [['', ''], ['^slow', ''], ['^slow', 'Slow Burn'], ['^burn', 'Slow Burn']])
      assert.equal(tester('tag', value, subject).help, TESTER_HELP, `${value} / ${subject}`)
    assert.equal(tester('tag', '(slow', '').help, compilePattern('(slow'))
  })

  test('says a pattern that ran past the budget is too slow, and that testing stopped', () => {
    const shown = regexTester({ target: 'tag', matcher: 'regex', value: '(a+)+$' }, 'aaaa!', slow('(a+)+$'))
    assert.deepEqual(shown.verdict, { kind: 'slow' })
    assert.equal(shown.label, VERDICT_LABELS.slow)
    assert.equal(shown.help, TESTER_STOPPED)
  })

  test('says while it checks', () => {
    const shown = regexTester({ target: 'tag', matcher: 'regex', value: '(a+)+$' }, 'aaaa!', running())
    assert.equal(shown.label, CHECKING)
    assert.equal(shown.help, TESTER_HELP)
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
  const said = fields => describeRule(rule(fields))
  /** The sentences are each different. */
  const distinct = (sentences) => {
    assert.equal(new Set(sentences).size, sentences.length, sentences.join(' | '))
  }

  test('says each action differently, of the works it matches', () => {
    const sentences = ['hide', 'collapse', 'invert', 'highlight', 'hideFilter', 'none'].map(behavior => said({ behavior }))
    distinct(sentences)
    for (const sentence of sentences)
      assert.ok(sentence.includes('Fluff') && sentence.includes(ruleTargetLabel('F')), sentence)
    assert.equal(said({}), said({ behavior: 'hide' }), 'a rule with no behaviour hides')
  })

  test('names a tag\'s kind, unless it is any tag, and says how a tag is matched', () => {
    assert.ok(!said({ target: 'tag' }).includes(ruleTargetLabel('F')))
    assert.ok(said({ target: 'R', matcher: 'contains', value: 'Steve Rogers/' }).includes(ruleTargetLabel('R')))
    for (const target of ['tag', 'F'])
      distinct(['exact', 'contains', 'regex'].map(matcher => said({ target, matcher })))
    distinct(['exact', 'contains', 'regex'].map(matcher => said({ target: 'tag', matcher, behavior: 'hideFilter' })))
  })

  test('an author, with and without a pseud, and how the username is matched', () => {
    const author = { target: 'author', value: 'someone' }
    assert.ok(said({ ...author, pseud: 'sideblog' }).includes('sideblog'))
    assert.notEqual(said({ ...author, pseud: 'sideblog' }), said(author))
    distinct(['exact', 'contains', 'regex'].map(matcher => said({ ...author, matcher })))
  })

  test('a work or a series, by title or by id, which a number matches whatever the matcher', () => {
    assert.ok(said({ target: 'work', value: 'Title' }).includes('Title'))
    distinct(['work', 'series'].map(target => said({ target, value: 'Saga' })))
    distinct(['exact', 'contains', 'regex'].map(matcher => said({ target: 'series', value: 'Saga', matcher })))
    for (const target of ['work', 'series']) {
      const byId = said({ target, value: ' 123 ', matcher: 'regex' })
      assert.ok(byId.includes('123') && !byId.includes(' 123 '), byId)
      assert.equal(byId, said({ target, value: '123' }), target)
    }
  })

  test('a priority is mentioned only where it differs from its action\'s default, and the action has one', () => {
    assert.ok(said({ priority: 6 }).includes('6'))
    assert.notEqual(said({ priority: 6 }), said({}))
    assert.equal(said({ behavior: 'invert', priority: 4 }), said({ behavior: 'invert' }))
    assert.ok(said({ behavior: 'invert', priority: 2 }).includes('2'))
    assert.equal(said({ behavior: 'highlight', priority: 3 }), said({ behavior: 'highlight' }))
    assert.equal(said({ behavior: 'none', priority: 3 }), said({ behavior: 'none' }))
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
  const kinds = parts => parts.map(part => part.kind ?? 'words')

  test('the sentence in parts: the action first, drawn bold, and the value, drawn as a quote', () => {
    for (const behavior of ['hide', 'collapse', 'invert', 'highlight', 'hideFilter', 'none']) {
      const parts = ruleSummary(rule({ behavior }))
      assert.equal(parts[0].kind, 'verb', behavior)
      assert.equal(parts.filter(part => part.kind === 'value').length, 1, behavior)
      assert.ok(parts.find(part => part.kind === 'value').text.includes('Fluff'), behavior)
    }
    assert.deepEqual(kinds(ruleSummary(rule({}))), ['verb', 'words', 'value', 'words'])
    const author = ruleSummary(rule({ behavior: 'invert', target: 'author', value: 'someone', pseud: 'sideblog' }))
    assert.deepEqual(kinds(author), ['verb', 'words', 'value', 'words'])
    assert.ok(author[2].text.includes('someone') && !author[2].text.includes('sideblog'), 'the pseud is no part of the value')
    assert.ok(author[3].text.includes('sideblog'))
  })

  test('each action that hides, collapses, shows or highlights has a verb of its own, and so does a disabled rule', () => {
    const verbs = ['hide', 'collapse', 'invert', 'highlight', 'none'].map(behavior => ruleSummary(rule({ behavior }))[0].text)
    assert.equal(new Set(verbs).size, verbs.length, verbs.join(' | '))
  })

  test('an id is no quote, and an untyped value is no quote either', () => {
    const byId = ruleSummary(rule({ target: 'work', value: '123' }))
    assert.deepEqual(kinds(byId), ['verb', 'words'])
    assert.ok(byId[1].text.includes('123'))
    assert.deepEqual(kinds(ruleSummary(rule({ value: '', target: 'author' }))), ['verb', 'words'])
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
