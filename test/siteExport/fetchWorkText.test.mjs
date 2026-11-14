import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { COMMENTS_CLASS, WORK_TEXT_INDEX_KEY, WORK_TEXT_PREFIX } from '../../src/content_script/siteExport/workText.ts'
import { installMock } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from './helpers.mjs'
import { comment, PAGE, withComments } from './workPages.mjs'

/**
 * Caching one work, with and without its comments, against a stand-in AO3.
 *
 * The fetch, the sanitizer and the store run as they do in a caching job; only
 * `fetch` answers from a table of pages, and the pacing waits on a clock that
 * moves when it is asked to sleep, so a refusal costs no real time.
 */

const skip = skipWithoutChrome

const WORK = '42'
const FACTS = { workId: WORK, dateUpdated: 1_770_000_000, chapters: 2, words: 666 }

describe('cacheWorkText', { skip }, () => {
  let page
  let close
  /** The work page's address, as the fetch asks for it. */
  let url

  before(async () => {
    ({ page, close } = await loadModuleInPage('test/siteExport/fetchWorkTextEntry.ts', 'Fetch', {
      prepare: async (blank) => {
        await blank.evaluate(installMock, {})
        await blank.evaluate(() => {
          window.__pages = {}
          window.__asked = []
          window.fetch = async (input) => {
            const asked = String(input)
            window.__asked.push(asked)
            const answer = window.__pages[asked] ?? { status: 404, body: 'Not found' }
            return new Response(answer.body, { status: answer.status, headers: answer.headers })
          }
        })
      },
    }))
    await page.evaluate(() => {
      let now = Date.UTC(2026, 10, 13)
      window.Fetch.useArchiveClock({
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      })
    })
    url = query => page.evaluate((id, q) => window.Fetch.workPageUrl(id, q), WORK, query)
  }, { timeout: 120000 })

  after(async () => close?.())

  beforeEach(async () => {
    await page.evaluate(async () => {
      await window.browser.storage.local.clear()
      window.__pages = {}
      window.__asked.length = 0
    })
  })

  /** Have the stand-in answer `query`'s address with `body`, or with `status` and nothing worth reading. */
  const serve = async (query, body, status = 200, headers = {}) => {
    const address = await url(query)
    await page.evaluate((a, answer) => {
      window.__pages[a] = answer
    }, address, { status, body, headers })
  }

  const cache = (opts = {}) => page.evaluate((facts, o) => window.Fetch.cacheWorkText(facts, undefined, o), FACTS, opts)
  const asked = () => page.evaluate(() => [...window.__asked])
  const stored = () => page.evaluate(async (key, indexKey, id) => {
    const got = await window.browser.storage.local.get([key, indexKey])
    return { html: got[key]?.html ?? null, meta: got[indexKey]?.[id] ?? null }
  }, `${WORK_TEXT_PREFIX}${WORK}`, WORK_TEXT_INDEX_KEY, WORK)

  test('asks for the work alone, and keeps no comments, unless comments are wanted', async () => {
    await serve({}, withComments(comment(1, 'Loved it.')))
    const result = await cache()
    assert.equal(result.failure, null)
    assert.deepEqual(await asked(), [await url({})])
    assert.ok(!(await url({})).includes('show_comments'))
    const { html, meta } = await stored()
    assert.ok(!html.includes(COMMENTS_CLASS))
    assert.equal(meta.comments, undefined)
  })

  test('with comments wanted, one request brings the work and a page of comments', async () => {
    await serve({ comments: true }, withComments(comment(1, 'Loved it.')))
    const result = await cache({ comments: true })
    assert.equal(result.failure, null)
    assert.deepEqual(await asked(), [await url({ comments: true })])
    assert.match(await url({ comments: true }), /show_comments=true/)
    const { html, meta } = await stored()
    assert.ok(html.includes(COMMENTS_CLASS))
    assert.ok(html.includes('Loved it.'))
    assert.equal(meta.comments, true)
  })

  test('every further page of comments is fetched, and kept in order', async () => {
    for (const n of [1, 2, 3])
      await serve({ comments: true, page: n }, withComments(comment(n, `Comment on page ${n}.`), { current: n, pages: 3 }))
    // The first page is asked for without a page number, as AO3's own links do.
    await serve({ comments: true }, withComments(comment(1, 'Comment on page 1.'), { current: 1, pages: 3 }))
    await cache({ comments: true })
    assert.deepEqual(await asked(), [await url({ comments: true }), await url({ comments: true, page: 2 }), await url({ comments: true, page: 3 })])
    const { html, meta } = await stored()
    const at = n => html.indexOf(`Comment on page ${n}.`)
    assert.ok(at(1) > 0 && at(1) < at(2) && at(2) < at(3), 'the pages follow each other')
    assert.equal(meta.comments, true)
  })

  test('a page of comments that fails keeps the work and the comments before it, to be tried again', async () => {
    await serve({ comments: true }, withComments(comment(1, 'First page.'), { current: 1, pages: 3 }))
    await serve({ comments: true, page: 2 }, 'Server error', 500)
    const result = await cache({ comments: true })
    assert.equal(result.failure, null)
    assert.equal(result.rateLimited, undefined)
    assert.equal((await asked()).length, 2, 'nothing more is asked once a page fails')
    const { html, meta } = await stored()
    assert.ok(html.includes('First page.'))
    assert.ok(html.includes('First chapter.'))
    assert.equal(meta.comments, undefined, 'the copy is not marked as holding every comment')
  })

  test('a work with no comments is still a copy with its comments', async () => {
    await serve({ comments: true }, PAGE)
    await cache({ comments: true })
    const { html, meta } = await stored()
    assert.ok(!html.includes(COMMENTS_CLASS))
    assert.equal(meta.comments, true)
  })

  test('AO3 still asking us to wait on a page of comments stores nothing, and says so', async () => {
    await serve({ comments: true }, withComments(comment(1, 'First page.'), { current: 1, pages: 2 }))
    await serve({ comments: true, page: 2 }, 'slow down', 429, { 'Retry-After': String(24 * 60 * 60) })
    const result = await cache({ comments: true })
    assert.equal(result.rateLimited, true)
    assert.equal(result.failure, null)
    assert.equal((await asked()).at(-1), await url({ comments: true, page: 2 }))
    assert.deepEqual(await stored(), { html: null, meta: null })
  })
})
