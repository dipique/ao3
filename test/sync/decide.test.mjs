import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPTION_DEFAULTS } from '../../src/common/optionDefaults.ts'
import { pruneToSynced, SYNC_SCHEMA_VERSION, syncedKeys } from '../../src/common/syncCodec.ts'
import { decideFirstPull, decidePull, decidePush, isRemoteNewer } from '../../src/common/syncDecide.ts'
import { rulesFixture, textReplacementsFixture } from './harness.mjs'

const V = SYNC_SCHEMA_VERSION

/** Build a manifest with sensible defaults. */
function m({ g = 1, h = 'H', w = 'wA', v = V, n = 1 } = {}) {
  return { v, n, g, h, w }
}

describe('isRemoteNewer', () => {
  test('higher generation is newer', () => {
    assert.equal(isRemoteNewer(m({ g: 2 }), { g: 1, h: 'x', w: 'wA' }), true)
    assert.equal(isRemoteNewer(m({ g: 1 }), { g: 2, h: 'x', w: 'wA' }), false)
  })

  test('same generation, different token resolves by token (deterministic)', () => {
    assert.equal(isRemoteNewer(m({ g: 1, w: 'wB' }), { g: 1, h: 'x', w: 'wA' }), true)
    assert.equal(isRemoteNewer(m({ g: 1, w: 'wA' }), { g: 1, h: 'x', w: 'wB' }), false)
  })

  test('same generation and token is not newer', () => {
    assert.equal(isRemoteNewer(m({ g: 1, w: 'wA' }), { g: 1, h: 'x', w: 'wA' }), false)
  })
})

describe('decidePush', () => {
  const local = { g: 5, h: 'Hlocal', w: 'wA' }

  test('seeds when sync is empty and we have local state', () => {
    assert.equal(decidePush({ g: 0, h: '', w: '' }, null, 'Hnew'), 'push')
  })

  test('noop when nothing changed and we are in sync', () => {
    assert.equal(decidePush(local, m({ g: 5, w: 'wA' }), 'Hlocal'), 'noop')
  })

  test('pushes our local changes when the cloud has not advanced', () => {
    assert.equal(decidePush(local, m({ g: 5, w: 'wA' }), 'Hchanged'), 'push')
  })

  test('pulls instead of clobbering when the cloud advanced under us (offline divergence)', () => {
    // We edited offline (Hchanged) but another device already pushed g=6.
    assert.equal(decidePush(local, m({ g: 6, w: 'wB' }), 'Hchanged'), 'pull')
  })

  test('pulls when no local changes but cloud is newer', () => {
    assert.equal(decidePush(local, m({ g: 6, w: 'wB' }), 'Hlocal'), 'pull')
  })

  test('blocked by a newer sync version (this browser is behind)', () => {
    assert.equal(decidePush(local, m({ g: 9, v: V + 1 }), 'Hchanged'), 'blocked')
    assert.equal(decidePush(local, m({ g: 9, v: V + 1 }), 'Hlocal'), 'blocked', 'even with nothing to push')
  })

  test('an older build\'s copy is replaced by a browser that has synced before', () => {
    // Whatever its generation, and whether or not anything changed here.
    assert.equal(decidePush(local, m({ g: 50, v: V - 1 }), 'Hlocal'), 'push')
    assert.equal(decidePush(local, m({ g: 2, v: V - 1 }), 'Hchanged'), 'push')
  })

  test('a browser that has never synced waits instead of replacing an older build\'s copy', () => {
    assert.equal(decidePush({ g: 0, h: '', w: '' }, m({ g: 5, v: V - 1 }), 'Hnew'), 'wait')
  })

  test('the version compared against is the one passed in', () => {
    assert.equal(decidePush(local, m({ g: 5, w: 'wA', v: 3 }), 'Hchanged', 3), 'push')
    assert.equal(decidePush(local, m({ g: 5, w: 'wA', v: 3 }), 'Hchanged', 2), 'blocked')
  })

  test('lost same-gen race resolves to pull', () => {
    // We think we are at g=6/wA, but the cloud shows g=6/wB (a competitor won).
    assert.equal(decidePush({ g: 6, h: 'Hmine', w: 'wA' }, m({ g: 6, w: 'wB' }), 'Hmine'), 'pull')
  })
})

