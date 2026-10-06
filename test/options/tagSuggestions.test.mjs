import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { TagType } from '../../src/common/data.ts'
import { parseAutocomplete, suggestSource } from '../../src/options_ui/model/ruleEditor.ts'
import { CURSOR_START, NO_ANSWERS, SUGGEST_NOTES, suggestBox, suggestKey, suggestRequest, whenDue, withAnswer, withFailure, withRefusal, withResume } from '../../src/options_ui/model/tagSuggestions.ts'

/** AO3's answers to its tag autocomplete, recorded signed out and trimmed to a few names each, keyed by request. */
const RECORDED = JSON.parse(readFileSync(new URL('./ao3-autocomplete.json', import.meta.url), 'utf8'))

/** The fandoms AO3 offered for “potter”, in its order. */
const POTTER_FANDOMS = parseAutocomplete(RECORDED['/autocomplete/fandom?term=potter'])

const FANDOM = suggestSource(TagType.Fandom)
const CHARACTER = suggestSource(TagType.Character)
const RATING = suggestSource(TagType.Rating)
const CATEGORY = suggestSource(TagType.Category)
const AUTHOR = suggestSource('author')

/** The request an Exact field with `value` makes of `source`. */
const asks = (source, value) => suggestRequest(source, 'exact', value)

/** The state once AO3 has answered `value` for `source` with `names`. */
const answered = (source, value, names, state = NO_ANSWERS) => withAnswer(state, asks(source, value), names)

/** What the box under an Exact field holding `value` shows. */
const box = (state, source, value) => suggestBox(state, source, 'exact', value)

const REFUSED = { reason: 'refused', until: 1_000_000 }
const BREATHER = { reason: 'pacing', until: 1_000_000 }

describe('suggestRequest', () => {
  test('asks the endpoint for the term, trimmed and lowercased as AO3\'s own widget asks', () => {
    assert.deepEqual(asks(FANDOM, '  Harry   Potter '), {
      endpoint: '/autocomplete/fandom',
      term: 'harry potter',
      path: '/autocomplete/fandom?term=harry%20potter',
    })
  })

  test('the term is escaped in the path', () => {
    assert.equal(asks(FANDOM, 'Thorne & Rowling').path, '/autocomplete/fandom?term=thorne%20%26%20rowling')
  })

  test('the same term, however it is spelled, is one request', () => {
    assert.equal(asks(CHARACTER, 'Harry Potter').path, asks(CHARACTER, 'harry potter ').path)
  })

  test('asks nothing under two characters', () => {
    assert.equal(asks(FANDOM, ''), null)
    assert.equal(asks(FANDOM, 'p'), null)
    assert.equal(asks(FANDOM, '  p  '), null)
    assert.notEqual(asks(FANDOM, 'po'), null)
  })

  test('asks only in Exact mode', () => {
    assert.equal(suggestRequest(FANDOM, 'contains', 'potter'), null)
    assert.equal(suggestRequest(FANDOM, 'regex', 'potter'), null)
  })

  test('asks nothing for the archive\'s fixed names, or where there are no suggestions', () => {
    assert.equal(asks(RATING, 'mature'), null)
    assert.equal(asks(AUTHOR, 'someone'), null)
  })
})

