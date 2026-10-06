import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ruleValueMatches, TagType } from '../../src/common/data.ts'
import { CANONICAL_CAP, canonicalAsks, canonicalMatches, canonicalPool, canonicalPreview, literalRuns, nextAsk, offersCanonical, usesBundledFandoms, withPress } from '../../src/options_ui/model/canonicalTags.ts'
import { NO_ANSWERS, withAnswer, withFailure, withRefusal } from '../../src/options_ui/model/tagSuggestions.ts'

const REFUSED = { reason: 'refused', until: 1_000_000 }
const BREATHER = { reason: 'pacing', until: 1_000_000 }

/** A pool of names, all from one place. */
const pool = (names, from = 'learned') => names.map(name => ({ name, from }))

/** The names `canonicalMatches` shows. */
const shownNames = found => found.shown.map(tag => tag.name)

/** What the browsing cache holds, from the names in each of its kinds. */
const learned = ({ fandoms = [], characters = [], relationships = [] } = {}) => {
  const byName = names => Object.fromEntries(names.map((name, id) => [name.toLowerCase(), { id, name }]))
  return { fandoms: byName(fandoms), characters: byName(characters), relationships: byName(relationships) }
}

describe('literalRuns', () => {
  test('a pattern with no metacharacters is one run', () => {
    assert.deepEqual(literalRuns('Original Female Character', 3), ['Original Female Character'])
  })

  test('metacharacters end a run, and the longest runs come first, as many as asked for', () => {
    assert.deepEqual(literalRuns('^Original (Female|Male) Character\\(s\\)$', 3), ['Character(s)', 'Original', 'Female'])
    assert.deepEqual(literalRuns('aa|bbb|cccc|ddddd', 2), ['ddddd', 'cccc'])
  })

  test('runs as long as each other keep the pattern\'s order', () => {
    assert.deepEqual(literalRuns('Steve|Tony|Bucky', 3), ['Steve', 'Bucky', 'Tony'])
  })

  test('an escaped metacharacter is text, and a hex or unicode escape is its character', () => {
    assert.deepEqual(literalRuns('\\.hack//', 3), ['.hack//'])
    assert.deepEqual(literalRuns('Caf\\u00e9 \\x26 Bar', 3), ['Café & Bar'])
  })

  test('a class, any character, a class escape, a boundary or a backreference ends a run', () => {
    assert.deepEqual(literalRuns('[Hh]arry.*Potter', 3), ['Potter', 'arry'])
    assert.deepEqual(literalRuns('Harry\\sPotter', 3), ['Potter', 'Harry'])
    assert.deepEqual(literalRuns('\\bSlow\\b Burn\\d', 3), ['Slow', 'Burn'])
    assert.deepEqual(literalRuns('(ab)cd\\1ef', 3), ['ab', 'cd', 'ef'])
    assert.deepEqual(literalRuns('[a-z]+[^/]Fluff', 3), ['Fluff'])
  })

  test('a character that may be left out is no part of a run', () => {
    assert.deepEqual(literalRuns('colou?r', 3), ['colo'])
    assert.deepEqual(literalRuns('Angsty*', 3), ['Angst'])
    assert.deepEqual(literalRuns('Slow{0,1} Burn', 3), ['Burn', 'Slo'])
  })

  test('a repeated character ends one run and starts the next', () => {
    assert.deepEqual(literalRuns('Aaa+rgh', 3), ['argh', 'Aaa'])
    assert.deepEqual(literalRuns('Hm{2,}way', 3), ['mway', 'Hm'])
  })

  test('the text of a negative lookaround is what must not be there, so it isn\'t a run', () => {
    assert.deepEqual(literalRuns('^(?!Original)Character', 3), ['Character'])
    assert.deepEqual(literalRuns('(?<!Not )Fluff', 3), ['Fluff'])
    assert.deepEqual(literalRuns('Fluff(?=y)', 3), ['Fluff'])
  })

  test('a group\'s name is no part of a run', () => {
    assert.deepEqual(literalRuns('(?<who>Harry) Potter', 3), ['Potter', 'Harry'])
    assert.deepEqual(literalRuns('(?:Draco)/Harry', 3), ['/Harry', 'Draco'])
  })

  test('runs are trimmed, their spaces collapsed, and one under two characters is left out', () => {
    assert.deepEqual(literalRuns('   Slow   Burn  ', 3), ['Slow Burn'])
    assert.deepEqual(literalRuns('a|b c|de', 3), ['b c', 'de'])
  })

  test('a run given again in another case is given once', () => {
    assert.deepEqual(literalRuns('a|bb|BB|ccc', 3), ['ccc', 'bb'])
  })

  test('a pattern of metacharacters has no runs', () => {
    assert.deepEqual(literalRuns('^.{3}$', 3), [])
    assert.deepEqual(literalRuns('\\d+\\s*', 3), [])
    assert.deepEqual(literalRuns('', 3), [])
  })
})