describe('decidePull', () => {
  const local = { g: 5, h: 'H', w: 'wA' }

  test('noop when sync is empty', () => {
    assert.equal(decidePull(local, null), 'noop')
  })

  test('noop on our own echo (same gen + token)', () => {
    assert.equal(decidePull(local, m({ g: 5, w: 'wA' })), 'noop')
  })

  test('noop on an older/equal generation', () => {
    assert.equal(decidePull(local, m({ g: 4, w: 'wB' })), 'noop')
  })

  test('pulls a newer generation', () => {
    assert.equal(decidePull(local, m({ g: 6, w: 'wB' })), 'pull')
  })

  test('pulls a same-gen overwrite that won the tie-break', () => {
    assert.equal(decidePull(local, m({ g: 5, w: 'wB' })), 'pull')
  })

  test('blocked by a newer sync version', () => {
    assert.equal(decidePull(local, m({ g: 9, v: V + 1 })), 'blocked')
  })

  test('never adopts an older build\'s copy, however new', () => {
    assert.equal(decidePull(local, m({ g: 9, v: V - 1 })), 'wait')
    assert.equal(decidePull({ g: 0, h: '', w: '' }, m({ g: 1, v: V - 1 })), 'wait')
  })
})

/**
 * The first pull a browser makes with nothing agreed, as sync is turned on:
 * whether the synced copy is adopted, this browser's settings are sent over
 * it, the two already agree, or the reader is asked which to keep.
 */
describe('decideFirstPull', () => {
  /** A browser's options: the defaults, with `update` over them. */
  const withOptions = (update = {}) => ({ ...structuredClone(OPTION_DEFAULTS), ...structuredClone(update) })
  /** The synced copy a browser holding `update` writes. */
  const copyOf = (update = {}) => pruneToSynced(withOptions(update), OPTION_DEFAULTS)
  const KEYS = syncedKeys(OPTION_DEFAULTS)
  const decide = (here, copy, keys = KEYS) => decideFirstPull(withOptions(here), copy, OPTION_DEFAULTS, keys)

  const MINE = { rules: rulesFixture(40), wordsPerMinute: 350 }
  const THEIRS = { rules: rulesFixture(38), textReplacements: textReplacementsFixture(3) }

  test('a copy holding nothing beyond defaults: this browser\'s settings are sent', () => {
    assert.deepEqual(decide(MINE, copyOf()), { kind: 'send' })
  })

  test('a new profile adopts the copy', () => {
    assert.deepEqual(decide({}, copyOf(THEIRS)), { kind: 'adopt' })
  })

  test('both holding nothing beyond defaults agree, with nothing to send', () => {
    assert.deepEqual(decide({}, copyOf()), { kind: 'agree' })
  })

  test('a matching copy agrees', () => {
    assert.deepEqual(decide(MINE, copyOf(MINE)), { kind: 'agree' })
  })

  test('a copy that differs from this browser\'s own settings asks', () => {
    assert.deepEqual(decide(MINE, copyOf(THEIRS)), { kind: 'ask', loss: null })
    assert.deepEqual(decide(MINE, copyOf({ ...MINE, wordsPerMinute: 351 })), { kind: 'ask', loss: null }, 'however small the difference')
  })

  test('a copy the deletion guard would hold asks, saying what using it would remove', () => {
    const { kind, loss } = decide(MINE, copyOf({ rules: rulesFixture(1) }))
    assert.equal(kind, 'ask')
    assert.deepEqual(loss.rules, { removed: 39, of: 40 })
  })

  test('device-local settings are not this browser\'s settings to send or lose', () => {
    const local = { theme: { chosen: 'inherit', current: 'dark' }, user: { userId: 'reader' }, verbose: true, savedLists: { v: 1, lists: { a: { id: 'a', kind: 'tag-works', url: '/tags/Tea', title: 'Tea' } } } }
    assert.deepEqual(decide(local, copyOf(THEIRS)), { kind: 'adopt' })
    assert.deepEqual(decide({ ...local, ...THEIRS }, copyOf(THEIRS)), { kind: 'agree' })
  })

  describe('a writer that knew fewer options', () => {
    const narrower = KEYS.filter(key => key !== 'wordsPerMinute')

    test('what it never knew of is no difference', () => {
      assert.deepEqual(decide(MINE, copyOf({ rules: MINE.rules }), narrower), { kind: 'agree' })
      assert.deepEqual(decide(MINE, copyOf({ rules: MINE.rules }), KEYS), { kind: 'ask', loss: null }, 'a writer that knew it left it at its default')
    })

    test('a copy holding nothing beyond defaults still takes this browser\'s settings', () => {
      assert.deepEqual(decide({ wordsPerMinute: 350 }, copyOf(), narrower), { kind: 'send' })
    })
  })
})
