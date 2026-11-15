import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { archiveFetch, archiveRequestInit, setImpersonateUserRequests, USER_REQUEST_HEADERS } from '../../src/common/archiveRequest.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { LOCAL_ONLY } from '../../src/common/syncCodec.ts'
import { fetchWithRetry } from '../../src/content_script/archiveFetch.ts'

const url = 'https://archiveofourown.org/works/11'

/** The headers `init` would send, as plain lowercase pairs. */
function sent(init) {
  return Object.fromEntries(new Headers(init.headers))
}

/** What a page load sends that a script's request does not, lowercased as `Headers` reads it back. */
const USER = { 'upgrade-insecure-requests': '1' }

/** A `fetch` that answers 200 to everything, recording the init of each call. */
function stubFetch(t) {
  const inits = []
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    inits.push(init ?? {})
    return new Response('', { status: 200 })
  })
  return inits
}

afterEach(() => setImpersonateUserRequests(false))

describe('impersonating user requests', () => {
  test('is off on a fresh install, and stays on the device that turned it on', () => {
    assert.equal(OPTION_DEFAULTS.impersonateUserRequests, false)
    assert.ok(LOCAL_ONLY.has('impersonateUserRequests'))
  })

  test('a page load is told apart by Upgrade-Insecure-Requests', () => {
    assert.deepEqual(Object.fromEntries(new Headers(USER_REQUEST_HEADERS)), USER)
  })

  test('off, a request goes out as it was asked', () => {
    const init = { credentials: 'same-origin', headers: { Accept: 'text/html' } }
    assert.equal(archiveRequestInit(init), init)
    assert.deepEqual(archiveRequestInit(), {})
  })

  test('on, a request carries what a page load sends, and keeps everything else it asked for', () => {
    setImpersonateUserRequests(true)
    const signal = new AbortController().signal
    const init = { method: 'POST', credentials: 'same-origin', body: 'a=1', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }

    const out = archiveRequestInit(init)

    assert.equal(out.method, 'POST')
    assert.equal(out.credentials, 'same-origin')
    assert.equal(out.body, 'a=1')
    assert.equal(out.signal, signal)
    assert.deepEqual(sent(out), { 'content-type': 'application/x-www-form-urlencoded', ...USER })
    // The caller's own object is left as it was.
    assert.deepEqual(init.headers, { 'Content-Type': 'application/x-www-form-urlencoded' })
  })

  test('on, headers given as a Headers object or as pairs are kept too', () => {
    setImpersonateUserRequests(true)
    assert.deepEqual(sent(archiveRequestInit({ headers: new Headers({ Accept: 'text/html' }) })), { accept: 'text/html', ...USER })
    assert.deepEqual(sent(archiveRequestInit({ headers: [['Accept', 'text/html']] })), { accept: 'text/html', ...USER })
    assert.deepEqual(sent(archiveRequestInit()), USER)
  })

  test('turned off again, requests go out as asked', () => {
    setImpersonateUserRequests(true)
    setImpersonateUserRequests(false)
    assert.deepEqual(sent(archiveRequestInit({ headers: { Accept: 'text/html' } })), { accept: 'text/html' })
  })

  test('archiveFetch asks for the same URL, with the headers only while on', async (t) => {
    const inits = stubFetch(t)

    await archiveFetch(url, { credentials: 'same-origin' })
    setImpersonateUserRequests(true)
    await archiveFetch(url, { credentials: 'same-origin' })

    assert.deepEqual(inits.map(sent), [{}, USER])
    assert.deepEqual(inits.map(init => init.credentials), ['same-origin', 'same-origin'])
  })

  test('fetchWithRetry, which every paced request goes through, carries the headers only while on', async (t) => {
    const inits = stubFetch(t)

    await fetchWithRetry(url)
    setImpersonateUserRequests(true)
    await fetchWithRetry(url)

    assert.deepEqual(inits.map(sent), [{}, USER])
    assert.deepEqual(inits.map(init => init.credentials), ['same-origin', 'same-origin'])
  })
})