describe('whenDue', () => {
  const pot = asks(FANDOM, 'pot')

  test('sends the request when nothing stands in its way, and waits for it', () => {
    const next = whenDue(NO_ANSWERS, pot, null)
    assert.equal(next.send, true)
    assert.equal(next.state.asking, pot.path)
  })

  test('sends nothing when the field wants nothing', () => {
    assert.deepEqual(whenDue(NO_ANSWERS, null, null), { state: NO_ANSWERS, send: false })
  })

  test('an answer already had is not asked for again', () => {
    const state = answered(FANDOM, 'pot', POTTER_FANDOMS)
    assert.deepEqual(whenDue(state, asks(FANDOM, 'POT'), null), { state, send: false })
  })

  test('nor is the request already on its way', () => {
    const state = whenDue(NO_ANSWERS, pot, null).state
    assert.deepEqual(whenDue(state, pot, null), { state, send: false })
  })

  test('a newer request goes out while an older one is on its way, and is the one waited for', () => {
    const state = whenDue(NO_ANSWERS, pot, null).state
    const next = whenDue(state, asks(FANDOM, 'pott'), null)
    assert.equal(next.send, true)
    assert.equal(next.state.asking, '/autocomplete/fandom?term=pott')
  })

  test('after a failure nothing more is asked', () => {
    const state = withFailure(whenDue(NO_ANSWERS, pot, null).state)
    assert.deepEqual(whenDue(state, asks(FANDOM, 'pott'), null), { state, send: false })
  })

  test('under a refusal nothing is sent, and suggestions pause until it ends', () => {
    const next = whenDue(NO_ANSWERS, pot, REFUSED)
    assert.equal(next.send, false)
    assert.equal(next.state.pausedUntil, REFUSED.until)
    assert.equal(next.state.asking, null)
  })

  test('a request due a breather is skipped, and nothing is kept to send after it', () => {
    const next = whenDue(NO_ANSWERS, pot, BREATHER)
    assert.equal(next.send, false)
    assert.equal(next.state.asking, null)
    assert.equal(next.state.pausedUntil, 0)
  })

  test('the archive decides: once it holds no pause, a request goes out though the pause has not been lifted yet', () => {
    const paused = withRefusal(NO_ANSWERS, REFUSED)
    const next = whenDue(paused, pot, null)
    assert.equal(next.send, true)
    assert.equal(next.state.pausedUntil, 0)
  })
})

describe('withAnswer', () => {
  test('keeps the answer and stops waiting for it', () => {
    const pot = asks(FANDOM, 'pot')
    const state = withAnswer(whenDue(NO_ANSWERS, pot, null).state, pot, POTTER_FANDOMS)
    assert.deepEqual(state.answers[pot.path], POTTER_FANDOMS)
    assert.equal(state.asking, null)
    assert.equal(state.latest, pot)
  })

  test('an answer to an older request is kept, and the newer one is still waited for', () => {
    const pot = asks(FANDOM, 'pot')
    const pott = asks(FANDOM, 'pott')
    const waiting = whenDue(whenDue(NO_ANSWERS, pot, null).state, pott, null).state
    const state = withAnswer(waiting, pot, POTTER_FANDOMS)
    assert.deepEqual(state.answers[pot.path], POTTER_FANDOMS)
    assert.equal(state.asking, pott.path)
  })
})

describe('withRefusal, withResume and withFailure', () => {
  const pot = asks(FANDOM, 'pot')
  const waiting = whenDue(answered(CHARACTER, 'harry', ['Harry Potter']), pot, null).state

  test('a refusal stops the wait and pauses suggestions until the time it names', () => {
    const state = withRefusal(waiting, REFUSED)
    assert.equal(state.asking, null)
    assert.equal(state.pausedUntil, REFUSED.until)
    assert.equal(state.failed, false)
  })

  test('a refusal that leaves no refusal to sit out is a failure, even during a breather: asking again once it ends would be a retry loop', () => {
    for (const pause of [null, BREATHER]) {
      const state = withRefusal(waiting, pause)
      assert.equal(state.asking, null, pause?.reason)
      assert.equal(state.pausedUntil, 0, pause?.reason)
      assert.equal(state.failed, true, pause?.reason)
    }
  })

  test('resuming lifts the pause, and keeps the answers had', () => {
    const state = withResume(withRefusal(waiting, REFUSED))
    assert.equal(state.pausedUntil, 0)
    assert.deepEqual(state.answers, waiting.answers)
  })

  test('a failure stops the wait and the asking', () => {
    const state = withFailure(waiting)
    assert.equal(state.asking, null)
    assert.equal(state.failed, true)
  })
})