describe('canonicalMatches', () => {
  test('keeps the names the pattern matches, as a live rule matches them, ignoring case', () => {
    const names = ['Fluff', 'Fluff and Angst', 'Angst', 'Tooth-Rotting Fluff']
    const found = canonicalMatches('^fluff', pool(names), 50)
    assert.deepEqual(shownNames(found), ['Fluff', 'Fluff and Angst'])
    assert.equal(found.total, 2)
    assert.equal(found.poolSize, 4)
    for (const name of names)
      assert.equal(shownNames(found).includes(name), ruleValueMatches({ value: '^fluff', matcher: 'regex' }, name), name)
  })

  test('marks each name\'s match, escaping the rest', () => {
    const [tag] = canonicalMatches('comfort', pool(['Hurt/Comfort & <Fluff>']), 50).shown
    assert.equal(tag.html, 'Hurt/<mark>Comfort</mark> &amp; &lt;Fluff&gt;')
  })

  test('a match of nothing marks nothing', () => {
    const [tag] = canonicalMatches('^', pool(['Fluff & Angst']), 50).shown
    assert.equal(tag.html, 'Fluff &amp; Angst')
  })

  test('shows the names A to Z, ignoring case', () => {
    assert.deepEqual(shownNames(canonicalMatches('a', pool(['beta', 'Alpha', 'gamma', 'alpaca'])), 50), ['alpaca', 'Alpha', 'beta', 'gamma'])
  })

  test('shows no more than the cap, and counts every match', () => {
    const names = Array.from({ length: 60 }, (_, i) => `Tag ${String(i).padStart(2, '0')}`)
    const found = canonicalMatches('^tag', pool(names), 50)
    assert.equal(found.shown.length, 50)
    assert.equal(found.total, 60)
    assert.equal(found.poolSize, 60)
  })

  test('a name known from several places is one, in AO3\'s spelling rather than the bundled list\'s lower case', () => {
    const bundled = { name: 'harry potter - j. k. rowling', from: 'bundled' }
    const spelled = { name: 'Harry Potter - J. K. Rowling', from: 'ao3' }
    for (const tags of [[bundled, spelled], [spelled, bundled]]) {
      const found = canonicalMatches('^harry', tags, 50)
      assert.deepEqual(found.shown.map(({ name, from }) => ({ name, from })), [spelled])
      assert.equal(found.poolSize, 1)
    }
  })

  test('a bundled name no other place spells is shown in lower case', () => {
    assert.deepEqual(shownNames(canonicalMatches('hack', pool(['.hack//sign'], 'bundled'), 50)), ['.hack//sign'])
  })

  test('a pattern the engine refuses gives its reason', () => {
    assert.deepEqual(canonicalMatches('(fluff', pool(['Fluff']), 50), { invalid: 'Unterminated group' })
  })
})

