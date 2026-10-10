import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SYNC_CONSISTENCY_WAIT_MS } from '../../src/common/constants.ts'
import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { encode, MANIFEST_KEY, SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { answerRefusal, checkCopy, foundOf, nextInconsistency, ownCopyReplaces, ownCopyWhole, recheckIn } from '../../src/common/syncConsistency.ts'
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

/** The upload `itemsOf` writes by default: its manifest's generation and writer token. */
const UPLOAD = { g: 4, w: 'laptop.1' }
const MANIFEST = { v: V, n: 1, g: 4, h: 'H', w: 'laptop.1', i: 'laptop-copy' }

/** What a read found: a partial copy of `upload`, a whole copy, or none at this version. */
const partial = (upload = UPLOAD) => ({ read: 'partial', upload })
const WHOLE = { read: 'whole' }
const NONE = { read: 'none' }

describe('foundOf', () => {
  test('a copy that decodes is whole; one with a part missing or not matching the rest is partial, of the upload its manifest names; no copy, or one at another version, is none', () => {
    assert.deepEqual(foundOf({ ok: true, options: {} }, MANIFEST), WHOLE)
    assert.deepEqual(foundOf({ ok: false, reason: 'incomplete' }, MANIFEST), partial())
    assert.deepEqual(foundOf({ ok: false, reason: 'corrupt' }, MANIFEST), partial())
    assert.deepEqual(foundOf({ ok: false, reason: 'empty' }, undefined), NONE)
    assert.deepEqual(foundOf({ ok: false, reason: 'version' }, MANIFEST), NONE)
  })
})

describe('checkCopy', () => {
  test('a copy at this sync version that decodes is whole, with what it holds', async () => {
    const check = await checkCopy(await itemsOf(), V)
    assert.equal(check.read, 'whole')
    assert.equal(check.options.wordsPerMinute, 320)
    assert.equal(check.options.rules.filters.length, 5)
  })

  test('a part its manifest names is missing: partial, of the upload the manifest names', async () => {
    const items = await itemsOf()
    delete items.o0
    assert.deepEqual(await checkCopy(items, V), partial())
  })

  test('a manifest naming more parts than are there: partial', async () => {
    const items = await itemsOf()
    items[MANIFEST_KEY] = { ...items[MANIFEST_KEY], n: 2 }
    assert.deepEqual(await checkCopy(items, V), partial())
  })

  test('a part from another upload, which doesn\'t match the manifest: partial, of the manifest\'s upload', async () => {
    const items = await itemsOf()
    const other = await itemsOf({ ...SETTINGS, wordsPerMinute: 250 }, { g: 3, token: 'desktop.1' })
    assert.deepEqual(await checkCopy({ ...items, o0: other.o0 }, V), partial())
  })

  test('no copy, or a copy at an older or a newer sync version, whole or not, is none: there is nothing at this version to check', async () => {
    assert.deepEqual(await checkCopy({}, V), NONE)
    for (const version of [V - 1, V + 1]) {
      const items = await itemsOf(SETTINGS, { version })
      assert.deepEqual(await checkCopy(items, V), NONE, `whole, at ${version}`)
      delete items.o0
      assert.deepEqual(await checkCopy(items, V), NONE, `partial, at ${version}`)
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
 * The record a browser keeps of a synced copy it can't read whole: the upload
 * it belongs to, when this browser first read that upload so, whether that is
 * past the wait, and whether this browser's own settings can then replace it.
 */
describe('nextInconsistency', () => {
  /** The synced copy, partial under a newer upload's manifest. */
  const NEWER = { g: 5, w: 'desktop.1' }

  test('a partial copy first read is recorded when it was read, with its upload, and not yet past the wait', () => {
    assert.deepEqual(nextInconsistency(null, partial(), T0, true), { since: T0, overdue: false, replaceable: false, upload: UPLOAD })
  })

  test('read partial again within the wait, it keeps when it was first read', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    for (const later of [T0 + 1, T0 + WAIT / 2, T0 + WAIT - 1])
      assert.deepEqual(nextInconsistency(first, partial(), later, true), first, `${later - T0} ms on`)
  })

  test('still partial once the wait is up, it is overdue, and replaceable where this browser\'s own settings pass the check', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    assert.deepEqual(nextInconsistency(first, partial(), T0 + WAIT, true), { since: T0, overdue: true, replaceable: true, upload: UPLOAD })
    assert.deepEqual(nextInconsistency(first, partial(), T0 + WAIT, false), { since: T0, overdue: true, replaceable: false, upload: UPLOAD })
    const overdue = nextInconsistency(first, partial(), T0 + WAIT, true)
    assert.deepEqual(nextInconsistency(overdue, partial(), T0 + 3 * WAIT, true), overdue, 'read again later, the same')
  })

  /** A newer upload that starts arriving late in another's wait has a wait of its own: its sender may still be sending it. */
  test('partial under another upload\'s manifest, the wait starts over from then, past the first upload\'s wait or not', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    const overdue = nextInconsistency(first, partial(), T0 + WAIT, true)
    for (const [record, at] of [[first, T0 + WAIT - 1], [overdue, T0 + 2 * WAIT]])
      assert.deepEqual(nextInconsistency(record, partial(NEWER), at, true), { since: at, overdue: false, replaceable: false, upload: NEWER })
    const restarted = nextInconsistency(first, partial(NEWER), T0 + WAIT / 2, true)
    assert.equal(nextInconsistency(restarted, partial(NEWER), T0 + WAIT, true).overdue, false, 'not past at the first upload\'s wait')
    assert.equal(nextInconsistency(restarted, partial(NEWER), T0 + WAIT / 2 + WAIT, true).overdue, true, 'past at its own')
  })

  test('an upload is told apart by the manifest\'s generation and writer token together', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    for (const upload of [{ ...UPLOAD, g: 5 }, { ...UPLOAD, w: 'laptop.2' }])
      assert.equal(nextInconsistency(first, partial(upload), T0 + WAIT / 2, true).since, T0 + WAIT / 2, JSON.stringify(upload))
  })

  test('a record with no upload, kept by a build from before it was recorded, is waited on afresh', () => {
    const { upload, ...older } = nextInconsistency(null, partial(), T0, true)
    assert.deepEqual(nextInconsistency(older, partial(), T0 + WAIT / 2, true), { since: T0 + WAIT / 2, overdue: false, replaceable: false, upload })
  })

  test('a whole copy, or none at this version, clears it, whether or not the wait is up', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    const overdue = nextInconsistency(first, partial(), T0 + WAIT, true)
    for (const record of [null, first, overdue]) {
      assert.equal(nextInconsistency(record, WHOLE, T0 + WAIT, true), null)
      assert.equal(nextInconsistency(record, NONE, T0 + WAIT, true), null)
    }
  })

  test('partial again after a whole copy, the wait starts over', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    const cleared = nextInconsistency(first, WHOLE, T0 + WAIT / 2, true)
    assert.deepEqual(nextInconsistency(cleared, partial(), T0 + WAIT, true), { since: T0 + WAIT, overdue: false, replaceable: false, upload: UPLOAD })
  })
})

describe('recheckIn', () => {
  test('how long until the wait is up, from when the copy was first read partial', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    assert.equal(recheckIn(first, T0), WAIT)
    assert.equal(recheckIn(first, T0 + WAIT / 4), WAIT - WAIT / 4)
    assert.equal(recheckIn(first, T0 + 2 * WAIT), 0, 'already up: at once')
  })

  test('nothing to wait for with no record, or one already past the wait', () => {
    assert.equal(recheckIn(null, T0), null)
    assert.equal(recheckIn(nextInconsistency(nextInconsistency(null, partial(), T0, true), partial(), T0 + WAIT, true), T0 + WAIT), null)
  })
})

describe('answerRefusal', () => {
  test('within the wait another browser is taken to be still sending the copy; past it, the copy is inconsistent', () => {
    const first = nextInconsistency(null, partial(), T0, true)
    assert.equal(answerRefusal(first), 'sending')
    assert.equal(answerRefusal(nextInconsistency(first, partial(), T0 + WAIT, true)), 'inconsistent')
  })
})
