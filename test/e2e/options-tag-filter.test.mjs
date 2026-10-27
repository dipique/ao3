import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { compilePattern } from '../../src/options_ui/model/regexCheck.ts'
import { NO_PATTERN, TESTER_HELP, VERDICT_LABELS } from '../../src/options_ui/model/ruleEditor.ts'
import { mentions, skip, startOptions, stubArchive } from './optionsPage.mjs'
import { RuleEditor } from './ruleEditor.mjs'

/** A highlight in a colour of its own, a disabled rule, and a collapse rule to switch off. */
const RULES = [
  { target: 'F', value: 'Painted', matcher: 'exact', behavior: 'highlight', color: '#123456' },
  { target: 'C', value: 'Set aside', matcher: 'exact', behavior: 'none' },
  { target: 'F', value: 'Folded', matcher: 'exact', behavior: 'collapse' },
]

const SEED = { 'option.rules': { enabled: true, filters: RULES, colors: {} } }

describe('options UI — rules dialog', { skip }, () => {
  let session
  let options
  let page
  /** The rule editor. */
  let editor
  /** The stand-in for AO3. */
  let archive

  before(async () => {
    session = await startOptions()
    options = await session.open({
      seed: SEED,
      hash: '#customize-search-results',
      // A value typed in Exact mode asks AO3 for suggestions; none are wanted here.
      prepare: async (tab) => {
        archive = await stubArchive(tab, () => ({ json: [] }))
      },
    })
    page = options.page
    editor = new RuleEditor(options)
  }, { timeout: 180000 })

  after(() => session?.close())

  const checked = handle => handle.evaluate(el => el.getAttribute('aria-checked') === 'true')
  const disabled = handle => handle.evaluate(el => el.disabled)
  const enabledSwitch = () => editor.field('enabled')

  test('matcher icons render (codicon collection loaded)', async () => {
    assert.ok(await editor.openAdd(), 'the Add-rule dialog should open')
    const styles = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      const read = (sel) => {
        const el = d.querySelector(sel)
        if (!el)
          return null
        const s = getComputedStyle(el)
        return { mask: s.maskImage || s.webkitMaskImage || '', bg: s.backgroundImage || '' }
      }
      return { regex: read('[i-codicon-regex]'), contains: read('[i-codicon-whole-word]') }
    })
    const renders = s => s && (/url\(/.test(s.mask) || /url\(/.test(s.bg))
    assert.ok(renders(styles.regex), `regex icon should render an image, got ${JSON.stringify(styles.regex)}`)
    assert.ok(renders(styles.contains), `contains icon should render an image, got ${JSON.stringify(styles.contains)}`)
    await options.closeDialog()
  })

  test('creating a rule with the Regex matcher persists', async () => {
    assert.ok(await editor.openAdd(), 'the Add-rule dialog should open')
    await (await editor.field('value')).type('e2e-regex')
    await editor.pick('matcher', 'regex')
    await editor.save()
    const stored = await options.lastWrite('option.rules')
    assert.ok(
      stored?.filters?.some(f => f.value === 'e2e-regex' && f.matcher === 'regex' && f.target === 'tag'),
      `expected a persisted {target:'tag', value:'e2e-regex', matcher:'regex'} rule, got ${JSON.stringify(stored)}`,
    )
  })

  test('editing a rule to the Contains matcher persists', async () => {
    assert.ok(await editor.openEdit('e2e-regex'), 'the Edit-rule dialog should open')
    await editor.pick('matcher', 'contains')
    await editor.save()
    const stored = await options.lastWrite('option.rules')
    assert.ok(
      stored?.filters?.some(f => f.value === 'e2e-regex' && f.matcher === 'contains'),
      `expected the rule's matcher updated to 'contains', got ${JSON.stringify(stored)}`,
    )
  })

  test('the Amber swatch writes #f59e0b', async () => {
    assert.ok(await editor.openAdd(), 'the Add-rule dialog should open')
    await (await editor.field('value')).type('amber')
    await editor.pick('action', 'highlight')
    await editor.pick('swatch', 'Amber')
    await editor.save()
    assert.deepEqual(await editor.written('amber'), { target: 'tag', value: 'amber', matcher: 'exact', behavior: 'highlight', color: '#f59e0b' })
  })

  test('the Default swatch writes no colour of the rule\'s own', async () => {
    assert.ok(await editor.openEdit('amber'), 'the Edit-rule dialog should open')
    assert.ok(await checked(await editor.choice('swatch', 'Amber')), 'the rule opens on its preset')
    await editor.pick('swatch', 'default')
    await editor.save()
    assert.deepEqual(await editor.written('amber'), { target: 'tag', value: 'amber', matcher: 'exact', behavior: 'highlight' })
  })

  test('Your default highlight colours opens their dialog over the editor, and Escape goes back to the editor', async () => {
    assert.ok(await editor.openEdit('amber'), 'the Edit-rule dialog should open')
    await options.openDialog(await options.action(await editor.dialog(), 'default-colours'))
    /** Each open dialog, bottom first: whether it is the rule editor. */
    const dialogs = () => page.$$eval('[role="dialog"]', all => all.map(d => !!d.querySelector('[data-rule-field]')))
    assert.deepEqual(await dialogs(), [true, false])
    await options.closeDialog()
    assert.deepEqual(await dialogs(), [true])
    await options.closeDialog()
  })

  test('a rule with a colour of its own opens on Custom, with the picker on that colour', async () => {
    assert.ok(await editor.openEdit('Painted'), 'the Edit-rule dialog should open')
    for (const swatch of ['default', 'Sky', 'Amber', 'Violet'])
      assert.equal(await checked(await editor.choice('swatch', swatch)), false, swatch)
    assert.ok(await checked(await editor.choice('swatch', 'custom')))
    const fields = await options.controls(await editor.dialog(), 'textbox')
    const values = await Promise.all(fields.map(field => field.evaluate(el => el.value)))
    assert.ok(values.includes('#123456'), `the picker shows the colour, got ${JSON.stringify(values)}`)
    await options.closeDialog()
  })

  test('Rule Enabled off writes behavior none, and leaves Then inert', async () => {
    assert.ok(await editor.openEdit('Folded'), 'the Edit-rule dialog should open')
    const toggle = await enabledSwitch()
    assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'true')
    await options.press(toggle)
    await page.waitForFunction(el => el.getAttribute('aria-checked') !== 'true', {}, toggle)
    assert.equal(await (await enabledSwitch()).evaluate(el => el.getAttribute('aria-checked')), 'false')
    const collapse = await editor.choice('action', 'collapse')
    assert.ok(await checked(collapse), 'Then shows the rule\'s choice')
    assert.ok(await disabled(collapse), 'Then is inert')
    await editor.save()
    assert.deepEqual(await editor.written('Folded'), { target: 'F', value: 'Folded', matcher: 'exact', behavior: 'none' })
  })

  test('in Regex mode the tester gives a verdict as either field changes, and nothing is written or fetched', async () => {
    const ruleWrites = () => page.evaluate(() => window.__writes.filter(w => 'option.rules' in w).length)
    const before = await ruleWrites()
    assert.ok(await editor.openAdd(), 'the Add-rule dialog should open')
    /** What the page asked the network for: not the icons, which are images inlined as `data:` URLs. */
    const requests = []
    const onRequest = (request) => {
      if (!request.url().startsWith('data:'))
        requests.push(request.url())
    }
    page.on('request', onRequest)
    try {
      /**
       * The verdict, once it is this one: whether its words, as a screen
       * reader reads them, carry `label`, and whether they read at AA.
       */
      const verdict = async (kind, label) => {
        const handle = await page.waitForSelector(`[role="dialog"] [data-regex-verdict="${kind}"]`)
        return { says: mentions(await options.text(handle), label), aa: await options.contrast(handle) >= 4.5 }
      }
      const said = { says: true, aa: true }

      assert.equal(await page.$('[role="dialog"] [data-regex-verdict]'), null, 'no tester in Exact mode')
      await editor.pick('matcher', 'regex')
      assert.deepEqual(await verdict('none', NO_PATTERN), said)
      await (await editor.field('value')).type('^slow.*burn$')
      assert.deepEqual(await verdict('none', NO_PATTERN), { says: false, aa: true }, 'with a pattern, it asks for a tag to test')

      const subject = await editor.field('test')
      assert.ok(mentions(await options.description(subject), TESTER_HELP))
      await subject.type('Slow Burn')
      assert.deepEqual(await verdict('match', VERDICT_LABELS.match), said, 'the pattern is tested ignoring case')
      await editor.retype('test', 'Slow Burning')
      assert.deepEqual(await verdict('miss', VERDICT_LABELS.miss), said)

      await editor.retype('value', '^slow.*(burn')
      assert.deepEqual(await verdict('invalid', VERDICT_LABELS.invalid), said)
      assert.ok(mentions(await options.description(subject), compilePattern('^slow.*(burn')), 'the engine\'s reason')
      await editor.retype('value', '^slow')
      assert.deepEqual(await verdict('match', VERDICT_LABELS.match), said)

      await options.suggestionsAsked(archive)
      await options.closeDialog()
    }
    finally {
      page.off('request', onRequest)
    }
    await options.saved()
    assert.equal(await ruleWrites(), before, 'no rule is written')
    assert.deepEqual(requests, [], 'nothing is fetched')
  })

  test('a disabled rule opens with Rule Enabled off and Then inert', async () => {
    assert.ok(await editor.openEdit('Set aside'), 'the Edit-rule dialog should open')
    assert.equal(await (await enabledSwitch()).evaluate(el => el.getAttribute('aria-checked')), 'false')
    const then = await editor.choices('action')
    assert.equal(then.length, 5)
    for (const action of then)
      assert.ok(await disabled(action), await action.evaluate(el => el.value))
    assert.ok(await checked(await editor.choice('action', 'hide')))
    const toggle = await enabledSwitch()
    await options.press(toggle)
    await page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', {}, toggle)
    assert.equal(await disabled(await editor.choice('action', 'collapse')), false, 'switched on, Then is live again')
    await options.closeDialog()
  })

  test('dialogs declare an accessible description (no reka warning)', () => {
    const a11y = options.messages.filter(m => /aria-describedby|Description` or|DialogContent/i.test(m.text))
    assert.equal(a11y.length, 0, `unexpected DialogContent a11y warnings: ${JSON.stringify(a11y)}`)
  })
})