describe('canonicalPool', () => {
  const known = {
    bundled: ['harry potter - j. k. rowling', 'sherlock (tv)'],
    learned: learned({ fandoms: ['Good Omens (TV)'], characters: ['Harry Potter'], relationships: ['Aziraphale/Crowley (Good Omens)'] }),
  }
  const names = target => canonicalPool(target, known).map(({ name, from }) => `${from}: ${name}`)

  test('a fandom\'s pool is the bundled fandoms and those learned while browsing', () => {
    assert.deepEqual(names(TagType.Fandom), ['bundled: harry potter - j. k. rowling', 'bundled: sherlock (tv)', 'learned: Good Omens (TV)'])
  })

  test('a character\'s or a relationship\'s pool is those learned while browsing', () => {
    assert.deepEqual(names(TagType.Character), ['learned: Harry Potter'])
    assert.deepEqual(names(TagType.Relationship), ['learned: Aziraphale/Crowley (Good Omens)'])
  })

  test('a rating, a warning or a category has the archive\'s fixed names', () => {
    assert.deepEqual(names(TagType.Rating), ['General Audiences', 'Teen And Up Audiences', 'Mature', 'Explicit', 'Not Rated'].map(name => `fixed: ${name}`))
    assert.ok(names(TagType.ArchiveWarning).includes('fixed: Underage Sex'))
    assert.ok(names(TagType.Category).includes('fixed: M/M'))
  })

  test('additional tags have no pool of their own', () => {
    assert.deepEqual(names(TagType.Freeform), [])
  })

  test('any tag\'s pool is every one of them', () => {
    const all = names('tag')
    for (const target of [TagType.Fandom, TagType.Character, TagType.Relationship, TagType.Rating, TagType.ArchiveWarning, TagType.Category]) {
      for (const name of names(target))
        assert.ok(all.includes(name), `${target}: ${name}`)
    }
  })

  test('only a fandom and any tag use the bundled fandoms, which are worth loading only for them', () => {
    assert.deepEqual(['tag', ...TagType.values()].filter(usesBundledFandoms), ['tag', TagType.Fandom])
  })
})

describe('offersCanonical', () => {
  test('in Regex mode, for any kind of tag', () => {
    for (const target of ['tag', ...TagType.values()])
      assert.equal(offersCanonical({ target, matcher: 'regex' }), true, target)
  })

  test('not for an author, a work or a series, nor in Exact or Contains mode', () => {
    for (const target of ['author', 'work', 'series'])
      assert.equal(offersCanonical({ target, matcher: 'regex' }), false, target)
    assert.equal(offersCanonical({ target: 'tag', matcher: 'exact' }), false)
    assert.equal(offersCanonical({ target: 'tag', matcher: 'contains' }), false)
  })
})

describe('canonicalAsks', () => {
  test('asks the target\'s autocomplete for the pattern\'s three longest runs, each as AO3\'s widget asks', () => {
    assert.deepEqual(canonicalAsks(TagType.Character, '^Original (Female|Male) Character\\(s\\)$'), [
      { run: 'Character(s)', request: { endpoint: '/autocomplete/character', term: 'character(s)', path: '/autocomplete/character?term=character(s)' } },
      { run: 'Original', request: { endpoint: '/autocomplete/character', term: 'original', path: '/autocomplete/character?term=original' } },
      { run: 'Female', request: { endpoint: '/autocomplete/character', term: 'female', path: '/autocomplete/character?term=female' } },
    ])
    assert.deepEqual(canonicalAsks('tag', 'Slow Burn').map(ask => ask.request.path), ['/autocomplete/tag?term=slow%20burn'])
  })

  test('asks nothing for a target with the archive\'s fixed names, or none', () => {
    assert.deepEqual(canonicalAsks(TagType.Rating, 'Explicit'), [])
    assert.deepEqual(canonicalAsks('author', 'Someone'), [])
  })

  test('asks nothing for a pattern the engine refuses, or one with no run of two characters', () => {
    assert.deepEqual(canonicalAsks(TagType.Character, '(Original'), [])
    assert.deepEqual(canonicalAsks(TagType.Character, '^.{3}$|a'), [])
  })
})

