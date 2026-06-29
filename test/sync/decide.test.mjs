import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { SYNC_SCHEMA_VERSION } from '../../src/common/syncCodec.ts'
import { decidePull, decidePush, isRemoteNewer } from '../../src/common/syncDecide.ts'

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

  test('noop on a newer on-the-wire schema (this device is behind)', () => {
    assert.equal(decidePush(local, m({ g: 9, v: V + 1 }), 'Hchanged'), 'noop')
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

  test('noop on a newer on-the-wire schema we cannot decode', () => {
    assert.equal(decidePull(local, m({ g: 9, v: V + 1 })), 'noop')
  })
})
