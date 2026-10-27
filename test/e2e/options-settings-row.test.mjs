import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { mentions, skip, startOptions, until } from './optionsPage.mjs'

const WIDE = { width: 1280, height: 800 }
const SEARCH = '[data-settings-search]'

const MASTER = 'link-menus-right-click-menus'
const MASTER_KEY = 'option.contextMenusEnabled'
/** The rows the master switch gates, by anchor id, and the option each one edits. */
const DEPENDENTS = {
  'link-menus-open-menus-with-a-left-click': 'option.openMenuOnClick',
  'link-menus-menu-on-tags': 'option.tagToolbar',
  'link-menus-menu-on-fandoms': 'option.fandomToolbar',
  'link-menus-hide-or-highlight-an-author': 'option.hideAuthorToolbar',
  'link-menus-subscribe-to-an-author': 'option.subscribeAuthorToolbar',
  'link-menus-mute-an-author': 'option.muteAuthorToolbar',
}
/** Not gated: with menus off it still drives the capture buttons and the entity toolbars. */
const MARK_FOR_LATER = 'link-menus-mark-a-work-for-later'

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
        await options.press(await switchOf(options, 'link-menus-menu-on-tags'))
        await options.saved()
        assert.equal(await checked(options, 'link-menus-menu-on-tags'), true)
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
        const id = 'link-menus-hide-or-highlight-an-author'
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
        assert.equal(await disabled(options, 'link-menus-hide-or-highlight-an-author'), true)
      }
      finally {
        await options.close()
      }
    })
  })

  describe('badges', () => {
    const BADGES = {
      'link-menus-open-menus-with-a-left-click': ['every-click'],
      'link-menus-subscribe-to-an-author': ['needs-login'],
      'link-menus-mute-an-author': ['needs-login'],
      'link-menus-mark-a-work-for-later': ['needs-login'],
      'page-controls-collapsible-dashboard-sidebar': ['this-device'],
      'work-text-reader-mode': ['this-device'],
      'link-menus-menu-on-tags': [],
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
