import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, describe, test } from 'node:test'

import { ARCHIVE, skip, startOptions, stubArchive, until } from './optionsPage.mjs'

/** AO3's answers to its tag autocomplete, recorded signed out and trimmed to a few names each, keyed by request. */
const RECORDED = JSON.parse(readFileSync(new URL('../options/ao3-autocomplete.json', import.meta.url), 'utf8'))

/** The fandoms AO3 offered for “potter”. */
const POTTER_FANDOMS = RECORDED['/autocomplete/fandom?term=potter'].map(tag => tag.name)

/** The bundled fandoms' names, lowercased, as the build ships them. */
const BUNDLED = Object.keys(JSON.parse(readFileSync(new URL('../../src/data/fandom-index.json', import.meta.url), 'utf8')))

/** Tags learned while browsing, as the content script keeps them: by lowercased name. */
const learned = names => Object.fromEntries(names.map((name, i) => [name.toLowerCase(), { id: i + 1, name }]))

const LEARNED_CHARACTERS = ['Original Female Character(s)', 'Original Male Character(s)', 'Harry Potter']
const LEARNED_FANDOMS = ['Good Omens (TV)']

const SEED = {
  'option.rules': { enabled: true, filters: [], colors: {} },
  'fandomCache.characters': learned(LEARNED_CHARACTERS),
  'fandomCache.fandoms': learned(LEARNED_FANDOMS),
}

/** What the stand-in for AO3's character autocomplete answers, by term. */
const CHARACTERS = {
  'character(s)': ['Original Character(s)', 'Original Child Character(s)', 'Original Female Character(s)'],
  'original': ['Original Character(s)', 'Original Child Character(s)'],
  'female': ['Female Shepard (Mass Effect)', 'Original Female Character(s)'],
  'child': ['Original Child Character(s)', 'Child Harry Potter'],
}

/** The stand-in's usual answer: the names above for a character, the recorded “potter” fandoms for a fandom, nothing else. */
const usualReply = (url) => {
  const { pathname, searchParams } = new URL(url)
  const names = pathname === '/autocomplete/character'
    ? CHARACTERS[searchParams.get('term')] ?? []
    : pathname === '/autocomplete/fandom' ? POTTER_FANDOMS : []
  return { json: names.map(name => ({ id: name, name })) }
}

/** The request for `term` from AO3's autocomplete for `kind`, as the stand-in sees it. */
const asking = (kind, term) => `${ARCHIVE}/autocomplete/${kind}?term=${encodeURIComponent(term)}`

const SHOW = 'Show matching canonical tags'
const HIDE = 'Hide matching canonical tags'

