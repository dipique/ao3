import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// syncCodec.ts is browser-free (only `import type` + @antfu/utils), so it loads
// directly under Node's TS type-stripping — no build, no DOM.
import {
  buildLocalUpdate,
  canonicalStringify,
  CHUNK_SIZE,
  decode,
  diffChunks,
  encode,
  hash,
  MANIFEST_KEY,
  pruneToSynced,
  SYNC_SCHEMA_VERSION,
  syncedKeys,
} from '../../src/common/syncCodec.ts'

const defaults = {
  showTotalTime: true,
  wordsPerMinute: 200,
  rules: { enabled: false, filters: [], colors: {} },
  textReplacements: { enabled: false, rules: [] },
  theme: { chosen: 'inherit', current: 'light' },
  user: {},
  verbose: false,
  big: [],
}

const options = {
  ...defaults,
  wordsPerMinute: 300,
  rules: { enabled: true, filters: [{ target: 'tag', value: 'x', matcher: 'exact' }], colors: {} },
  theme: { chosen: 'dark', current: 'dark' },
  user: { userId: 'me' },
  verbose: true,
}

/** Deterministic PRNG so the "large payload" test is reproducible. */
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function asItems({ chunks, manifest }) {
  return { ...chunks, [MANIFEST_KEY]: manifest }
}

describe('pruneToSynced', () => {
  test('drops defaults, local-only keys, and theme.current', () => {
    const pruned = pruneToSynced(options, defaults)
    assert.deepEqual(pruned, {
      wordsPerMinute: 300,
      rules: { enabled: true, filters: [{ target: 'tag', value: 'x', matcher: 'exact' }], colors: {} },
      theme: { chosen: 'dark' },
    })
    assert.equal('showTotalTime' in pruned, false, 'default-valued key dropped')
    assert.equal('user' in pruned, false, 'user is local-only')
    assert.equal('verbose' in pruned, false, 'verbose is local-only')
    assert.equal('current' in pruned.theme, false, 'theme.current never synced')
  })

  test('empty when options equal defaults', () => {
    assert.deepEqual(pruneToSynced(defaults, defaults), {})
  })
})

describe('buildLocalUpdate', () => {
  test('round-trips with pruneToSynced (preserving local-only fields)', () => {
    const rebuilt = buildLocalUpdate(pruneToSynced(options, defaults), defaults, options)
    assert.deepEqual(rebuilt, options)
  })

  test('resets keys absent from the payload back to default', () => {
    // The writer knew every key, so "absent" really does mean "equals default".
    const rebuilt = buildLocalUpdate({}, defaults, options, syncedKeys(defaults))
    assert.equal(rebuilt.wordsPerMinute, 200, 'absent synced key -> default')
    assert.deepEqual(rebuilt.rules, defaults.rules)
    assert.deepEqual(rebuilt.theme, { chosen: 'inherit', current: 'dark' }, 'chosen reset, current kept')
    assert.deepEqual(rebuilt.user, { userId: 'me' }, 'user preserved from existing')
    assert.equal(rebuilt.verbose, true, 'verbose preserved from existing')
  })

  test('keeps options the writing device never heard of', () => {
    // A device on an older build: it prunes against defaults that lack the newer
    // keys, so they're missing from its payload for a reason that has nothing to
    // do with their value. Resetting them here wiped real data.
    const older = syncedKeys(defaults).filter(k => k !== 'rules' && k !== 'textReplacements')
    const rebuilt = buildLocalUpdate({ wordsPerMinute: 300 }, defaults, options, older)
    assert.deepEqual(rebuilt.rules, options.rules, 'unknown-to-writer key kept as-is')
    assert.equal(rebuilt.showTotalTime, true, 'known key absent from payload -> default')
  })

  test('without a key list, absent keys are left alone', () => {
    // Payloads written before the manifest carried `k`: the two cases are
    // indistinguishable, so prefer a stale setting over destroying data.
    const rebuilt = buildLocalUpdate({}, defaults, options)
    assert.deepEqual(rebuilt.rules, options.rules)
    assert.equal(rebuilt.wordsPerMinute, 300)
    assert.deepEqual(rebuilt.user, { userId: 'me' }, 'local-only still from this device')
    assert.deepEqual(rebuilt.theme, { chosen: 'inherit', current: 'dark' })
  })

  test('an older build syncing cannot wipe a newer build\'s data', () => {
    // End-to-end reproduction of the reported bug: a feature holding real data
    // (a list, plus the switch that enables it) survives the older device's push.
    const withData = { ...options, marks: { enabled: true, read: 'a,b,c' } }
    const newDefaults = { ...defaults, marks: { enabled: false, read: '' } }
    const oldDefaults = { ...defaults }
    const oldState = { ...oldDefaults, wordsPerMinute: 300 }

    const pushed = pruneToSynced(oldState, oldDefaults)
    assert.equal('marks' in pushed, false, 'the old build cannot push a key it lacks')

    const rebuilt = buildLocalUpdate(pushed, newDefaults, withData, syncedKeys(oldDefaults))
    assert.deepEqual(rebuilt.marks, withData.marks, 'data survives the pull')
  })
})