describe('suggestBox', () => {
  const potter = answered(FANDOM, 'potter', POTTER_FANDOMS)

  test('AO3\'s names for the term in the field, in its order, with the words typed marked', () => {
    assert.deepEqual(box(potter, FANDOM, 'potter'), {
      kind: 'names',
      options: [
        { name: 'Harry Potter - J. K. Rowling', html: 'Harry <mark>Potter</mark> - J. K. Rowling' },
        { name: 'Harry Potter and the Cursed Child - Thorne & Rowling', html: 'Harry <mark>Potter</mark> and the Cursed Child - Thorne &amp; Rowling' },
        { name: 'Harry Potter: Hogwarts Mystery (Video Game)', html: 'Harry <mark>Potter</mark>: Hogwarts Mystery (Video Game)' },
      ],
    })
  })

  test('the marks follow the field as typed, not the term as sent', () => {
    const state = answered(FANDOM, 'harry pot', ['Harry Potter - J. K. Rowling'])
    assert.equal(box(state, FANDOM, 'Harry  Pot').options[0].html, '<mark>Harry</mark> <mark>Pot</mark>ter - J. K. Rowling')
  })

  test('while the next answer is awaited, the last one for the same endpoint stands in', () => {
    assert.deepEqual(box(potter, FANDOM, 'potterh').options.map(option => option.name), POTTER_FANDOMS)
  })

  test('a term skipped for a breather has nothing standing in, since no answer to it is coming', () => {
    const skipped = whenDue(potter, asks(FANDOM, 'draco'), BREATHER).state
    assert.deepEqual(box(skipped, FANDOM, 'draco'), { kind: 'none' })
  })

  test('nor does an older answer that arrives after the skip', () => {
    const pot = asks(FANDOM, 'pot')
    const skipped = whenDue(whenDue(NO_ANSWERS, pot, null).state, asks(FANDOM, 'pott'), BREATHER).state
    assert.deepEqual(box(withAnswer(skipped, pot, POTTER_FANDOMS), FANDOM, 'pott'), { kind: 'none' })
  })

  test('typing on from a skipped term, or asking for it after all, the last answer stands in again', () => {
    const skipped = whenDue(potter, asks(FANDOM, 'pottery'), BREATHER).state
    assert.deepEqual(box(skipped, FANDOM, 'potteryx').options.map(option => option.name), POTTER_FANDOMS)
    const asked = whenDue(skipped, asks(FANDOM, 'pottery'), null).state
    assert.deepEqual(box(asked, FANDOM, 'pottery').options.map(option => option.name), POTTER_FANDOMS)
  })

  test('but never another endpoint\'s', () => {
    assert.deepEqual(box(answered(CHARACTER, 'potter', ['Harry Potter']), FANDOM, 'potter'), { kind: 'none' })
  })

  test('an empty answer shows nothing, rather than the last one', () => {
    const state = answered(FANDOM, 'pottxq', [], potter)
    assert.deepEqual(box(state, FANDOM, 'pottxq'), { kind: 'none' })
  })

  test('nothing under two characters, or outside Exact mode, or where there are no suggestions', () => {
    assert.deepEqual(box(potter, FANDOM, 'p'), { kind: 'none' })
    assert.deepEqual(suggestBox(potter, FANDOM, 'contains', 'potter'), { kind: 'none' })
    assert.deepEqual(suggestBox(potter, FANDOM, 'regex', 'potter'), { kind: 'none' })
    assert.deepEqual(box(potter, AUTHOR, 'potter'), { kind: 'none' })
  })

  test('paused while a refusal is sat out, whatever is typed', () => {
    const paused = withRefusal(potter, REFUSED)
    for (const value of ['potter', 'pott', 'harry'])
      assert.deepEqual(box(paused, FANDOM, value), { kind: 'paused', text: SUGGEST_NOTES.paused }, value)
    assert.equal(SUGGEST_NOTES.paused, 'AO3 asked us to slow down — suggestions are paused')
  })

  test('unavailable after a failure, whatever is typed', () => {
    const failed = withFailure(potter)
    for (const value of ['potter', 'pott', 'harry'])
      assert.deepEqual(box(failed, FANDOM, value), { kind: 'unavailable', text: SUGGEST_NOTES.unavailable }, value)
    assert.equal(SUGGEST_NOTES.unavailable, 'Suggestions unavailable')
  })

  test('neither note where nothing would be asked', () => {
    for (const state of [withRefusal(potter, REFUSED), withFailure(potter)]) {
      assert.deepEqual(box(state, FANDOM, 'p'), { kind: 'none' })
      assert.deepEqual(suggestBox(state, FANDOM, 'contains', 'potter'), { kind: 'none' })
    }
  })

  test('a rating, an archive warning or a category offers its fixed names that hold what is typed, from the first letter', () => {
    const names = (source, value) => box(NO_ANSWERS, source, value).options?.map(option => option.name)
    assert.deepEqual(names(RATING, 'teen'), ['Teen And Up Audiences'])
    assert.deepEqual(names(RATING, 'AUD'), ['General Audiences', 'Teen And Up Audiences'])
    assert.deepEqual(names(CATEGORY, 'm'), ['F/M', 'M/M', 'Multi'])
    assert.equal(box(NO_ANSWERS, RATING, 'teen').options[0].html, '<mark>Teen</mark> And Up Audiences')
  })

  test('the fixed names show nothing with nothing typed, nothing matching, or outside Exact mode', () => {
    assert.deepEqual(box(NO_ANSWERS, RATING, ' '), { kind: 'none' })
    assert.deepEqual(box(NO_ANSWERS, RATING, 'fluff'), { kind: 'none' })
    assert.deepEqual(suggestBox(NO_ANSWERS, RATING, 'contains', 'teen'), { kind: 'none' })
  })
})