describe('nextAsk and withPress', () => {
  const asks = canonicalAsks(TagType.Character, 'Original|Female')
  const [original, female] = asks.map(ask => ask.request)

  test('asks for each run in turn, then for nothing', () => {
    let next = nextAsk(withPress(NO_ANSWERS), asks, null)
    assert.equal(next.send, original)
    assert.equal(next.state.asking, original.path)
    next = nextAsk(withAnswer(next.state, original, ['Original Character(s)']), asks, null)
    assert.equal(next.send, female)
    next = nextAsk(withAnswer(next.state, female, ['Female Shepard (Mass Effect)']), asks, null)
    assert.equal(next.send, null)
  })

  test('a run already answered is not asked again', () => {
    const state = withPress(withAnswer(NO_ANSWERS, original, ['Original Character(s)']))
    assert.equal(nextAsk(state, asks, null).send, female)
  })

  test('under a refusal nothing is sent, and the preview knows it is paused', () => {
    const next = nextAsk(withPress(NO_ANSWERS), asks, REFUSED)
    assert.equal(next.send, null)
    assert.equal(next.state.pausedUntil, REFUSED.until)
  })

  test('a run due a breather is skipped, never kept to send later', () => {
    const next = nextAsk(withPress(NO_ANSWERS), asks, BREATHER)
    assert.equal(next.send, null)
    assert.equal(next.state.skipped, original.path)
  })

  test('after a failure or a refusal, the rest of the press asks nothing', () => {
    const asked = nextAsk(withPress(NO_ANSWERS), asks, null).state
    assert.equal(nextAsk(withFailure(asked), asks, null).send, null)
    assert.equal(nextAsk(withRefusal(asked, REFUSED), asks, REFUSED).send, null)
  })

  test('a press keeps the answers had, and forgets what stopped the last press', () => {
    const failed = withFailure(withAnswer(NO_ANSWERS, original, ['Original Character(s)']))
    const pressed = withPress(failed)
    assert.deepEqual(pressed.answers, failed.answers)
    assert.equal(pressed.failed, false)
    assert.equal(withPress(withRefusal(NO_ANSWERS, REFUSED)).pausedUntil, 0)
    assert.equal(withPress(nextAsk(NO_ANSWERS, asks, BREATHER).state).skipped, null)
    assert.equal(nextAsk(pressed, asks, null).send, female)
  })
})

