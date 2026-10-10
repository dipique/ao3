import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SYNC_CONSISTENCY_WAIT_MS } from '../../src/common/constants.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { encode, MANIFEST_KEY, SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { checkCopy, keepRefusal, nextInconsistency, ownCopyReplaces, ownCopyWhole, readOf, recheckIn } from '../../src/common/syncConsistency.ts'
import { rulesFixture } from './harness.mjs'

const V = SYNC_SCHEMA_VERSION
const WAIT = SYNC_CONSISTENCY_WAIT_MS
const T0 = new Date(2026, 9, 9, 12).getTime()

/** A reader's settings, and the synced items a browser holding them writes. */
const SETTINGS = { ...structuredClone(OPTION_DEFAULTS), rules: rulesFixture(5), wordsPerMinute: 320 }
async function itemsOf(settings = SETTINGS, { g = 4, token = 'laptop.1', version = V, id = 'laptop-copy' } = {}) {
  const { chunks, manifest } = await encode(settings, OPTION_DEFAULTS, g, token, version, id)
  return { ...chunks, [MANIFEST_KEY]: manifest }
}

describe('readOf', () => {
  test('a copy that decodes is whole; one with a part missing or not matching the rest is partial; no copy, or one at another version, is none', () => {
    assert.equal(readOf({ ok: true, options: {} }), 'whole')
    assert.equal(readOf({ ok: false, reason: 'incomplete' }), 'partial')
    assert.equal(readOf({ ok: false, reason: 'corrupt' }), 'partial')
    assert.equal(readOf({ ok: false, reason: 'empty' }), 'none')
    assert.equal(readOf({ ok: false, reason: 'version' }), 'none')
  })
})

describe('checkCopy', () => {
  test('a copy at this sync version that decodes is whole, with what it holds', async () => {
    const check = await checkCopy(await itemsOf(), V)
    assert.equal(check.read, 'whole')
    assert.equal(check.options.wordsPerMinute, 320)
    assert.equal(check.options.rules.filters.length, 5)
  })

  test('a part its manifest names is missing: partial', async () => {
    const items = await itemsOf()
    delete items.o0
    assert.deepEqual(await checkCopy(items, V), { read: 'partial' })
  })

  test('a manifest naming more parts than are there: partial', async () => {
    const items = await itemsOf()
    items[MANIFEST_KEY] = { ...items[MANIFEST_KEY], n: 2 }
    assert.deepEqual(await checkCopy(items, V), { read: 'partial' })
  })

  test('a part from another upload, which doesn\'t match the manifest: partial', async () => {
    const items = await itemsOf()
    const other = await itemsOf({ ...SETTINGS, wordsPerMinute: 250 }, { g: 3, token: 'desktop.1' })
    assert.deepEqual(await checkCopy({ ...items, o0: other.o0 }, V), { read: 'partial' })
  })

  test('no copy, or a copy at an older or a newer sync version, whole or not, is none: there is nothing at this version to check', async () => {
    assert.deepEqual(await checkCopy({}, V), { read: 'none' })
    for (const version of [V - 1, V + 1]) {
      const items = await itemsOf(SETTINGS, { version })
      assert.deepEqual(await checkCopy(items, V), { read: 'none' }, `whole, at ${version}`)
      delete items.o0
      assert.deepEqual(await checkCopy(items, V), { read: 'none' }, `partial, at ${version}`)
    }
  })
})

describe('ownCopyWhole', () => {
  test('this browser\'s settings, as an upload would write them, pass the same check', async () => {
    assert.equal(await ownCopyWhole(SETTINGS, OPTION_DEFAULTS, V), true)
    assert.equal(await ownCopyWhole(structuredClone(OPTION_DEFAULTS), OPTION_DEFAULTS, V), true, 'at their defaults too')
  })

  test('settings that can\'t be written as a synced copy don\'t', async () => {
    assert.equal(await ownCopyWhole({ ...SETTINGS, wordsPerMinute: 320n }, OPTION_DEFAULTS, V), false)
  })
})

/**
 * A replacement holding nothing beyond defaults asks no other browser
 * anything: each one holding settings of its own sends them over it, all at
 * about once, and whichever lands last reaches the rest as an ordinary update.
 */