describe('suggestKey', () => {
  const at = active => ({ shown: true, active })

  test('the list starts shown, with no name chosen', () => {
    assert.deepEqual(CURSOR_START, { shown: true, active: -1 })
  })

  test('the arrows walk the names, round from either end', () => {
    const down = cursor => suggestKey(cursor, 'ArrowDown', 3).cursor
    const up = cursor => suggestKey(cursor, 'ArrowUp', 3).cursor
    assert.deepEqual([down(at(-1)), down(at(0)), down(at(2))], [at(0), at(1), at(0)])
    assert.deepEqual([up(at(-1)), up(at(0)), up(at(2))], [at(2), at(2), at(1)])
    assert.equal(suggestKey(at(0), 'ArrowDown', 3).pick, null)
  })

  test('an arrow opens a closed list', () => {
    assert.deepEqual(suggestKey({ shown: false, active: -1 }, 'ArrowDown', 3), { cursor: at(0), pick: null })
    assert.deepEqual(suggestKey({ shown: false, active: -1 }, 'ArrowUp', 3), { cursor: at(2), pick: null })
  })

  test('Enter picks the name the arrows are on, and closes the list', () => {
    assert.deepEqual(suggestKey(at(1), 'Enter', 3), { cursor: { shown: false, active: -1 }, pick: 1 })
  })

  test('Enter with no name chosen, or on a closed list, is not the list\'s', () => {
    assert.equal(suggestKey(at(-1), 'Enter', 3), null)
    assert.equal(suggestKey({ shown: false, active: -1 }, 'Enter', 3), null)
  })

  test('Escape closes the list, and on a closed list is not the list\'s', () => {
    assert.deepEqual(suggestKey(at(1), 'Escape', 3), { cursor: { shown: false, active: -1 }, pick: null })
    assert.equal(suggestKey({ shown: false, active: -1 }, 'Escape', 3), null)
  })

  test('with no names, no key is the list\'s', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'])
      assert.equal(suggestKey(at(-1), key, 0), null, key)
  })

  test('any other key is not the list\'s', () => {
    for (const key of ['a', 'Tab', 'Home', ' '])
      assert.equal(suggestKey(at(1), key, 3), null, key)
  })
})