describe('options UI — matching canonical tags', { skip }, () => {
  let session
  let options
  let page
  /** What the page asked the stand-in for AO3 for. */
  let archive

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** A page per test: the pacing and any refusal are the page's, and start over with it. */
  const openPage = async ({ reply = usualReply, theme } = {}) => {
    options = await session.open({
      seed: SEED,
      theme,
      hash: '#customize-search-results',
      prepare: async (tab) => {
        archive = await stubArchive(tab, reply)
      },
    })
    page = options.page
  }

  afterEach(() => options?.close())

  // --- helpers bound to the live page ---
  const dialog = async () => {
    await page.waitForSelector('[role="dialog"]')
    return page.$('[role="dialog"]')
  }
  const openAddRule = async () => options.openDialog(await options.control(await options.list('rules'), 'button', 'Add a rule'))
  /** One of a radio group's choices, the group by its name, such as “What the rule matches”, once it is the one chosen. */
  const pick = async (group, name) => {
    const choice = await options.control(await options.control(await dialog(), 'radiogroup', group), 'radio', name)
    await options.press(choice)
    await page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', {}, choice)
  }
  /** The pattern: in Regex mode the value field is the first text field, above the tester's. */
  const setPattern = async (text) => {
    const field = await options.control(await dialog(), 'textbox')
    await field.evaluate(el => el.select())
    await field.type(text)
  }
  /** A rule on `target`, in Regex mode, with `pattern`. */
  const regexRule = async (target, pattern) => {
    await openAddRule()
    await pick('What the rule matches', target)
    await pick('How to match', 'Regex')
    await setPattern(pattern)
  }
  const toggles = async () => options.controls(await dialog(), 'button', /matching canonical tags$/)
  const press = async (name) => {
    await options.press(await options.control(await dialog(), 'button', name))
  }
  /** One part of the preview, once it shows. */
  const part = name => page.waitForSelector(`[role="dialog"] [data-canonical] [data-canonical-part="${name}"]`)
  const partText = async name => options.text(await part(name))
  /** The names the preview shows, and the text marked in each. */
  const tags = () => page.$$eval('[role="dialog"] [data-canonical] [data-canonical-part="tag"]', els => els.map(el => el.textContent))
  const marked = () => page.$$eval('[role="dialog"] [data-canonical] [data-canonical-part="tag"]', els => els.map(el => [...el.querySelectorAll('mark')].map(mark => mark.textContent).join('|')))
  const writes = () => page.evaluate(() => window.__writes.length)
  /**
   * Wait until the press has heard back from AO3 about every run it asked: the
   * preview shows AO3's answers, and its note, which says so while it asks,
   * doesn't, once the frames that draw the note have run.
   */
  const pressAnswered = () => until('the press to hear back from AO3', () => page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const note = document.querySelector('[role="dialog"] [data-canonical] [data-canonical-part="note"]')
    return !!document.querySelector('[role="dialog"] [data-canonical-part="sources"]') && note?.textContent.trim() !== 'Asking AO3…'
  }))

  test('a press asks AO3 about the pattern\'s three longest runs, edits filter again without asking, and nothing is written', async () => {
    await openPage()
    await regexRule('Character', '^Original (Female|Male) Character\\(s\\)')
    const before = await writes()
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked, [], 'nothing is asked before the press')

    const toggle = await options.control(await dialog(), 'button', SHOW)
    assert.equal(await toggle.evaluate(el => el.getAttribute('aria-expanded')), 'false')
    await press(SHOW)
    await pressAnswered()

    assert.deepEqual(archive.asked, [asking('character', 'character(s)'), asking('character', 'original'), asking('character', 'female')], 'three runs, longest first')
    assert.equal(await partText('head'), '2 of 6 known canonical Characters')
    assert.equal(await partText('sources'), 'plus AO3’s suggestions for “Character(s)”, “Original”, “Female”')
    assert.deepEqual(await tags(), ['Original Female Character(s)', 'Original Male Character(s)'])
    assert.deepEqual(await marked(), ['Original Female Character(s)', 'Original Male Character(s)'])
    const hide = await options.control(await dialog(), 'button', HIDE)
    assert.equal(await hide.evaluate(el => el.getAttribute('aria-expanded')), 'true')
    assert.equal(await hide.evaluate(el => document.getElementById(el.getAttribute('aria-controls'))?.hasAttribute('data-canonical')), true)
    assert.ok(await options.contrast(await part('head')) >= 4.5, 'the head line reads at AA')
    assert.ok(await options.contrast(await page.$('[role="dialog"] [data-canonical] mark')) >= 4.5, 'a match reads at AA')

    await setPattern('^Original (Female|Child)')
    await until('the preview to filter by the new pattern', async () => (await tags()).includes('Original Child Character(s)'))
    assert.deepEqual(await tags(), ['Original Child Character(s)', 'Original Female Character(s)'], 'AO3\'s answers are filtered again')
    assert.deepEqual(await marked(), ['Original Child', 'Original Female'])
    await options.suggestionsAsked(archive)
    assert.equal(archive.asked.length, 3, 'an edit asks nothing')

    await press(HIDE)
    assert.equal(await page.$('[role="dialog"] [data-canonical]'), null)
    await press(SHOW)
    await pressAnswered()
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked.slice(3), [asking('character', 'child')], 'the next press asks only what it hasn\'t had answered')
    assert.equal(await partText('sources'), 'plus AO3’s suggestions for “Original”, “Female”, “Child”')

    await options.closeDialog()
    await options.saved()
    assert.equal(await writes(), before, 'nothing is written')
    assert.deepEqual(options.problems(), [])
  })

  test('the bundled fandoms show in their lower case, and AO3\'s spelling where it answered', async () => {
    await openPage()
    await regexRule('Fandom', '^harry potter')
    await press(SHOW)
    await pressAnswered()

    assert.deepEqual(archive.asked, [asking('fandom', 'harry potter')])
    const pool = new Set([...BUNDLED, ...LEARNED_FANDOMS, ...POTTER_FANDOMS].map(name => name.toLowerCase()))
    const matches = BUNDLED.filter(name => /^harry potter/i.test(name))
    assert.equal(await partText('head'), `${matches.length} of ${pool.size.toLocaleString('en')} known canonical Fandoms`)
    assert.equal(await partText('sources'), 'plus AO3’s suggestions for “harry potter”')
    const spelled = new Map(POTTER_FANDOMS.map(name => [name.toLowerCase(), name]))
    assert.deepEqual(await tags(), matches.map(name => spelled.get(name) ?? name).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)))
    assert.ok((await tags()).includes('harry potter rpf'), 'a bundled name AO3 didn\'t give stays lowercased')
  })

  test('under a refusal the known names show with a note, the press asks nothing more, and a press under it asks nothing', async () => {
    let calls = 0
    await openPage({
      theme: 'dark',
      reply: url => (calls++ === 0 ? { status: 429, headers: { 'retry-after': '30' }, body: 'slow down' } : usualReply(url)),
    })
    await regexRule('Character', '^Original (Female|Male) Character\\(s\\)')
    await press(SHOW)

    const note = await part('note')
    assert.equal(await options.text(note), 'AO3 asked us to slow down — showing known tags only')
    assert.equal(await note.evaluate(el => el.getAttribute('role')), 'status')
    assert.deepEqual(await tags(), ['Original Female Character(s)', 'Original Male Character(s)'])
    assert.equal(await partText('head'), '2 of 3 known canonical Characters')
    assert.equal(await page.$('[role="dialog"] [data-canonical-part="sources"]'), null)
    await options.suggestionsAsked(archive)
    assert.deepEqual(archive.asked, [asking('character', 'character(s)')], 'the refusal stops the press')
    for (const handle of [note, await part('head'), await page.$('[role="dialog"] [data-canonical] mark')])
      assert.ok(await options.contrast(handle) >= 4.5, `${await options.text(handle)} reads at AA in dark`)

    await press(HIDE)
    await press(SHOW)
    await part('note')
    await options.suggestionsAsked(archive)
    assert.equal(archive.asked.length, 1, 'a press under the refusal asks nothing')
  })

  test('offline, additional tags show only the note; the preview is offered in Regex mode for tags alone', async () => {
    await openPage({ reply: () => 'fail' })
    await regexRule('Additional Tags', 'Fluff')
    await press(SHOW)

    assert.equal(await partText('note'), 'AO3’s suggestions are unavailable')
    assert.equal(await page.$('[role="dialog"] [data-canonical-part="head"]'), null)
    assert.deepEqual(await tags(), [])
    assert.deepEqual(archive.asked, [asking('freeform', 'fluff')])

    await pick('How to match', 'Exact')
    assert.deepEqual(await toggles(), [], 'not in Exact mode')
    await pick('How to match', 'Contains')
    assert.deepEqual(await toggles(), [], 'not in Contains mode')
    await pick('How to match', 'Regex')
    assert.equal((await toggles()).length, 1)
    assert.equal(await page.$('[role="dialog"] [data-canonical]'), null, 'leaving Regex mode closed it')
    for (const target of ['Author', 'Work', 'Series']) {
      await pick('What the rule matches', target)
      assert.deepEqual(await toggles(), [], target)
    }
  })
})
