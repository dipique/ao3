import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { COMMENT_LOAD_RETRIES } from '../../src/common/constants.ts'
import { captureStep, pageFreshness } from '../../src/content_script/siteExport/pageCapture.ts'

/** A one-chapter work with no comments, wholly on its page. */
function page(over = {}) {
  return { written: 1, shown: 1, comments: 0, commentsShown: 0, commentsAsked: false, ...over }
}

const WITHOUT = { comments: false, attempt: 0 }
const WITH = { comments: true, attempt: 0 }

describe('captureStep', () => {
  test('a one-chapter work is on its page whole', () => {
    assert.equal(captureStep(page(), WITHOUT), 'capture')
  })

  test('a multi-chapter work only when every chapter is shown, as the entire work shows them', () => {
    assert.equal(captureStep(page({ written: 3, shown: 3 }), WITHOUT), 'capture')
    assert.equal(captureStep(page({ written: 3, shown: 1 }), WITHOUT), 'skip')
  })

  test('a page whose chapters can\'t be read is no work to take', () => {
    assert.equal(captureStep(page({ written: 0, shown: 0 }), WITHOUT), 'skip')
  })

  test('without comments wanted, the comments don\'t matter', () => {
    assert.equal(captureStep(page({ comments: 12 }), WITHOUT), 'capture')
  })

  test('with comments wanted, a work with none needs none shown', () => {
    assert.equal(captureStep(page(), WITH), 'capture')
  })

  test('with comments wanted, any shown will do, however many the work has', () => {
    assert.equal(captureStep(page({ comments: 40, commentsShown: 1, commentsAsked: true }), WITH), 'capture')
  })

  test('comments the page never asked for will never come', () => {
    assert.equal(captureStep(page({ comments: 2 }), WITH), 'skip')
  })

  test('comments asked for and not here yet are waited for, a few times, then given up on', () => {
    const asked = page({ comments: 2, commentsAsked: true })
    for (let attempt = 0; attempt < COMMENT_LOAD_RETRIES; attempt++)
      assert.equal(captureStep(asked, { comments: true, attempt }), 'wait', `attempt ${attempt}`)
    assert.equal(captureStep(asked, { comments: true, attempt: COMMENT_LOAD_RETRIES }), 'skip')
  })

  test('a partly shown work is not waited on for its comments', () => {
    assert.equal(captureStep(page({ written: 3, shown: 1, comments: 2, commentsAsked: true }), WITH), 'skip')
  })
})

describe('pageFreshness', () => {
  const DAY = 24 * 60 * 60
  const MIDNIGHT = 20_000 * DAY
  const fromPage = { workId: '1', dateUpdated: MIDNIGHT, chapters: 3, words: 5000 }

  test('a stored blurb of the same day lends its time to the second', () => {
    assert.deepEqual(pageFreshness(fromPage, MIDNIGHT + 3600), { ...fromPage, dateUpdated: MIDNIGHT + 3600 })
  })

  test('a stored blurb of another day, or none, leaves the page\'s day', () => {
    assert.deepEqual(pageFreshness(fromPage, MIDNIGHT - 3600), fromPage)
    assert.deepEqual(pageFreshness(fromPage, MIDNIGHT + DAY), fromPage)
    assert.deepEqual(pageFreshness(fromPage, undefined), fromPage)
  })

  test('a page with no date takes nothing from the blurb', () => {
    assert.deepEqual(pageFreshness({ ...fromPage, dateUpdated: 0 }, 3600), { ...fromPage, dateUpdated: 0 })
  })
})
