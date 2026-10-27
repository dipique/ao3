import assert from 'node:assert/strict'
import { after, afterEach, before, describe, test } from 'node:test'

import { REGEX_CHECKING_HOLD_MS, REGEX_TIME_BUDGET_MS } from '../../src/common/constants.ts'
import { TagType } from '../../src/common/data.ts'
import { CANONICAL_TOO_SLOW } from '../../src/options_ui/model/canonicalTags.ts'
import { TESTER_STOPPED, TOO_SLOW } from '../../src/options_ui/model/ruleEditor.ts'
import { mentions, skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { RuleEditor } from './ruleEditor.mjs'

/** A pattern that backtracks without end over a run of a's ending in anything else. */
const RUNAWAY_PATTERN = '(a+)+$'

/** What it backtracks over: long enough that, left alone, it would run for hours. */
const RUNAWAY_TAG = `${'a'.repeat(40)}!`

/**
 * The budget as these tests run it: cut from a second, since what matters is
 * that a check is stopped once it runs out, not how long that takes.
 */
const BUDGET = 250

/**
 * How long a test gives a check to be stopped: the budget, and time over for
 * the worker to say it began and for the page to draw what it found.
 */
const STOPPED_WITHIN = BUDGET + 1000

/** Tags learned while browsing, as the content script keeps them: by lowercased name. */
const learned = names => Object.fromEntries(names.map((name, i) => [name.toLowerCase(), { id: i + 1, name }]))

describe('options UI — a time budget for regex patterns', { skip }, () => {
  let session
  let options
  let page
  /** The rule editor, on the page open now. */
  let editor

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  afterEach(() => options?.close())

  /** `script`: a page script of the test's own, run before the page's. */
  const openPage = async (seed, script) => {
    options = await session.open({
      seed: { 'option.rules': { enabled: true, filters: [], colors: {} }, ...seed },
      hash: '#customize-search-results',
      hurry: { [REGEX_TIME_BUDGET_MS]: BUDGET },
      // Nothing here is a pattern AO3 is asked about; the stand-in makes sure of it.
      prepare: async (tab) => {
        await stubArchive(tab, () => ({ json: [] }))
        if (script)
          await tab.evaluateOnNewDocument(script)
      },
    })
    page = options.page
    editor = new RuleEditor(options)
  }

  // --- helpers bound to the live page ---
  const patternField = () => editor.field('value')
  const testField = () => editor.field('test')
  const verdictKind = () => page.$eval('[role="dialog"] [data-regex-verdict]', el => el.dataset.regexVerdict)
  /** The verdict, once it is this one. */
  const verdict = (kind, timeout) => page.waitForSelector(`[role="dialog"] [data-regex-verdict="${kind}"]`, { timeout })
  const ruleWrites = () => page.evaluate(() => window.__writes.filter(w => 'option.rules' in w).length)

  test('a pattern that runs past the budget is stopped while the page answers; it can\'t be saved until it changes', async () => {
    await openPage({ 'fandomCache.characters': learned(['Original Female Character(s)', 'Harry Potter']) })
    await editor.openAdd()
    await editor.pick('target', TagType.Character)
    await editor.pick('matcher', 'regex')
    await (await testField()).type(RUNAWAY_TAG)
    await (await patternField()).type(RUNAWAY_PATTERN.slice(0, -1))
    assert.ok(await verdict('match'), 'without its anchor, the pattern is quick')
    await options.press(await options.action(await editor.dialog(), 'canonical'))
    await page.waitForSelector('[role="dialog"] [data-canonical-part="tag"]')
    const before = await ruleWrites()

    const typed = Date.now()
    await (await patternField()).type(RUNAWAY_PATTERN.slice(-1))
    assert.ok(await verdict('checking'), 'the page draws while the check runs')
    await options.frame()
    assert.equal(await verdictKind(), 'checking', 'and answers, still checking')

    assert.ok(await verdict('slow', STOPPED_WITHIN))
    assert.ok(Date.now() - typed >= BUDGET, 'stopped only once the budget ran out')
    const verdictHandle = await page.$('[role="dialog"] [data-regex-verdict]')
    assert.ok(await options.contrast(verdictHandle) >= 4.5, 'the verdict reads at AA')
    assert.ok(mentions(await options.description(await testField()), TESTER_STOPPED))
    assert.ok(mentions(await options.description(await patternField()), TOO_SLOW), 'the value field says so')
    const save = await editor.saveButton()
    assert.equal(await save.evaluate(el => el.disabled), true, 'Add rule is off')
    assert.ok(mentions(await options.description(save), TOO_SLOW), 'with its reason')
    assert.ok(mentions(await save.evaluate(el => el.title), TOO_SLOW))
    const note = await page.waitForSelector('[role="dialog"] [data-canonical-part="note"]')
    assert.ok(mentions(await options.text(note), CANONICAL_TOO_SLOW), 'the preview stops with its note')
    assert.equal(await page.$('[role="dialog"] [data-canonical-part="tag"]'), null)

    await options.press(save)
    await options.saved()
    assert.equal(await ruleWrites(), before, 'nothing is written')

    await editor.retype('value', '^a+!$')
    assert.ok(await verdict('match'), 'a changed pattern is checked again')
    await page.waitForFunction(el => !el.disabled, {}, save)
    assert.equal(await options.description(save), '')
    await options.press(save)
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await options.saved()
    assert.deepEqual((await options.lastWrite('option.rules')).filters, [{ target: 'C', value: '^a+!$', matcher: 'regex' }])
    assert.deepEqual(options.problems(), [])
  })

  test('a check under way keeps the last verdict for the hold, then says Checking…', async () => {
    await openPage({ 'fandomCache.characters': learned(['Harry Potter']) })
    await editor.openAdd()
    await editor.pick('target', TagType.Character)
    await editor.pick('matcher', 'regex')
    await (await testField()).type(RUNAWAY_TAG)
    await (await patternField()).type(RUNAWAY_PATTERN.slice(0, -1))
    assert.ok(await verdict('match'))

    // From the next keystroke on, each verdict the tester draws, and when.
    await page.evaluate(() => {
      const drawn = window.__verdicts = []
      addEventListener('keydown', () => drawn.push({ kind: 'typed', at: performance.now() }), { capture: true, once: true })
      const el = document.querySelector('[role="dialog"] [data-regex-verdict]')
      new MutationObserver(() => drawn.push({ kind: el.dataset.regexVerdict, at: performance.now() }))
        .observe(el, { attributes: true, attributeFilter: ['data-regex-verdict'] })
    })
    await (await patternField()).type(RUNAWAY_PATTERN.slice(-1))
    await verdict('checking')
    const [typed, first] = await page.evaluate(() => window.__verdicts)
    assert.equal(typed.kind, 'typed')
    assert.equal(first.kind, 'checking', 'the last verdict is kept until then')
    assert.ok(first.at - typed.at >= REGEX_CHECKING_HOLD_MS, `Checking… drawn ${first.at - typed.at} ms after the keystroke`)
  })

  test('a rule opened with a pattern too slow for the names known here can\'t be saved again until it changes', async () => {
    const rule = { target: 'C', value: RUNAWAY_PATTERN, matcher: 'regex', behavior: 'collapse' }
    await openPage({
      'option.rules': { enabled: true, filters: [rule], colors: {} },
      'fandomCache.characters': learned(['Harry Potter', RUNAWAY_TAG]),
    })
    const before = await ruleWrites()
    await editor.openEdit(RUNAWAY_PATTERN)

    const save = await editor.saveButton()
    await options.press(save)
    assert.ok(await verdict('slow', STOPPED_WITHIN), 'checked over the names known here, with nothing typed to test')
    assert.equal(await save.evaluate(el => el.disabled), true)
    assert.ok(mentions(await options.description(save), TOO_SLOW))
    await options.saved()
    assert.equal(await ruleWrites(), before, 'a press while the check ran saved nothing')

    await editor.retype('value', '^Harry')
    await page.waitForFunction(el => !el.disabled, {}, save)
    await options.press(save)
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await options.saved()
    assert.deepEqual((await options.lastWrite('option.rules')).filters, [{ ...rule, value: '^Harry' }])
  })

  const BROKEN_WORKERS = {
    'can\'t load its script': () => {
      const Native = window.Worker
      window.Worker = class extends Native {
        constructor(url, options) {
          super(`${url}-missing`, options)
        }
      }
    },
    'is refused by the browser': () => {
      window.Worker = class {
        constructor() {
          throw new DOMException('Refused to start the worker.', 'SecurityError')
        }
      }
    },
  }

  for (const [broken, script] of Object.entries(BROKEN_WORKERS)) {
    test(`a worker that ${broken} ends the check as too slow, rather than leaving it under way`, async () => {
      await openPage({ 'fandomCache.characters': learned(['Harry Potter']) }, script)
      await editor.openAdd()
      await editor.pick('target', TagType.Character)
      await editor.pick('matcher', 'regex')
      await (await testField()).type('Harry Potter')
      await (await patternField()).type('^harry')
      assert.ok(await verdict('slow', STOPPED_WITHIN))
      const save = await editor.saveButton()
      assert.equal(await save.evaluate(el => el.disabled), true)
      await options.press(save)
      await options.saved()
      assert.equal(await options.lastWrite('option.rules'), null, 'nothing is written')
      assert.deepEqual(options.problems(/^\[rule editor\] The worker testing a pattern failed/), [])
    })
  }

  test('an ordinary pattern is checked and saved as before', async () => {
    await openPage({ 'fandomCache.characters': learned(['Harry Potter']) })
    await editor.openAdd()
    await editor.pick('target', TagType.Character)
    await editor.pick('matcher', 'regex')
    await (await patternField()).type('^harry')
    await (await testField()).type('Harry Potter')
    assert.ok(await verdict('match'))
    await options.press(await editor.saveButton())
    await until('the rule to be written', async () => (await options.lastWrite('option.rules'))?.filters.length === 1)
    assert.deepEqual((await options.lastWrite('option.rules')).filters, [{ target: 'C', value: '^harry', matcher: 'regex' }])
  })
})