describe('ownCopyReplaces', () => {
  test('settings of this browser\'s own that pass the check can replace the synced copy', async () => {
    assert.equal(await ownCopyReplaces(SETTINGS, OPTION_DEFAULTS, V), true)
  })

  test('settings holding nothing beyond defaults can\'t, device-local ones aside', async () => {
    assert.equal(await ownCopyReplaces(structuredClone(OPTION_DEFAULTS), OPTION_DEFAULTS, V), false)
    const deviceLocal = { ...structuredClone(OPTION_DEFAULTS), verbose: !OPTION_DEFAULTS.verbose, theme: { ...OPTION_DEFAULTS.theme, current: 'dark' } }
    assert.equal(await ownCopyReplaces(deviceLocal, OPTION_DEFAULTS, V), false)
  })

  test('settings that can\'t be written as a synced copy can\'t', async () => {
    assert.equal(await ownCopyReplaces({ ...SETTINGS, wordsPerMinute: 320n }, OPTION_DEFAULTS, V), false)
  })
})

/**
 * The record a browser keeps of a synced copy it can't read whole: when it
 * first read it so, whether that is past the wait, and whether this browser's
 * own settings can then replace it.
 */
describe('nextInconsistency', () => {
  test('a partial copy first read is recorded when it was read, and not yet past the wait', () => {
    assert.deepEqual(nextInconsistency(null, 'partial', T0, true), { since: T0, overdue: false, replaceable: false })
  })

  test('read partial again within the wait, it keeps when it was first read', () => {
    const first = nextInconsistency(null, 'partial', T0, true)
    for (const later of [T0 + 1, T0 + WAIT / 2, T0 + WAIT - 1])
      assert.deepEqual(nextInconsistency(first, 'partial', later, true), first, `${later - T0} ms on`)
  })

  test('still partial once the wait is up, it is overdue, and replaceable where this browser\'s own settings pass the check', () => {
    const first = nextInconsistency(null, 'partial', T0, true)
    assert.deepEqual(nextInconsistency(first, 'partial', T0 + WAIT, true), { since: T0, overdue: true, replaceable: true })
    assert.deepEqual(nextInconsistency(first, 'partial', T0 + WAIT, false), { since: T0, overdue: true, replaceable: false })
    const overdue = nextInconsistency(first, 'partial', T0 + WAIT, true)
    assert.deepEqual(nextInconsistency(overdue, 'partial', T0 + 3 * WAIT, true), overdue, 'read again later, the same')
  })

  test('a whole copy, or none at this version, clears it, whether or not the wait is up', () => {
    const first = nextInconsistency(null, 'partial', T0, true)
    const overdue = nextInconsistency(first, 'partial', T0 + WAIT, true)
    for (const record of [null, first, overdue]) {
      assert.equal(nextInconsistency(record, 'whole', T0 + WAIT, true), null)
      assert.equal(nextInconsistency(record, 'none', T0 + WAIT, true), null)
    }
  })

  test('partial again after a whole copy, the wait starts over', () => {
    const first = nextInconsistency(null, 'partial', T0, true)
    const cleared = nextInconsistency(first, 'whole', T0 + WAIT / 2, true)
    assert.deepEqual(nextInconsistency(cleared, 'partial', T0 + WAIT, true), { since: T0 + WAIT, overdue: false, replaceable: false })
  })
})

describe('recheckIn', () => {
  test('how long until the wait is up, from when the copy was first read partial', () => {
    const first = nextInconsistency(null, 'partial', T0, true)
    assert.equal(recheckIn(first, T0), WAIT)
    assert.equal(recheckIn(first, T0 + WAIT / 4), WAIT - WAIT / 4)
    assert.equal(recheckIn(first, T0 + 2 * WAIT), 0, 'already up: at once')
  })

  test('nothing to wait for with no record, or one already past the wait', () => {
    assert.equal(recheckIn(null, T0), null)
    assert.equal(recheckIn(nextInconsistency(nextInconsistency(null, 'partial', T0, true), 'partial', T0 + WAIT, true), T0 + WAIT), null)
  })
})

describe('keepRefusal', () => {
  test('within the wait another browser is taken to be still sending the copy; past it, the copy is inconsistent', () => {
    const first = nextInconsistency(null, 'partial', T0, true)
    assert.equal(keepRefusal(first), 'sending')
    assert.equal(keepRefusal(nextInconsistency(first, 'partial', T0 + WAIT, true)), 'inconsistent')
  })
})
