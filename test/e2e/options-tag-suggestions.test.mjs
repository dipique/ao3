import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'

import { TagType } from '../../src/common/data.ts'
import { SUGGEST_NOTES } from '../../src/options_ui/model/tagSuggestions.ts'
import { ARCHIVE, contrastRatio, mentions, skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { RuleEditor } from './ruleEditor.mjs'

/** AO3's answers to its tag autocomplete, recorded signed out and trimmed to a few names each, keyed by request. */
const RECORDED = JSON.parse(readFileSync(new URL('../options/ao3-autocomplete.json', import.meta.url), 'utf8'))

/** AO3's recorded answer from `endpoint`, or none. */
const recorded = endpoint => Object.entries(RECORDED).find(([request]) => request.split('?')[0] === endpoint)?.[1] ?? []

const FANDOMS = recorded('/autocomplete/fandom').map(tag => tag.name)
const CHARACTERS = recorded('/autocomplete/character').map(tag => tag.name)

/** What the stub answers unless a test says otherwise: the endpoint's recorded answer, whatever the term. */
const recordedReply = url => ({ json: recorded(new URL(url).pathname) })

/** The request for `term` from AO3's autocomplete for `kind`, as the stub sees it. */
const asking = (kind, term) => `${ARCHIVE}/autocomplete/${kind}?term=${encodeURIComponent(term)}`

/** One rule, for Edit to open. */
const SEED = { 'option.rules': { enabled: true, filters: [{ target: 'f', value: 'Harry Potter - J. K. Rowling', matcher: 'exact' }], colors: {} } }

describe('options UI — tag suggestions from AO3', { skip }, () => {
  let session
  let options
  let page
  /** The rule editor, on the page open now. */
  let editor
  /** What the page asked the stand-in for AO3 for, and gave up on. */
  let archive
  /** How the stand-in answers each request. A test may change it before it types. */
  let reply

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  // A page per test: the pacing and any refusal are the page's, and start over with it.
  beforeEach(async () => {
    reply = recordedReply
    options = await session.open({
      seed: SEED,
      hash: '#customize-search-results',
      prepare: async (tab) => {
        archive = await stubArchive(tab, url => reply(url))
      },
    })
    page = options.page
    editor = new RuleEditor(options)
  })

  afterEach(() => options?.close())

  // --- helpers bound to the live page ---
  /** The value field: a combobox while it offers suggestions, a plain text field otherwise. */
  const valueField = () => editor.field('value')
  const typeValue = async text => (await valueField()).type(text)
  const fieldValue = async () => (await valueField()).evaluate(el => el.value)
  const expanded = async () => (await valueField()).evaluate(el => el.getAttribute('aria-expanded'))
  /** The suggestions shown, as a screen reader reads them: the kind drawn beside each is hidden from it. */
  const suggestions = () => page.$$eval('[role="dialog"] [role="listbox"] [role="option"]', els => els
    .filter(el => el.checkVisibility())
    .map(el => [...el.childNodes]
      .filter(node => node.nodeType !== Node.ELEMENT_NODE || node.getAttribute('aria-hidden') !== 'true')
      .map(node => node.textContent)
      .join('')
      .trim()))
  const showsSuggestions = () => page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [role="option"]').length > 0)
  /** The suggestion with this name. */
  const suggestion = async (name) => {
    for (const option of await page.$$('[role="dialog"] [role="option"]')) {
      if ((await options.text(option)).startsWith(name))
        return option
    }
    assert.fail(`no suggestion “${name}”`)
  }
  /** The box's note, once it is this one. */
  const note = kind => page.waitForSelector(`[role="dialog"] [data-suggest="${kind}"]`)

  test('three fast keystrokes make one request, and its names show with the typed letters marked', async () => {
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('pot')
    await showsSuggestions()

    assert.deepEqual(archive.asked, [asking('fandom', 'pot')])
    assert.deepEqual(await suggestions(), FANDOMS)
    assert.deepEqual(await page.$$eval('[role="dialog"] [role="option"] mark', marks => marks.map(mark => mark.textContent)), ['Pot', 'Pot', 'Pot'])
    assert.equal(await expanded(), 'true')
    assert.ok(await options.contrast(await suggestion(FANDOMS[0])) >= 4.5, 'a suggestion reads at AA')
  })

  test('a pick writes AO3\'s spelling', async () => {
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('harry potter')
    await showsSuggestions()

    await options.press(await suggestion('Harry Potter - J. K. Rowling'))
    assert.equal(await fieldValue(), 'Harry Potter - J. K. Rowling')
    assert.equal(await expanded(), 'false', 'a pick closes the list')
    assert.deepEqual(await suggestions(), [])

    await editor.save()
    assert.deepEqual(await editor.written('Harry Potter - J. K. Rowling'), { target: 'f', value: 'Harry Potter - J. K. Rowling', matcher: 'exact' })
    assert.deepEqual(archive.asked, [asking('fandom', 'harry potter')])
  })

  test('the arrows and Enter pick too, and Escape closes the list before the dialog', async () => {
    await editor.openAdd()
    await editor.pick('target', TagType.Character)
    await typeValue('potter')
    await showsSuggestions()
    assert.deepEqual(await suggestions(), CHARACTERS)

    await page.keyboard.press('ArrowUp')
    const active = () => valueField().then(field => field.evaluate(el => document.getElementById(el.getAttribute('aria-activedescendant'))?.getAttribute('aria-selected')))
    assert.equal(await active(), 'true', 'the field names the chosen suggestion, which says it is chosen')
    await page.keyboard.press('Enter')
    assert.equal(await fieldValue(), 'Harry Potter', 'ArrowUp went round to the last')
    assert.equal(await expanded(), 'false')
    assert.ok(await page.$('[role="dialog"]'), 'Enter picks, and leaves the dialog open')

    await page.keyboard.press('ArrowDown')
    assert.equal(await expanded(), 'true', 'an arrow opens the list again')
    await page.keyboard.press('Escape')
    // The list goes at once; were the dialog closing too, it would be gone
    // once its closing animation had run.
    await page.waitForFunction(() => !document.querySelector('[role="dialog"] [data-suggest]'))
    await options.calm()
    assert.equal(await expanded(), 'false')
    assert.ok(await page.$('[role="dialog"]'), 'Escape closed the list, not the dialog')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))

    assert.deepEqual(archive.asked, [asking('character', 'potter')], 'picking asks nothing')
  })

  test('the suggestion the arrows are on is ringed, as a focused control is, in light and dark', async () => {
    for (const theme of ['light', 'dark']) {
      await options.close()
      options = await session.open({
        seed: SEED,
        theme,
        hash: '#customize-search-results',
        prepare: async (tab) => {
          archive = await stubArchive(tab, url => reply(url))
        },
      })
      page = options.page
      editor = new RuleEditor(options)
      await editor.openAdd()
      await editor.pick('target', TagType.Fandom)
      await typeValue('pot')
      await showsSuggestions()
      await page.keyboard.press('ArrowDown')
      await page.waitForSelector('[role="dialog"] [role="option"][aria-selected="true"]')
      await options.calm()

      /** The colour just inside an option's start edge, half way down. */
      const edge = async (index) => {
        const { left, top, height } = await page.$$eval('[role="dialog"] [role="option"]', (els, at) => els[at].getBoundingClientRect().toJSON(), index)
        return options.colourAt(Math.ceil(left) + 1, Math.round(top + height / 2))
      }
      const [chosen, other] = [await edge(0), await edge(1)]
      assert.ok(contrastRatio(chosen, other) >= 1.4, `${theme}: the chosen suggestion's edge is ${chosen}, the next one's ${other}`)
    }
  })

  test('answers are kept while the dialog is open, and asked for again once it reopens', async () => {
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('pot')
    await showsSuggestions()
    await typeValue('t')
    await until('“pott” to be asked', () => archive.asked.length === 2)
    await page.keyboard.press('Backspace')
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked, [asking('fandom', 'pot'), asking('fandom', 'pott')], 'going back to “pot” asks nothing')
    assert.deepEqual(await suggestions(), FANDOMS)

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('pot')
    await showsSuggestions()
    assert.deepEqual(archive.asked, [asking('fandom', 'pot'), asking('fandom', 'pott'), asking('fandom', 'pot')])
  })

  test('a newer term gives up the request still on its way, and only its own answer shows', async () => {
    /** The answer to “pot”, held back until the test lets it go, so it is still on its way when “pott” is typed. */
    let answerPot
    const potAnswer = new Promise((resolve) => {
      answerPot = () => resolve({ json: [{ id: 'Too Late', name: 'Too Late' }] })
    })
    reply = url => (url === asking('fandom', 'pot') ? potAnswer : recordedReply(url))
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('pot')
    await until('“pot” to be asked', () => archive.asked.length === 1)
    await typeValue('t')
    await showsSuggestions()

    assert.deepEqual(archive.asked, [asking('fandom', 'pot'), asking('fandom', 'pott')])
    await until('“pot” to be given up', () => archive.abandoned.length === 1)
    assert.deepEqual(archive.abandoned, [asking('fandom', 'pot')])
    answerPot()
    await archive.answered()
    assert.deepEqual(await suggestions(), FANDOMS, 'the older answer never shows')
  })

  test('a 429 pauses suggestions, nothing is sent while it lasts, and they resume when it ends', async () => {
    let calls = 0
    reply = url => (calls++ === 0 ? { status: 429, headers: { 'retry-after': '2' }, body: 'slow down' } : recordedReply(url))
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('pot')

    const paused = await note('paused')
    assert.ok(mentions(await options.text(paused), SUGGEST_NOTES.paused))
    assert.ok(await options.contrast(paused) >= 4.5, 'the note reads at AA')
    await typeValue('t')
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked, [asking('fandom', 'pot')], 'nothing is sent under the refusal')
    assert.ok(await page.$('[role="dialog"] [data-suggest="paused"]'), 'still paused')

    await showsSuggestions()
    assert.deepEqual(archive.asked, [asking('fandom', 'pot'), asking('fandom', 'pott')], 'the term in the field is asked for once the wait ends')
    assert.deepEqual(await suggestions(), FANDOMS)
  })

  test('a network failure says so once, asks nothing more, and the rule still saves', async () => {
    reply = () => 'fail'
    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await typeValue('pot')

    const unavailable = await note('unavailable')
    assert.ok(mentions(await options.text(unavailable), SUGGEST_NOTES.unavailable))
    assert.ok(await options.contrast(unavailable) >= 4.5, 'the note reads at AA')
    await typeValue('ter')
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked, [asking('fandom', 'pot')], 'no retry')
    assert.equal(await page.$$eval('[role="dialog"] [data-suggest]', boxes => boxes.length), 1, 'one note')

    await editor.save()
    assert.deepEqual(await editor.written('potter'), { target: 'f', value: 'potter', matcher: 'exact' })
  })

  test('nothing is asked on opening a rule, in Contains or Regex mode, or for an author; a rating offers the archive\'s names', async () => {
    await editor.openEdit('Harry Potter - J. K. Rowling')
    await options.suggestionsAsked(archive)
    await options.closeDialog()

    await editor.openAdd()
    await editor.pick('target', TagType.Fandom)
    await editor.pick('matcher', 'contains')
    await typeValue('potter')
    await options.suggestionsAsked(archive)
    await editor.pick('matcher', 'regex')
    await typeValue('s')
    await options.suggestionsAsked(archive)
    await editor.pick('target', 'author')
    await editor.pick('matcher', 'exact')
    await typeValue('x')
    await options.suggestionsAsked(archive)
    assert.equal(await page.$('[role="dialog"] [data-suggest]'), null, 'no suggestions shown')
    assert.deepEqual(archive.asked, [])

    await editor.pick('target', TagType.Rating)
    const field = await valueField()
    await field.evaluate(el => el.select())
    await field.type('teen')
    await showsSuggestions()
    assert.deepEqual(await suggestions(), ['Teen And Up Audiences'])
    await options.press(await suggestion('Teen And Up Audiences'))
    assert.equal(await fieldValue(), 'Teen And Up Audiences')
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked, [], 'the rating\'s names are the archive\'s fixed ones, not asked for')
  })
})
