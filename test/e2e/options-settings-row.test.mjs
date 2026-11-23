import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { mentions, skip, startOptions, until } from './optionsPage.mjs'

const WIDE = { width: 1280, height: 800 }
const SEARCH = '[data-settings-search]'

const MASTER = 'context-menus'
const MASTER_KEY = 'option.contextMenusEnabled'
/** The rows the master switch gates, by anchor id, and the option each one edits. */
const DEPENDENTS = {
  'open-menu-on-click': 'option.openMenuOnClick',
  'tag-toolbar': 'option.tagToolbar',
  'fandom-toolbar': 'option.fandomToolbar',
  'hide-author-toolbar': 'option.hideAuthorToolbar',
  'subscribe-author-toolbar': 'option.subscribeAuthorToolbar',
  'mute-author-toolbar': 'option.muteAuthorToolbar',
}
/** Not gated: with menus off it still drives the capture buttons and the entity toolbars. */
const MARK_FOR_LATER = 'mark-for-later-toolbar'

/** A mix of on and off, so a value lost or flipped on the way through shows. */
const SEEDED = {
  'option.openMenuOnClick': true,
  'option.tagToolbar': true,
  'option.fandomToolbar': false,
  'option.hideAuthorToolbar': true,
  'option.subscribeAuthorToolbar': false,
  'option.muteAuthorToolbar': true,
  'option.markForLaterToolbar': true,
}

/**
 * The settings row's parts that carry meaning rather than layout: a master
 * switch and the rows it gates, and the badges that stand in for a phrase in a
 * description. The layout itself is checked in `visual/options-layout`.
 */
