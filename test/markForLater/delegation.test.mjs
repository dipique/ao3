import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { loadModuleInPage, skipWithoutChrome } from '../siteExport/helpers.mjs'

/**
 * The two halves of a delegated Marked for Later request, driven against each
 * other.
 *
 * A POST from an extension page reaches AO3 with no `Origin` and no `Referer`,
 * which the archive was measured to accept and is under no obligation to go on
 * accepting. If it stops, the request has to be made from a page that is
 * genuinely on AO3 — so one side asks an open tab and the other side answers
 * from inside it, and neither is worth much without the other.
 *
 * Both live in one module for that reason, and this bundles that module into a
 * page with the sender and the receiver in it at once: `tabs.sendMessage` is
 * wired straight into `runtime.onMessage`, the way the browser would wire them
 * across a tab boundary. What is stubbed under both is `fetch` — the archive —
 * and nothing else.
 *
 * The ingest that decides *when* to fall back to this is tested next door, in
 * {@link file://./../siteExport/importChanges.test.mjs}.
 */

const skip = skipWithoutChrome

/**
 * Enough `browser` for `#common` to import, plus a `tabs.sendMessage` that
 * delivers to the page's own `runtime.onMessage` listeners.
 *
 * Chrome's contract is the fiddly part and it is what the sender copes with: a
 * listener returns `true` to keep the channel open and answers later through
 * `sendResponse`, and messaging a tab with nothing listening rejects rather than
 * resolving. Both are reproduced here, because both are branches in the sender.
 */
function installBrowser() {
  const state = { fetches: [], archive: 'ok', tabs: [1], listening: true }
  window.__delegation = state

  window.fetch = async (url, init = {}) => {
    const href = String(url)
    state.fetches.push({ url: href, body: String(init.body ?? '') })
    if (href.includes('token_dispenser'))
      return new Response('{"token":"a-fetched-token"}', { status: 200, headers: { 'content-type': 'application/json' } })
    if (state.archive === 'network')
      throw new TypeError('Failed to fetch')
    return new Response('', { status: state.archive === 'ok' ? 200 : state.archive })
  }

  const messageListeners = new Set()
  const onMessage = {
    addListener: l => messageListeners.add(l),
    removeListener: l => messageListeners.delete(l),
    hasListener: l => messageListeners.has(l),
  }
  const event = { addListener() {}, removeListener() {}, hasListener: () => false }
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} }

  const tabs = {
    query: async () => state.tabs.map(id => ({ id, discarded: false })),
    sendMessage: (tabId, message) => new Promise((resolve, reject) => {
      if (!state.listening || !messageListeners.size)
        return reject(new Error('Could not establish connection. Receiving end does not exist.'))
      for (const listener of messageListeners)
        listener(message, { tab: { id: tabId } }, resolve)
    }),
  }

  globalThis.browser = globalThis.chrome = {
    runtime: {
      id: 'test',
      getManifest: () => ({ short_name: 'AO3E', version: '0.0.0' }),
      getURL: path => path,
      onMessage,
      sendMessage: async () => undefined,
    },
    storage: { onChanged: event, local: area, sync: area, session: area, managed: area },
    tabs,
  }
}

describe('markForLater — delegation', { skip }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage(
      'src/content_script/markForLater.ts',
      'MarkForLater',
      { prepare: blank => blank.evaluate(installBrowser) },
    ))
    // The receiving half, as the content script installs it on every AO3 page.
    await page.evaluate(() => window.MarkForLater.serveMarkRequests())
  }, { timeout: 120000 })

  after(async () => close?.())

  const reset = ({ archive = 'ok', tabs = [1], listening = true, token = null } = {}) => page.evaluate(
    (outcome, openTabs, hasListeners, headToken) => {
      window.__delegation.fetches.length = 0
      window.__delegation.archive = outcome
      window.__delegation.tabs = openTabs
      window.__delegation.listening = hasListeners
      document.head.querySelector('meta[name="csrf-token"]')?.remove()
      if (headToken) {
        const meta = document.createElement('meta')
        meta.name = 'csrf-token'
        meta.content = headToken
        document.head.append(meta)
      }
    },
    archive,
    tabs,
    listening,
    token,
  )

  const viaTab = (workId, save) => page.evaluate(
    (id, on) => window.MarkForLater.submitMarkViaTab(id, on).then(() => null, error => error.message),
    workId,
    save,
  )
  const fetches = () => page.evaluate(() => window.__delegation.fetches)

  test('the tab makes the request, and says it worked', async () => {
    await reset()
    assert.equal(await viaTab('11', false), null)

    const requests = await fetches()
    assert.equal(requests.length, 2, 'a token, then the request itself')
    assert.match(requests[1].url, /\/works\/11\/mark_as_read$/)
    assert.match(requests[1].body, /_method=patch/)
  })

  test('saving and finishing are the same request to different paths', async () => {
    await reset()
    assert.equal(await viaTab('12', true), null)
    assert.match((await fetches()).at(-1).url, /\/works\/12\/mark_for_later$/)
  })

  /**
   * The whole point of asking a page that is on AO3: it has the archive's own
   * token in its head, so there is nothing to go and fetch.
   */
  test('a page with a token in its head does not go and ask for one', async () => {
    await reset({ token: 'the-page-token' })
    assert.equal(await viaTab('11', false), null)

    const requests = await fetches()
    assert.equal(requests.length, 1)
    assert.match(requests[0].body, /authenticity_token=the-page-token/)
  })

  test('a refusal comes back as what the archive said, not as a lost connection', async () => {
    await reset({ archive: 422 })
    assert.equal(await viaTab('11', false), 'Mark request failed (422)')
  })

  test('with no AO3 tab open, the message says what to do about it', async () => {
    await reset({ tabs: [] })
    assert.match(await viaTab('11', false), /open AO3 in a tab and import this file again/)
  })

  /**
   * A tab that is on AO3 but has no content script under it — loaded before the
   * extension, or orphaned by a reload. It is a different case from having no
   * tab at all, and the reader is told a different thing to do.
   */
  test('a tab that never answers is reported as a tab to reload', async () => {
    await reset({ listening: false })
    assert.match(await viaTab('11', false), /reload one/)
    assert.deepEqual(await fetches(), [], 'nothing reached the archive')
  })
})