describe('canonicalStringify + hash', () => {
  test('key order does not affect the canonical string or hash', () => {
    const a = { b: 2, a: 1, nested: { y: [3, { q: 1, p: 2 }], x: 0 } }
    const b = { a: 1, nested: { x: 0, y: [3, { p: 2, q: 1 }] }, b: 2 }
    assert.equal(canonicalStringify(a), canonicalStringify(b))
    assert.equal(hash(canonicalStringify(a)), hash(canonicalStringify(b)))
  })

  test('array order DOES matter (ordered data)', () => {
    assert.notEqual(canonicalStringify([1, 2]), canonicalStringify([2, 1]))
  })
})

describe('encode/decode round-trip', () => {
  test('encodes and decodes back to the pruned payload', async () => {
    const encoded = await encode(options, defaults, 5, 'tok-1')
    assert.equal(encoded.manifest.v, SYNC_SCHEMA_VERSION)
    assert.equal(encoded.manifest.g, 5)
    assert.equal(encoded.manifest.w, 'tok-1')
    assert.ok(encoded.manifest.n >= 1)

    const result = await decode(asItems(encoded))
    assert.equal(result.ok, true)
    assert.deepEqual(result.options, pruneToSynced(options, defaults))
  })

  test('large payloads split into multiple chunks, each within the item limit', async () => {
    const rand = mulberry32(42)
    const big = Array.from({ length: 1500 }, () => ({
      find: rand().toString(36).slice(2),
      replace: rand().toString(36).slice(2),
    }))
    const encoded = await encode({ ...options, big }, defaults, 1, 'w')
    assert.ok(encoded.manifest.n > 1, `expected multiple chunks, got ${encoded.manifest.n}`)
    for (const [k, v] of Object.entries(encoded.chunks))
      assert.ok(v.length <= CHUNK_SIZE, `chunk ${k} exceeds CHUNK_SIZE`)

    const result = await decode(asItems(encoded))
    assert.equal(result.ok, true)
    assert.deepEqual(result.options.big, big)
  })
})

describe('decode failure modes', () => {
  test('empty when no manifest present', async () => {
    assert.deepEqual(await decode({}), { ok: false, reason: 'empty' })
  })

  test('version when manifest schema is newer than us', async () => {
    const encoded = await encode(options, defaults, 1, 'w')
    encoded.manifest.v = SYNC_SCHEMA_VERSION + 1
    assert.deepEqual(await decode(asItems(encoded)), { ok: false, reason: 'version' })
  })

  test('incomplete when a chunk is missing (mid-propagation)', async () => {
    const rand = mulberry32(7)
    const big = Array.from({ length: 1500 }, () => ({ find: rand().toString(36).slice(2) }))
    const encoded = await encode({ ...options, big }, defaults, 1, 'w')
    const items = asItems(encoded)
    delete items.o0
    assert.deepEqual(await decode(items), { ok: false, reason: 'incomplete' })
  })

  test('corrupt when a chunk is tampered', async () => {
    const encoded = await encode(options, defaults, 1, 'w')
    const items = asItems(encoded)
    // Tamper the START of the stream (trailing base64 can fall past the deflate
    // stream's end and be ignored by the decompressor).
    items.o0 = `ZZ${items.o0.slice(2)}`
    assert.deepEqual(await decode(items), { ok: false, reason: 'corrupt' })
  })
})

describe('diffChunks', () => {
  test('detects changed chunks', () => {
    assert.deepEqual(
      diffChunks({ o0: 'a', o1: 'b' }, { o0: 'a', o1: 'c' }),
      { toSet: { o1: 'c' }, toRemove: [] },
    )
  })

  test('removes orphan chunks when the count shrinks', () => {
    assert.deepEqual(
      diffChunks({ o0: 'a', o1: 'b', o2: 'c' }, { o0: 'a', o1: 'b' }),
      { toSet: {}, toRemove: ['o2'] },
    )
  })

  test('adds new chunks when the count grows', () => {
    assert.deepEqual(
      diffChunks({ o0: 'a' }, { o0: 'a', o1: 'b' }),
      { toSet: { o1: 'b' }, toRemove: [] },
    )
  })
})