describe('options UI — the settings row', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  const switchOf = async (options, id) => options.control(await options.row(id), 'switch')
  const checked = async (options, id) => (await switchOf(options, id)).evaluate(el => el.getAttribute('aria-checked') === 'true')
  const disabled = async (options, id) => (await switchOf(options, id)).evaluate(el => el.disabled)
  const descriptionShown = async (options, id) => (await options.row(id)).$eval('[data-row-part="description"]', el => el.checkVisibility())
  /** A row's part, `title` or `description`, as it reads. */
  const partOf = async (options, id, part) => (await options.row(id)).$eval(`[data-row-part="${part}"]`, el => el.textContent.replace(/\s+/g, ' ').trim())

  /**
   * Each gated row's state, by id: whether its switch is on, inert, whether it
   * says why, naming the master, and whether its description shows.
   */
  const dependents = async (options) => {
    const master = await partOf(options, MASTER, 'title')
    const state = {}
    for (const id of Object.keys(DEPENDENTS)) {
      const reason = await options.description(await switchOf(options, id))
      state[id] = {
        on: await checked(options, id),
        inert: await disabled(options, id),
        reason: reason === '' ? null : mentions(reason, master),
        description: await descriptionShown(options, id),
      }
    }
    return state
  }

  const expected = ({ inert, description }) => Object.fromEntries(Object.entries(DEPENDENTS).map(([id, key]) => [id, {
    on: SEEDED[key],
    inert,
    reason: inert ? true : null,
    description,
  }]))

  const noDependentWrites = async (options) => {
    for (const key of Object.values(DEPENDENTS))
      assert.equal(await options.lastWrite(key), null, `${key} was written`)
  }

  describe('the master group', () => {
    test('with Right-click menus on, the six rows it gates are live and described', async () => {
      const options = await session.open({ hash: '#link-menus', viewport: WIDE, seed: SEEDED })
      try {
        assert.equal(await checked(options, MASTER), true)
        assert.deepEqual(await dependents(options), expected({ inert: false, description: true }))
      }
      finally {
        await options.close()
      }
    })

    test('switched off, the six are inert with the reason and keep their values; Mark a work for later is not one of them', async () => {
      const options = await session.open({ hash: '#link-menus', viewport: WIDE, seed: SEEDED })
      try {
        await options.press(await switchOf(options, MASTER))
        await options.saved()
        assert.equal(await options.stored(MASTER_KEY), false)

        assert.deepEqual(await dependents(options), expected({ inert: true, description: false }))
        assert.equal(await disabled(options, MARK_FOR_LATER), false)
        assert.equal(await options.description(await switchOf(options, MARK_FOR_LATER)), '')
        assert.equal(await descriptionShown(options, MARK_FOR_LATER), true)

        // An inert switch takes no press.
        await options.press(await switchOf(options, 'tag-toolbar'))
        await options.saved()
        assert.equal(await checked(options, 'tag-toolbar'), true)
        await noDependentWrites(options)

        await options.press(await switchOf(options, MASTER))
        await options.saved()
        assert.equal(await options.stored(MASTER_KEY), true)
        assert.deepEqual(await dependents(options), expected({ inert: false, description: true }))
        await noDependentWrites(options)
      }
      finally {
        await options.close()
      }
    })

    test('opened with Right-click menus off, the six are inert from the start', async () => {
      const options = await session.open({ hash: '#link-menus', viewport: WIDE, seed: { ...SEEDED, [MASTER_KEY]: false } })
      try {
        assert.equal(await checked(options, MASTER), false)
        assert.deepEqual(await dependents(options), expected({ inert: true, description: false }))
      }
      finally {
        await options.close()
      }
    })

    test('a settings search shows an inert row\'s description, where its hit is', async () => {
      const options = await session.open({ hash: '#link-menus', viewport: WIDE, seed: { ...SEEDED, [MASTER_KEY]: false } })
      try {
        const id = 'hide-author-toolbar'
        // A word of the row's description that its title doesn't have, so the hit is there.
        const title = (await partOf(options, id, 'title')).toLowerCase()
        const word = (await partOf(options, id, 'description')).split(/[^a-z]+/i).filter(w => w.length >= 4 && !title.includes(w.toLowerCase())).sort((a, b) => b.length - a.length)[0]
        assert.ok(word, 'the description has a word of its own')
        await (await options.page.$(SEARCH)).type(word)
        const row = await options.row(id)
        await until('the search to mark its hit', () => row.$('[data-row-part="description"] mark'))
        assert.equal(await row.evaluate(el => el.checkVisibility()), true)
        assert.equal(await descriptionShown(options, id), true)
        assert.equal((await row.$eval('[data-row-part="description"] mark', el => el.textContent)).toLowerCase(), word.toLowerCase())
        assert.equal(await disabled(options, 'hide-author-toolbar'), true)
      }
      finally {
        await options.close()
      }
    })
  })

  describe('Mark a work for later', () => {
    test('opens onto the title button\'s switch, which stores its own option', async () => {
      const options = await session.open({ hash: '#link-menus', viewport: WIDE, seed: SEEDED })
      try {
        const row = await options.row(MARK_FOR_LATER)
        const button = await options.action(row, 'mark-for-later-button')
        assert.equal(await button.evaluate(el => el.checkVisibility()), true)
        await options.press(button)
        await options.saved()
        assert.equal(await options.stored('option.markForLaterButton'), true)
        assert.equal(await options.stored('option.markForLaterToolbar'), true)
      }
      finally {
        await options.close()
      }
    })
  })

  describe('badges', () => {
    const BADGES = {
      'open-menu-on-click': ['every-click'],
      'subscribe-author-toolbar': ['needs-login'],
      'mute-author-toolbar': ['needs-login'],
      'mark-for-later-toolbar': ['needs-login'],
      'collapsible-dashboard': ['this-device'],
      'reader-mode': ['this-device'],
      'tag-toolbar': [],
    }

    test('sit beside the title, each with a tooltip', async () => {
      const options = await session.open({ hash: '#link-menus', viewport: WIDE })
      try {
        for (const [id, badges] of Object.entries(BADGES)) {
          const row = await options.row(id)
          const drawn = await row.$$eval('[data-row-part="title"] [data-badge]', els => els.map(el => ({ badge: el.dataset.badge, said: !!el.textContent.trim() && !!el.title })))
          assert.deepEqual(drawn, badges.map(badge => ({ badge, said: true })), id)
        }
      }
      finally {
        await options.close()
      }
    })
  })
})
