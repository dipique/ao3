import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { sleep } from './helpers.mjs'
import { skip, startOptions } from './optionsPage.mjs'

/**
 * Rules chosen to pin down what the filter does and does not look at:
 * casing, a substring that is not a prefix, a `.` and a `*` that must stay
 * literal, and a pseud/target that must NOT be searchable.
 */
const RULES = [
  { target: 'tag', value: 'Slow Burn', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'slow build', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'Enemies to Lovers', matcher: 'exact', behavior: 'hide' },
  { target: 'f', value: 'Teen Wolf (TV)', matcher: 'exact', behavior: 'hide' },
  { target: 'author', value: 'someone', pseud: 'BurnNotice', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: 'A.B.O. Dynamics', matcher: 'exact', behavior: 'hide' },
  { target: 'tag', value: '5*Stars', matcher: 'exact', behavior: 'hide' },
]

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

const LIST = 'rules'

/**
 * Filtering the rules list from the filter in its header. It filters on the
 * rule *text* alone — a few hundred rules are searched for the tag you
 * half-remember, and matching the target or pseud would turn up rules whose
 * text has nothing to do with what was typed.
 */
describe('options UI — rules filter', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
    options = await session.open({ seed: SEED, hash: '#customize-search-results' })
  }, { timeout: 180000 })

  after(() => session?.close())

  const filterBox = async () => options.control(await options.list(LIST), 'textbox', 'Search rules by text')

  /** Type `text` into the filter (replacing whatever is there). */
  const filter = async (text) => {
    const box = await filterBox()
    await box.click({ clickCount: 3 })
    await options.page.keyboard.press('Backspace')
    if (text)
      await box.type(text)
    await sleep(300)
  }

  /** The text of every rule the list is showing. Each row is the rule at that place in the stored list. */
  const rows = async () => (await options.listRowIds(LIST)).map(at => RULES[Number(at)].value)

  test('every rule is listed before anything is typed, and the header counts them', async () => {
    await filter('')
    const listed = await rows()
    assert.equal(listed.length, RULES.length, listed.join(' | '))
    assert.equal(await options.listCount(LIST), `${RULES.length} rules`)
  })

  test('matching is case-insensitive', async () => {
    await filter('SLOW')
    const listed = await rows()
    await filter('')
    assert.deepEqual(listed.sort(), ['Slow Burn', 'slow build'])
  })

  test('it matches anywhere in the text, not just the start', async () => {
    await filter('lovers')
    const listed = await rows()
    await filter('')
    assert.deepEqual(listed, ['Enemies to Lovers'])
  })

  test('what a rule applies to is not searched', async () => {
    // "Fandom" is what one of these rules applies to, but no rule has the word
    // in its text — so this must find nothing.
    await filter('fandom')
    const listed = await rows()
    await filter('')
    assert.deepEqual(listed, [])
  })

  test('an author pseud is not searched either', async () => {
    // The pseud renders right beside the rule text, so it is the obvious thing
    // to match by accident.
    await filter('BurnNotice')
    const listed = await rows()
    await filter('')
    assert.deepEqual(listed, [])

    await filter('someone')
    const byValue = await rows()
    await filter('')
    assert.deepEqual(byValue, ['someone'], 'the author value itself still matches')
  })

  test('a dot is a dot, not a wildcard', async () => {
    await filter('A.B.O')
    const listed = await rows()
    await filter('')
    assert.deepEqual(listed, ['A.B.O. Dynamics'])
  })

  test('a star is a star, not a wildcard', async () => {
    await filter('5*')
    const listed = await rows()
    await filter('')
    assert.deepEqual(listed, ['5*Stars'])
  })

  test('no matches says so in the list\'s place', async () => {
    await filter('zzzzz')
    const listed = await rows()
    const text = await options.text(await options.list(LIST))
    await filter('')
    assert.deepEqual(listed, [])
    assert.match(text, /No rules match “zzzzz”/, 'an empty result explains itself')
  })

  test('the header\'s count shows how much of the list is showing', async () => {
    await filter('slow')
    const count = await options.listCount(LIST)
    await filter('')
    assert.equal(count, `2 of ${RULES.length}`)
  })

  test('clearing the filter brings the whole list back, and keeps the focus in it', async () => {
    await filter('slow')
    await (await options.control(await options.list(LIST), 'button', 'Clear rule search')).click()
    await sleep(300)
    const listed = await rows()
    const box = await filterBox()
    assert.equal(await box.evaluate(el => el.value), '')
    assert.equal(listed.length, RULES.length)
    assert.equal(await box.evaluate(el => el === document.activeElement), true, 'the clear button went, so the field has the focus')
  })

  test('filtering writes nothing', async () => {
    await filter('slow')
    await filter('')
    await sleep(500)
    assert.equal(await options.lastWrite('option.rules'), null)
  })

  test('renders without console errors', () => {
    assert.deepEqual(options.problems(), [])
  })
})
