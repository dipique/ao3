import assert from 'node:assert/strict'
import { after, afterEach, before, describe, test } from 'node:test'

import { skip, startOptions, stubArchive, until } from './optionsPage.mjs'

/**
 * Records, for every live region (`role="status"`) the page adds, the words it
 * held as it was added: a page script, for `openOptions`' `prepare`. A screen
 * reader may say nothing of a region added with its words already in it, so a
 * note that should be heard has to arrive in a region that was there first.
 */
function watchLiveRegions() {
  window.__liveRegions = new WeakMap()
  const note = (el) => {
    if (!window.__liveRegions.has(el))
      window.__liveRegions.set(el, el.textContent.trim())
  }
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE)
          continue
        if (node.matches('[role="status"]'))
          note(node)
        node.querySelectorAll('[role="status"]').forEach(note)
      }
    }
  }).observe(document, { childList: true, subtree: true })
}

/** Whether `words` are in a live region in the open dialog that was added empty, before them. */
function heardInDialog(words) {
  return [...document.querySelectorAll('[role="dialog"] [role="status"]')]
    .some(el => el.textContent.includes(words) && window.__liveRegions.get(el) === '')
}

/** Whether `words` show in the open dialog in anything other than a live region added empty. */
function shownInDialog(words) {
  return [...document.querySelectorAll('[role="dialog"] *')]
    .some(el => [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes(words)))
}

const REFUSED = { status: 429, headers: { 'retry-after': '60' }, body: 'slow down' }

/**
 * What the rule editor says of its own accord — suggestions paused, AO3's
 * answers unavailable — is said in a live region that was there before the
 * words came, so a screen reader hears it.
 */
describe('options UI — notes a screen reader hears', { skip }, () => {
  let session
  let options

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  afterEach(() => options?.close())

  const open = async (reply) => {
    options = await session.open({
      seed: { 'option.rules': { enabled: true, filters: [], colors: {} } },
      hash: '#customize-search-results-rules',
      prepare: async (page) => {
        await page.evaluateOnNewDocument(watchLiveRegions)
        await stubArchive(page, reply)
      },
    })
    await options.press(await options.control(await options.list('rules'), 'button', 'Add a rule'))
    return options.page.waitForSelector('[role="dialog"]')
  }

  const pick = async (dialog, group, name) => options.press(await options.control(await options.control(dialog, 'radiogroup', group), 'radio', name))

  test('suggestions paused by AO3', async () => {
    const dialog = await open(() => REFUSED)
    await pick(dialog, 'What the rule matches', 'Character')
    await (await options.control(dialog, 'combobox')).type('harry')
    const words = 'AO3 asked us to slow down'
    await until('the note to show', () => options.page.evaluate(shownInDialog, words))
    assert.ok(await options.page.evaluate(heardInDialog, words), 'said in a live region that was there first')
  })

  test('canonical tags without AO3\'s answers', async () => {
    const dialog = await open(() => REFUSED)
    await pick(dialog, 'What the rule matches', 'Character')
    await pick(dialog, 'How to match', 'Regex')
    const pattern = await options.control(dialog, 'textbox')
    await pattern.type('^Original')
    await options.press(await options.control(dialog, 'button', 'Show matching canonical tags'))
    const words = 'AO3 asked us to slow down'
    await until('the note to show', () => options.page.evaluate(shownInDialog, words))
    assert.ok(await options.page.evaluate(heardInDialog, words), 'said in a live region that was there first')
  })
})
