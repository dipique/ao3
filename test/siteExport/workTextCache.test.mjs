import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { installMock } from '../e2e/helpers.mjs'
import { loadModuleInPage, skipWithoutChrome } from './helpers.mjs'

/**
 * What the two deletions actually take out of storage.
 *
 * The decision behind the narrow one is pure and tested next door — see
 * `planOrphanDiscard` in {@link file://./staleness.test.mjs}. What is left is
 * the part that only exists in `storage.local`: that the index and the per-work
 * keys are put back in agreement with each other, and that a `workText.` key the
 * index never knew about goes too, since a work nothing knows about is the most
 * orphaned thing in the store.
 *
 * The module reaches nothing but `browser.storage.local`, so it bundles into a
 * blank page with the storage mock under it and needs no extension at all.
 */

const skip = skipWithoutChrome

const AT = Date.UTC(2026, 8, 7)

/** A cache entry holding text, unless `size` says otherwise. */
function meta(over = {}) {
  return { size: 1000, updatedAt: 0, chapters: 1, words: 500, fetchedAt: AT, v: 1, ...over }
}

describe('siteExport/workTextCache', { skip }, () => {
  let page
  let close

  before(async () => {
    ({ page, close } = await loadModuleInPage(
      'src/content_script/siteExport/workTextCache.ts',
      'WorkTextCache',
      { prepare: blank => blank.evaluate(installMock, {}) },
    ))
  }, { timeout: 120000 })

  after(async () => close?.())

  /** Put the store back to one index and whichever text keys the test wants. */
  const seed = (index, texts = {}) => page.evaluate(async (idx, blobs) => {
    await window.browser.storage.local.clear()
    await window.browser.storage.local.set({
      workTextIndex: idx,
      ...Object.fromEntries(Object.entries(blobs).map(([workId, html]) => [`workText.${workId}`, { html }])),
    })
    window.__writes.length = 0
  }, index, texts)

  /** Every key in the store, sorted — the only way to see a stray one. */
  const keys = () => page.evaluate(async () => Object.keys(await window.browser.storage.local.get(null)).sort())
  const index = () => page.evaluate(async () => (await window.browser.storage.local.get('workTextIndex')).workTextIndex)

  const discard = listed => page.evaluate(
    ids => window.WorkTextCache.discardOrphanedWorkText(new Set(ids)),
    listed,
  )

  test('an orphan loses its text and its index entry together', async () => {
    await seed({ 11: meta(), 12: meta({ size: 2000 }) }, { 11: '<p>eleven</p>', 12: '<p>twelve</p>' })

    const plan = await discard(['11'])
    assert.deepEqual(plan.workIds, ['12'])
    assert.deepEqual(plan.usage, { cached: 1, failed: 0, bytes: 2000 })
    assert.deepEqual(await keys(), ['workText.11', 'workTextIndex'])
    assert.deepEqual(Object.keys(await index()), ['11'], 'the work a list still holds stays whole')
  })

  /**
   * The reason this sweeps by key as well as by index: an interrupted write can
   * leave text behind that nothing accounts for, and it would otherwise be
   * unreachable by anything short of deleting the whole cache.
   */
  test('text the index never knew about is swept too', async () => {
    await seed({ 11: meta() }, { 11: '<p>eleven</p>', 99: '<p>nobody</p>' })

    const plan = await discard(['11'])
    assert.deepEqual(plan.workIds, [], 'it was never in the index to plan for')
    assert.deepEqual(await keys(), ['workText.11', 'workTextIndex'])
  })

  test('a stray key for a work a list does hold is left alone', async () => {
    await seed({ 11: meta() }, { 11: '<p>eleven</p>', 12: '<p>twelve</p>' })

    await discard(['11', '12'])
    assert.deepEqual(await keys(), ['workText.11', 'workText.12', 'workTextIndex'])
  })

  test('an entry that never held text still goes', async () => {
    await seed({ 11: meta({ size: 0, failure: 'notfound', attempts: 3 }) })

    const plan = await discard([])
    assert.deepEqual(plan.workIds, ['11'])
    assert.equal(plan.usage.cached, 0)
    assert.deepEqual(await index(), {})
  })

  test('a cache with nothing to discard is not written to at all', async () => {
    await seed({ 11: meta() }, { 11: '<p>eleven</p>' })

    const plan = await discard(['11'])
    assert.deepEqual(plan.workIds, [])
    assert.deepEqual(await page.evaluate(() => window.__writes), [], 'no index rewrite for a no-op')
  })

  /** The wide deletion, for contrast: it takes the index with it. */
  test('the purge takes every text key and the index itself', async () => {
    await seed({ 11: meta() }, { 11: '<p>eleven</p>', 99: '<p>nobody</p>' })

    const usage = await page.evaluate(() => window.WorkTextCache.purgeWorkText())
    assert.deepEqual(usage, { cached: 1, failed: 0, bytes: 1000 })
    assert.deepEqual(await keys(), [])
  })
})
