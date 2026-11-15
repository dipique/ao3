import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { TagType } from '../../src/common/data.ts'
import { archiveTab, liveTitles, openToRead, shownTitles, storedSeed, toReadPage } from './markedForLater.mjs'
import { ARCHIVE, skip, startOptions, stubArchive, until } from './optionsPage.mjs'
import { RuleEditor } from './ruleEditor.mjs'

/** The header a page load carries and a script's request does not, as puppeteer reports request headers. */
const USER_HEADER = 'upgrade-insecure-requests'

/**
 * Record, for each request a script on `page` makes of the archive, whether it
 * carried {@link USER_HEADER}. The browser's own requests (the page itself, its
 * favicon) and CORS preflights are left out.
 */
function watchHeaders(page) {
  const carried = []
  page.on('request', (request) => {
    if (request.url().startsWith(ARCHIVE) && request.resourceType() === 'fetch' && request.method() !== 'OPTIONS')
      carried.push(request.headers()[USER_HEADER] === '1')
  })
  return carried
}

/**
 * With *Impersonate user requests* on, every request the extension makes of
 * AO3 carries what the browser sends when the reader loads a page; off, none
 * does. Shown on a Marked for Later refresh in an AO3 tab, and on the options
 * page asking AO3's tag autocomplete.
 */
describe('Impersonate user requests', { skip }, () => {
  let session

  before(async () => {
    session = await startOptions()
  }, { timeout: 180000 })

  after(() => session?.close())

  /** The to-read page refreshing its stale stored copy, the option stored as `on`; whether each list page the refresh asked for carried the header. */
  async function refresh(on) {
    const tab = await archiveTab(session.browser, storedSeed(undefined, { 'option.impersonateUserRequests': on }), url => toReadPage(Number(url.searchParams.get('page') ?? 1)))
    const carried = watchHeaders(tab)
    try {
      await openToRead(tab)
      await until('the refreshed list to show', async () => JSON.stringify(await shownTitles(tab)) === JSON.stringify(liveTitles()))
      return carried
    }
    finally {
      await tab.close()
    }
  }

  test('on, a list refresh in an AO3 tab asks for every page as a page load would', async () => {
    const carried = await refresh(true)
    assert.ok(carried.length > 0, 'the refresh asked AO3 for nothing')
    assert.ok(carried.every(Boolean), `${carried.filter(c => !c).length} of ${carried.length} requests went without the header`)
  })

  test('off, the same refresh asks without it', async () => {
    const carried = await refresh(false)
    assert.ok(carried.length > 0, 'the refresh asked AO3 for nothing')
    assert.ok(!carried.some(Boolean), `${carried.filter(Boolean).length} of ${carried.length} requests carried the header`)
  })

  test('on, the options page asks AO3\'s tag autocomplete as a page load would', async () => {
    let carried
    let archive
    const options = await session.open({
      seed: {
        'option.impersonateUserRequests': true,
        'option.rules': { enabled: true, filters: [], colors: {} },
      },
      hash: '#customize-search-results',
      prepare: async (page) => {
        archive = await stubArchive(page, () => ({ json: [] }))
        carried = watchHeaders(page)
      },
    })
    try {
      const editor = new RuleEditor(options)
      await editor.openAdd()
      await editor.pick('target', TagType.Fandom)
      await (await editor.field('value')).type('pot')
      await until('the autocomplete to be asked', () => archive.asked.length > 0)
      await archive.answered()
      assert.deepEqual(carried, archive.asked.map(() => true))
    }
    finally {
      await options.close()
    }
  })
})
