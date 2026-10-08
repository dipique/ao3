import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { skip, startOptions, stubArchive } from './optionsPage.mjs'

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
  }, { timeout: 180000 })

  after(() => session?.close())

  // --- helpers bound to the live page ---
  const dialog = async () => {
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 })
    return page.$('[role="dialog"]')
  }
  /** Whether the open dialog is the rule editor: it is the one with the matcher toggles. */
  const ruleDialogOpen = () => page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    return !!(d && d.querySelector('[i-codicon-regex]') && d.querySelector('[i-codicon-whole-word]'))
  })
  const openAddRuleDialog = async () => {
    await options.openDialog(await options.control(await options.list('rules'), 'button', 'Add a rule'))
    return ruleDialogOpen()
  }
  const openEditRuleDialog = async (value) => {
    await options.openDialog(await options.control(await options.list('rules'), 'button', `Edit rule “${value}”`))
    return ruleDialogOpen()
  }
  /** One of a radio group's choices, the group by its name, such as “What the rule does”. */
  const choice = async (group, name) => options.control(await options.control(await dialog(), 'radiogroup', group), 'radio', name)
  /** Choose it, and wait until it is the one chosen. */
  const pick = async (group, name) => {
    const chosen = await choice(group, name)
    await options.press(chosen)
    await page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', {}, chosen)
  }
  const checked = handle => handle.evaluate(el => el.getAttribute('aria-checked') === 'true')
  const disabled = handle => handle.evaluate(el => el.disabled)
  /** The value field: a combobox while it offers suggestions, a plain text field otherwise. */
  const valueField = async () => {
    const [combobox] = await options.controls(await dialog(), 'combobox')
    return combobox ?? options.control(await dialog(), 'textbox')
  }
  const typeValue = async (text) => {
    await (await valueField()).type(text)
  }
  const enabledSwitch = async () => options.control(await dialog(), 'switch', 'Rule Enabled')
  /** Add rule, or Save when editing; the dialog closes and the rules are written. */
  const saveDialog = async (name) => {
    await options.press(await options.control(await dialog(), 'button', name))
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await options.saved()
  }
  const storedRule = async value => (await options.lastWrite('option.rules'))?.filters?.find(f => f.value === value)

  test('matcher icons render (codicon collection loaded)', async () => {
    assert.ok(await openAddRuleDialog(), 'the Add-rule dialog should open')
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
    assert.ok(await openAddRuleDialog(), 'the Add-rule dialog should open')
    await typeValue('e2e-regex')
    await pick('How to match', 'Regex')
    await saveDialog('Add rule')
    const stored = await options.lastWrite('option.rules')
    assert.ok(
      stored?.filters?.some(f => f.value === 'e2e-regex' && f.matcher === 'regex' && f.target === 'tag'),
      `expected a persisted {target:'tag', value:'e2e-regex', matcher:'regex'} rule, got ${JSON.stringify(stored)}`,
    )
  })

  test('editing a rule to the Contains matcher persists', async () => {
    assert.ok(await openEditRuleDialog('e2e-regex'), 'the Edit-rule dialog should open')
    await pick('How to match', 'Contains')
    await saveDialog('Save')
    const stored = await options.lastWrite('option.rules')
    assert.ok(
      stored?.filters?.some(f => f.value === 'e2e-regex' && f.matcher === 'contains'),
      `expected the rule's matcher updated to 'contains', got ${JSON.stringify(stored)}`,
    )
  })

  test('the Amber swatch writes #f59e0b', async () => {
    assert.ok(await openAddRuleDialog(), 'the Add-rule dialog should open')
    await typeValue('amber')
    await pick('What the rule does', 'Highlight')
    await pick('Highlight colour', 'Amber')
    await saveDialog('Add rule')
    assert.deepEqual(await storedRule('amber'), { target: 'tag', value: 'amber', matcher: 'exact', behavior: 'highlight', color: '#f59e0b' })
  })

  test('the Default swatch writes no colour of the rule\'s own', async () => {
    assert.ok(await openEditRuleDialog('amber'), 'the Edit-rule dialog should open')
    assert.ok(await checked(await choice('Highlight colour', 'Amber')), 'the rule opens on its preset')
    await pick('Highlight colour', 'Default')
    await saveDialog('Save')
    assert.deepEqual(await storedRule('amber'), { target: 'tag', value: 'amber', matcher: 'exact', behavior: 'highlight' })
  })

  test('Your default highlight colours opens their dialog over the editor, and Escape goes back to the editor', async () => {
    assert.ok(await openEditRuleDialog('amber'), 'the Edit-rule dialog should open')
    await options.openDialog(await options.control(await dialog(), 'button', 'Your default highlight colours'))
    const titles = () => page.$$eval('[role="dialog"]', dialogs => dialogs.map(d => d.querySelector('h1, h2')?.textContent.trim()))
    assert.deepEqual(await titles(), ['Edit rule', 'Default highlight colors'])
    await options.closeDialog()
    assert.deepEqual(await titles(), ['Edit rule'])
    await options.closeDialog()
  })

  test('a rule with a colour of its own opens on Custom, with the picker on that colour', async () => {
    assert.ok(await openEditRuleDialog('Painted'), 'the Edit-rule dialog should open')
    for (const swatch of ['Default', 'Sky', 'Amber', 'Violet'])
      assert.equal(await checked(await choice('Highlight colour', swatch)), false, swatch)
    assert.ok(await checked(await choice('Highlight colour', 'Custom')))
    const fields = await options.controls(await dialog(), 'textbox')
    const values = await Promise.all(fields.map(field => field.evaluate(el => el.value)))
    assert.ok(values.includes('#123456'), `the picker shows the colour, got ${JSON.stringify(values)}`)
    await options.closeDialog()
  })

  test('Rule Enabled off writes behavior none, and leaves Then inert', async () => {
    assert.ok(await openEditRuleDialog('Folded'), 'the Edit-rule dialog should open')
    const toggle = await enabledSwitch()
    assert.equal(await toggle.evaluate(el => el.getAttribute('aria-checked')), 'true')
    await options.press(toggle)
    await page.waitForFunction(el => el.getAttribute('aria-checked') !== 'true', {}, toggle)
    assert.equal(await (await enabledSwitch()).evaluate(el => el.getAttribute('aria-checked')), 'false')
    const collapse = await choice('What the rule does', 'Collapse')
    assert.ok(await checked(collapse), 'Then shows the rule\'s choice')
    assert.ok(await disabled(collapse), 'Then is inert')
    await saveDialog('Save')
    assert.deepEqual(await storedRule('Folded'), { target: 'F', value: 'Folded', matcher: 'exact', behavior: 'none' })
  })

  test('in Regex mode the tester gives a verdict as either field changes, and nothing is written or fetched', async () => {
    const ruleWrites = () => page.evaluate(() => window.__writes.filter(w => 'option.rules' in w).length)
    const before = await ruleWrites()
    assert.ok(await openAddRuleDialog(), 'the Add-rule dialog should open')
    /** What the page asked the network for: not the icons, which are images inlined as `data:` URLs. */
    const requests = []
    const onRequest = (request) => {
      if (!request.url().startsWith('data:'))
        requests.push(request.url())
    }
    page.on('request', onRequest)
    try {
      /** The verdict, once it is this one: its words, as a screen reader reads them, and how well they read. */
      const verdict = async (kind) => {
        const handle = await page.waitForSelector(`[role="dialog"] [data-regex-verdict="${kind}"]`)
        return { text: await options.text(handle), aa: await options.contrast(handle) >= 4.5 }
      }
      const replace = async (field, text) => {
        await field.evaluate(el => el.select())
        await field.type(text)
      }

      assert.equal(await page.$('[role="dialog"] [data-regex-verdict]'), null, 'no tester in Exact mode')
      await pick('How to match', 'Regex')
      assert.deepEqual(await verdict('none'), { text: 'No pattern yet', aa: true })
      await typeValue('^slow.*burn$')
      assert.deepEqual(await verdict('none'), { text: 'Type a tag', aa: true })

      const subject = await options.control(await dialog(), 'textbox', 'Test it')
      assert.equal(await options.description(subject), 'Checks the pattern as you type. Nothing is saved from here.')
      await subject.type('Slow Burn')
      assert.deepEqual(await verdict('match'), { text: 'Matches', aa: true }, 'the pattern is tested ignoring case')
      await replace(subject, 'Slow Burning')
      assert.deepEqual(await verdict('miss'), { text: 'No match', aa: true })

      const value = await valueField()
      await replace(value, '^slow.*(burn')
      assert.deepEqual(await verdict('invalid'), { text: 'Error: Invalid pattern', aa: true })
      assert.equal(await options.description(subject), 'Unterminated group', 'the engine\'s reason')
      await replace(value, '^slow')
      assert.deepEqual(await verdict('match'), { text: 'Matches', aa: true })

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
    assert.ok(await openEditRuleDialog('Set aside'), 'the Edit-rule dialog should open')
    assert.equal(await (await enabledSwitch()).evaluate(el => el.getAttribute('aria-checked')), 'false')
    const then = await options.controls(await options.control(await dialog(), 'radiogroup', 'What the rule does'), 'radio')
    assert.equal(then.length, 5)
    for (const action of then)
      assert.ok(await disabled(action), await options.name(action))
    assert.ok(await checked(await choice('What the rule does', 'Hide Work')))
    const toggle = await enabledSwitch()
    await options.press(toggle)
    await page.waitForFunction(el => el.getAttribute('aria-checked') === 'true', {}, toggle)
    assert.equal(await disabled(await choice('What the rule does', 'Collapse')), false, 'switched on, Then is live again')
    await options.closeDialog()
  })

  test('dialogs declare an accessible description (no reka warning)', () => {
    const a11y = options.messages.filter(m => /aria-describedby|Description` or|DialogContent/i.test(m.text))
    assert.equal(a11y.length, 0, `unexpected DialogContent a11y warnings: ${JSON.stringify(a11y)}`)
  })
})