describe('canonicalPreview', () => {
  const CHARACTERS = ['Original Female Character(s)', 'Original Male Character(s)', 'Harry Potter']
  const local = canonicalPool(TagType.Character, { bundled: [], learned: learned({ characters: CHARACTERS }) })
  const asks = canonicalAsks(TagType.Character, '^Original (Female|Child)')
  const [original, female] = asks.map(ask => ask.request)
  const answered = withAnswer(withAnswer(NO_ANSWERS, original, ['Original Child Character(s)', 'Original Female Character(s)']), female, ['Female Shepard (Mass Effect)'])
  const preview = (input = {}) => canonicalPreview({ target: TagType.Character, pattern: '^Original (Female|Child)', local, asks, state: answered, ...input })

  test('counts the matches among every name known, and names AO3\'s part', () => {
    const shown = preview()
    assert.equal(shown.head, '2 of 5 known canonical Characters')
    assert.equal(shown.sources, 'plus AO3’s suggestions for “Original”, “Female”')
    assert.deepEqual(shown.rows.map(row => row.name), ['Original Child Character(s)', 'Original Female Character(s)'])
    assert.equal(shown.rows[0].html, '<mark>Original Child</mark> Character(s)')
    assert.equal(shown.empty, null)
    assert.equal(shown.more, null)
    assert.equal(shown.note, null)
  })

  test('an edit filters the same names again', () => {
    assert.deepEqual(preview({ pattern: 'Male Char' }).rows.map(row => row.name), ['Original Female Character(s)', 'Original Male Character(s)'])
  })

  test('names only the runs AO3 has answered, and none before it has', () => {
    assert.equal(preview({ state: withAnswer(NO_ANSWERS, female, []) }).sources, 'plus AO3’s suggestions for “Female”')
    const none = preview({ state: NO_ANSWERS })
    assert.equal(none.sources, null)
    assert.equal(none.head, '1 of 3 known canonical Characters')
  })

  test('says while AO3 is being asked', () => {
    const asking = nextAsk(withPress(NO_ANSWERS), asks, null).state
    assert.equal(preview({ state: asking }).note, 'Asking AO3…')
  })

  test('under a refusal, offline, or due a breather, shows the known names only, with a note', () => {
    const asked = nextAsk(withPress(NO_ANSWERS), asks, null).state
    const notes = {
      'AO3 asked us to slow down — showing known tags only': withRefusal(asked, REFUSED),
      'AO3’s suggestions are unavailable — showing known tags only': withFailure(asked),
      'Requests to AO3 are pausing for a moment — showing known tags only': nextAsk(withPress(NO_ANSWERS), asks, BREATHER).state,
    }
    for (const [note, state] of Object.entries(notes)) {
      const shown = preview({ state })
      assert.equal(shown.note, note)
      assert.equal(shown.head, '1 of 3 known canonical Characters', note)
      assert.deepEqual(shown.rows.map(row => row.name), ['Original Female Character(s)'], note)
    }
  })

  test('additional tags, with no names of their own, show only the note', () => {
    const freeform = canonicalAsks(TagType.Freeform, 'Fluff')
    const asked = nextAsk(withPress(NO_ANSWERS), freeform, null).state
    const shown = canonicalPreview({ target: TagType.Freeform, pattern: 'Fluff', local: [], asks: freeform, state: withFailure(asked) })
    assert.deepEqual(shown, { head: null, sources: null, rows: [], more: null, empty: null, note: 'AO3’s suggestions are unavailable' })
  })

  test('additional tags show AO3\'s answer, from it alone', () => {
    const freeform = canonicalAsks(TagType.Freeform, 'Fluff')
    const state = withAnswer(NO_ANSWERS, freeform[0].request, ['Fluff', 'Fluff and Angst', 'Angst'])
    const shown = canonicalPreview({ target: TagType.Freeform, pattern: '^Fluff', local: [], asks: freeform, state })
    assert.equal(shown.head, '2 of 3 known canonical Additional Tags')
    assert.equal(shown.sources, 'from AO3’s suggestions for “Fluff”')
  })

  test('with nothing known and nothing to ask, says so', () => {
    const shown = canonicalPreview({ target: TagType.Freeform, pattern: '^.{3}$', local: [], asks: [], state: withPress(NO_ANSWERS) })
    assert.deepEqual(shown, { head: null, sources: null, rows: [], more: null, empty: 'No known canonical Additional Tags, and nothing in the pattern to ask AO3 for.', note: null })
  })

  test('says when nothing matches', () => {
    const shown = preview({ pattern: '^Nobody$' })
    assert.equal(shown.head, '0 of 5 known canonical Characters')
    assert.equal(shown.empty, 'No canonical tags match this pattern.')
  })

  test('shows the first fifty, and says so', () => {
    const many = pool(Array.from({ length: 1480 }, (_, i) => `Character ${i}`))
    const shown = canonicalPreview({ target: TagType.Character, pattern: '^Character', local: many, asks: [], state: NO_ANSWERS })
    assert.equal(shown.head, '1,480 of 1,480 known canonical Characters')
    assert.equal(shown.rows.length, CANONICAL_CAP)
    assert.equal(shown.more, 'The first 50 are shown.')
  })

  test('names the kind of tag, or any tag', () => {
    const nouns = {
      tag: 'tags',
      [TagType.Fandom]: 'Fandoms',
      [TagType.Relationship]: 'Relationships',
      [TagType.Rating]: 'Ratings',
      [TagType.ArchiveWarning]: 'Archive Warnings',
      [TagType.Category]: 'Categories',
    }
    for (const [target, noun] of Object.entries(nouns)) {
      const shown = canonicalPreview({ target, pattern: 'x', local: pool(['x']), asks: [], state: NO_ANSWERS })
      assert.equal(shown.head, `1 of 1 known canonical ${noun}`, target)
    }
  })

  test('while the known names load, says so', () => {
    assert.deepEqual(preview({ local: null }), { head: 'Loading the known tags…', sources: null, rows: [], more: null, empty: null, note: null })
  })

  test('with no pattern, or one the engine refuses, shows no names', () => {
    assert.deepEqual(preview({ pattern: '  ' }), { head: 'No pattern yet', sources: null, rows: [], more: null, empty: null, note: null })
    assert.deepEqual(preview({ pattern: '(Original' }), { head: 'Fix the pattern to see matches', sources: null, rows: [], more: null, empty: null, note: null })
  })
})
